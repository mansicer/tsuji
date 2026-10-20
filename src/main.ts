// @ts-nocheck —— 从单文件页面整体搬过来的主程序,之后按功能逐步拆模块、补类型
import "./style.css";
import * as ort from "onnxruntime-web/wasm";
import { BUILTIN, SERVER_API, ASR_MODEL, MT_MODEL, CT_MODEL, VAD, BUILD, SPK_MODEL } from "./config";
import { parseGlossary, glossaryText } from "./glossary";
import { fmtClock, subtitleFile } from "./subtitle";
import { estTokens, splitByTokens } from "./tokens";
import { LineStore, mergeLegacy } from "./linestore";
import { store, storageFailed, setStorageWarn, idb, lsKV } from "./storage";
import { toBase64, CHUNK, Resampler, Agc, sigStep } from "./audio";
import { judgeSpeakers, reconcileGroupNames } from "./spk/judge";
import { SPK_SR, SPK_DIM, spkResample, spkSegments, spkFbank, spkCluster, spkNorm, spkDot, spkSmooth } from "./spk/core";
import { getUiLang, setUiLang, t, LANGS, TARGETS, srcName, tgtName, CJK } from "./i18n";
import { fetchProgress, extractPcm, splitTimed } from "./media";
import { readResponseStream, partialJsonString } from "./sse";
import { asrPrompt, keywords, glossaryForLLM } from "./prompts";
import { WEB_SEARCH_PER_CALL, asrCost, mtCost } from "./cost";
import { state, cfg, lines } from "./state";
import { $, el, flash, flashBtn, download } from "./dom";
import { initSessions, saveSessions, sget, sset, sessTemplate, newSession, useSession, refreshTemplate, migrateToSessions, fileName, renderSessions } from "./sessions";
import { initTranslate, pumpTranslate, apiHeaders, loadMemo, setMemo } from "./translate";
import { creator, openCreator, renderCreator, initCreator } from "./creator";

// ---------- 小工具 ----------
// 存储写满 / 被禁用时的提示文案(节流在 storage.ts)
setStorageWarn((kind) => flash(t(kind === "full" ? "flash.storage" : "flash.storageOff")));

function showModelHints() { $("#asrModelHint").textContent = t("asrDesc." + $("#asrModel").value); $("#mtModelHint").textContent = t("mtDesc." + $("#mtModel").value); $("#ctModelHint").textContent = t("ctDesc." + $("#ctModel").value) + (getUiLang() === "zh" ? "" : " ") + t("set.ctModelHint"); }

// 滑动条刻度:每项列出带数字的主刻度,默认值高亮;点刻度直接跳到该值
const TICKS = {
  maxGain: [1, 10, 20, 30, 40, 50], agcTarget: [2, 8, 14, 20, 25], vad: [0.05, 0.2, 0.4, 0.6, 0.9],
  silence: [200, 600, 1000, 1500, 2000], maxTurn: [3, 8, 15, 20, 25, 30], prefix: [0, 300, 500, 750, 1000], tgtSize: [16, 24, 32, 40],
};
const TICK_DEF = { tgtSize: 24 }; // 不在收音设置里的滑动条的默认值
function buildTicks() {
  for (const [id, marks] of Object.entries(TICKS)) {
    const r = $("#" + id), min = Number(r.min), max = Number(r.max), def = TICK_DEF[id] ?? AUDIO_DEFAULTS[id];
    const box = el("div", { className: "ticks", ariaHidden: "true" }, ...marks.map((v) => el("span", {
      className: v === def ? "def" : "", textContent: String(v), style: `left:${((v - min) / (max - min)) * 100}%`,
      onclick: (e) => { e.preventDefault(); r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); },
    })));
    r.after(box);
    // 数值标放进标签第一行(名称右侧)
    const head = r.closest("label").querySelector("span");
    const row = el("span", { className: "rhead" }); head.replaceWith(row); row.append(head, el("output", { className: "rv", id: "rv-" + id }));
  }
}
// 每个滑动条标签右侧显示当前值(带单位),和填充色一起刷新
const RANGE_UNIT = { maxGain: "u.x", silence: "u.ms", prefix: "u.ms", maxTurn: "u.s", tgtSize: "u.px" };
function updateRangeFill() {
  document.querySelectorAll("input[type=range]").forEach((r) => {
    r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%");
    const o = document.getElementById("rv-" + r.id), v = String(Number(Number(r.value).toFixed(2)));
    if (o) { o.textContent = RANGE_UNIT[r.id] ? t(RANGE_UNIT[r.id], { v }) : v; o.classList.toggle("changed", TICKS[r.id] && Number(r.value) !== (TICK_DEF[r.id] ?? AUDIO_DEFAULTS[r.id])); }
  });
}

// ---------- 界面语言 ----------
setUiLang(store.get("uiLang", /^zh/i.test(navigator.language || "") ? "zh" : "en"));
function applyI18n() {
  document.documentElement.lang = getUiLang() === "zh" ? "zh-CN" : "en";
  document.title = t("app");
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(!SERVER_API && n.dataset.i18n === "set.keyHint" ? "set.keyHintByok" : n.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((n) => (n.placeholder = t(n.dataset.i18nPh)));
  fillLangSelects();
  document.querySelectorAll("section.sess h3").forEach((h) => (h.dataset.chip = t("set.sessChip")));
  $("#buildVer").textContent = t("set.ver", { v: BUILD });
}

function fillLangSelects() {
  document.querySelectorAll("select.srcLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(LANGS).map((c) => el("option", { value: c, textContent: srcName(c) }))); if (v) s.value = v; });
  document.querySelectorAll("select.tgtLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(TARGETS).map((c) => el("option", { value: c, textContent: tgtName(c) }))); if (v) s.value = v; });
}

// ---------- 模板 ----------
// 模板 = { id, name, source, target, description, style, asrPrompt, glossary(文本) }
// 内置模板随页面更新;改过的内置模板以同 id 存在本机,可恢复内置版本
const GENERAL = { id: "general", source: "ja", target: "zh-Hans", description: "", style: "", asrPrompt: "", glossary: "" };
function builtins() { return [...BUILTIN, { ...GENERAL, name: t("tpl.blank") }]; }
function userTemplates() { return store.json("templates", []); }
function allTemplates() {
  const user = userTemplates(), byId = new Map(user.map((x) => [x.id, x]));
  const out = builtins().map((b) => (byId.has(b.id) ? { ...b, ...byId.get(b.id), builtin: true, modified: true } : { ...b, builtin: true }));
  return out.concat(user.filter((x) => !builtins().some((b) => b.id === x.id)));
}
function getTemplate(id) { return allTemplates().find((x) => x.id === id); }
function putTemplate(tp) {
  const prev = getTemplate(tp.id), voices = tp.voices !== undefined ? tp.voices : prev && prev.voices; // 编辑模板时草稿里没有声纹库,沿用原来的
  const clean = { ...(voices && Object.keys(voices).length ? { voices } : {}), id: tp.id, name: tp.name, source: tp.source, target: tp.target, description: tp.description || "", style: tp.style || "", asrPrompt: tp.asrPrompt || "", spkNotes: tp.spkNotes || "", glossary: tp.glossary || "", updatedAt: Date.now() };
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== tp.id).concat(clean)));
  if (cfg.tpl && cfg.tpl.id === tp.id) refreshTemplate();
}
function removeTemplate(id) {
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== id)));
  if (cfg.tpl && cfg.tpl.id === id) refreshTemplate();
}
function newId() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// 收音参数默认值(和设置面板的控件 id 一一对应);和默认值相同就不落盘,以后改默认值设备会跟着变
const AUDIO_DEFAULTS = { gain: "auto", maxGain: 40, agcTarget: 14, vad: VAD, silence: 600, prefix: 300, maxTurn: 8, nr: "off", micAgc: true, micNs: false, micEc: false };
function saveAudioSettings() {
  for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id), v = e.type === "checkbox" ? String(e.checked) : e.value; sset(id, v === String(d) ? null : v); }
}
// ---------- 会话 ----------
state.sessions = store.json("sessions", []); state.curSess = null; state.sessDefaults = store.json("sessDefaults", {});

function loadSettings() {
  $("#secSpk").hidden = !isFileSess();
  $("#spkOn").checked = spkOn();
  document.body.classList.toggle("nospk", !spkOn());
  $("#uiLang").value = getUiLang();
  $("#apiKey").value = store.get("apiKey", "");
  $("#asrModel").value = sget("asrModel", ASR_MODEL);
  $("#mtModel").value = sget("mtModel", MT_MODEL);
  $("#ctModel").value = store.get("ctModel", CT_MODEL);
  $("#mtEffort").value = sget("mtEffort", "medium");
  for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id), v = sget(id, String(d)); if (e.type === "checkbox") e.checked = v === "true"; else e.value = v; }
  $("#apiBase").value = store.get("apiBase", "https://api.openai.com/v1");
  $("#showSrc").checked = sget("showSrc", "1") === "1";
  $("#tgtSize").value = sget("tgtSize", "24");
  applySettings();
}
function applySettings() {
  cfg.apiKey = $("#apiKey").value.trim();
  if (!$("#asrModel").value) $("#asrModel").value = ASR_MODEL;
  cfg.asrModel = $("#asrModel").value;
  if (!$("#mtModel").value) $("#mtModel").value = MT_MODEL; // 以前存过不在列表里的模型名
  cfg.mtModel = $("#mtModel").value;
  if (!$("#ctModel").value) $("#ctModel").value = CT_MODEL;
  cfg.ctModel = $("#ctModel").value;
  cfg.mtEffort = $("#mtEffort").value;
  cfg.gain = $("#gain").value; cfg.maxGain = Number($("#maxGain").value) || 20; cfg.agcTarget = (Number($("#agcTarget").value) || 8) / 100;
  cfg.vad = Number($("#vad").value) || 0.3; cfg.prefix = Number($("#prefix").value) || 0; cfg.nr = $("#nr").value;
  cfg.micId = store.get("micId", "");
  cfg.mic = { autoGainControl: $("#micAgc").checked, noiseSuppression: $("#micNs").checked, echoCancellation: $("#micEc").checked };
  cfg.maxTurn = Number($("#maxTurn").value) || 8;
  cfg.silence = Math.max(200, Math.min(3000, parseInt($("#silence").value, 10) || 600));
  showModelHints();
  $("#maxGainV").textContent = t("v.maxGain", { v: cfg.maxGain });
  $("#agcTargetV").textContent = t("v.agcTarget", { v: $("#agcTarget").value });
  $("#vadV").textContent = t("v.vad", { v: Number(cfg.vad.toFixed(2)) });
  $("#maxTurnV").textContent = t("v.maxTurn", { v: cfg.maxTurn });
  $("#prefixV").textContent = t("v.prefix", { v: cfg.prefix });
  $("#silenceV").textContent = t("v.silence", { v: cfg.silence });
  cfg.useServer = !cfg.apiKey && !!SERVER_API && location.protocol === "https:";
  cfg.hasKey = !!cfg.apiKey || cfg.useServer;
  cfg.apiBase = cfg.useServer ? location.origin + SERVER_API : ($("#apiBase").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  document.body.classList.toggle("hidesrc", !$("#showSrc").checked);
  document.documentElement.style.setProperty("--tgt", $("#tgtSize").value + "px");
  updateRangeFill();
  for (const id of ["apiKey", "apiBase"]) store.set(id, $("#" + id).value);
  // 和默认值相同就不落盘,之后更新页面默认值时会跟着换;会话级的项存进当前会话
  store.set("ctModel", $("#ctModel").value === CT_MODEL ? null : $("#ctModel").value);
  for (const [id, d] of [["asrModel", ASR_MODEL], ["mtModel", MT_MODEL], ["mtEffort", "medium"], ["tgtSize", "24"]]) sset(id, $("#" + id).value === d ? null : $("#" + id).value);
  saveAudioSettings();
  sset("showSrc", $("#showSrc").checked ? null : "0");
}

// ---------- 字幕列表 ----------
let follow = true;
function sessKey(ss = state.curSess) { return ss ? ss.id : "none"; }
// 会话的字幕被清空、重新处理或删除时加一。在途的翻译、防抖中的保存发现代数变了就丢弃,
// 免得旧结果按 id 写到新行上(重新处理会从 id 1 重新编号),或者把已删会话的数据写回存储
const linesGen = new Map();
function curGen(key) { return linesGen.get(key) || 0; }
function bumpGen(key) { linesGen.set(key, curGen(key) + 1); }
function showEmptyHint() {
  if (isFileSess()) return;
  if (lines.length || $("#log").children.length) return;
  $("#log").append(el("div", { className: "empty", id: "emptyHint", textContent: t(cfg.hasKey ? "live.empty" : "live.emptyKey") }));
}
function addLine(id, raw) {
  const h = $("#emptyHint"); if (h) h.remove();
  const e = el("div", { className: "row pending" }, el("div", { className: "tgt", textContent: t("line.translating") }), el("div", { className: "src", textContent: raw }));
  $("#log").append(e);
  const line = { id, raw, src: raw, tgt: "", t: new Date(), el: e, done: false };
  e.onclick = () => { if (isFileSess() && line.ms != null) seekTo(line.ms); };
  lines.push(line);
  scrollEnd();
  saveLines();
  return line;
}
// 字幕存到本地(按会话分开,见 linestore.ts):刷新、误触下拉刷新、iOS 回收标签页之后打开还在
let saveLinesTimer = null, pendingSave = null;
function saveLines() {
  clearTimeout(saveLinesTimer);
  const ss = state.curSess, key = sessKey(ss), gen = curGen(key);
  pendingSave = () => {
    pendingSave = null;
    if (curGen(key) !== gen) return;
    state.lineStore.set(key, lines.map((l) => ({ id: l.id, raw: l.raw, src: l.src, tgt: l.tgt, t: l.t.getTime(), done: l.done, ...(l.ms != null ? { s: l.ms, e: l.endMs } : {}), ...(l.spk != null ? { k: l.spk, kc: l.spc, ...(l.spkBy ? { kb: l.spkBy } : {}) } : {}) })));
    if (ss) { ss.count = lines.length; ss.updatedAt = Date.now(); saveSessions(); }
  };
  saveLinesTimer = setTimeout(pendingSave, 500);
}
/** 切换会话、关页面前:把还在防抖里的保存立刻写掉(lines 马上要被清空) */
function flushLines() { clearTimeout(saveLinesTimer); if (pendingSave) pendingSave(); }
function cancelSave() { clearTimeout(saveLinesTimer); pendingSave = null; }
function restoreLines() {
  const saved = state.lineStore.get(sessKey());
  if (!saved.length) return showEmptyHint();
  for (const s of saved) {
    const line = addLine(s.id, s.raw);
    line.src = s.src ?? s.ja ?? s.raw; line.tgt = s.tgt ?? s.zh ?? ""; line.t = new Date(s.t);
    if (s.s != null) setLineTime(line, s.s, s.e);
    if (s.k != null) { line.spk = s.k; line.spc = s.kc; if (s.kb) line.spkBy = s.kb; paintSpk(line); }
    if (s.done) { line.done = true; renderLine(line, false); }
    else { line.el.className = "row"; line.el.querySelector(".tgt").textContent = t("line.unfinished"); }
    if (line.done && line.src) history.push(line);
    state.nextId = Math.max(state.nextId, s.id);
  }
  $("#log").append(el("div", { className: "empty sep", textContent: t("line.sep", { n: saved.length }) }));
  cancelSave(); // 只是恢复显示,不算新的活动,别改会话的最后更新时间
}
// 超长的一条(几个人的话被并成一句)按句末标点分行显示,内容不变
function breakLong(s) { return s.length > (CJK.test(s) ? 40 : 90) ? s.replace(/([。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))\s*(?=\S)/g, "$1\n") : s; }
// 只有几个字的碎句(「那……」「好。」「OK.」)且紧跟上一条,就并进上一条,少占一行
const MERGE_GAP_MS = 3000;
function isShort(s) {
  const x = s.replace(/[\s。、！？!?,.，…「」『』()（）ー〜~"']/g, "");
  return CJK.test(x) ? x.length <= 4 : s.trim().split(/\s+/).filter(Boolean).length <= 2;
}
function tryMerge(line) {
  if (isFileSess()) return false; // 文件会话按说话人断句:不合并,免得把不同人的话拼成一行
  const i = lines.indexOf(line), prev = lines[i - 1];
  if (i < 1 || !prev.done || !prev.tgt || !prev.el.isConnected || prev.tgt.length > 60) return false;
  if (line.t - (prev.tEnd || prev.t) > MERGE_GAP_MS || !isShort(line.src)) return false;
  prev.src += " " + line.src; prev.tgt += " " + line.tgt; prev.raw += " " + line.raw; prev.tEnd = line.t;
  if (line.endMs != null) prev.endMs = line.endMs;
  prev.el.querySelector(".tgt").textContent = breakLong(prev.tgt);
  prev.el.querySelector(".src").textContent = breakLong(prev.src);
  line.el.remove(); lines.splice(i, 1); saveLines(); scrollEnd();
  return true;
}
function renderLine(line, merge = true) {
  line.done = true; saveLines();
  if (!line.tgt.trim()) line.tgt = "";
  if (!line.tgt && line.failed) { line.el.className = "row"; line.el.querySelector(".tgt").textContent = t("line.failed"); line.el.querySelector(".src").textContent = breakLong(line.src || line.raw); return; }
  if (!line.tgt) {
    diag.noise++; showLat();
    // 原始识别有实际内容(不只是标点/单个语气词)就别删,灰显原文
    if (/[\p{L}]{3,}/u.test(line.raw)) { line.src = line.raw; line.el.className = "row pending"; line.el.querySelector(".tgt").textContent = t("line.noise"); line.el.querySelector(".src").textContent = line.raw; return; }
    line.el.remove(); return;
  }
  if (merge && tryMerge(line)) return;
  line.el.className = "row";
  line.el.querySelector(".tgt").textContent = breakLong(line.tgt);
  line.el.querySelector(".src").textContent = breakLong(line.src);
  scrollEnd();
}
function scrollEnd() { if (follow) { const m = $("#log"); m.scrollTop = m.scrollHeight; } }
$("#log").addEventListener("scroll", () => {
  const m = $("#log");
  const atEnd = m.scrollHeight - m.scrollTop - m.clientHeight < 40;
  if (!atEnd && follow && userScrolled) setFollow(false);
});
let userScrolled = false;
$("#log").addEventListener("touchstart", () => (userScrolled = true), { passive: true });
$("#log").addEventListener("wheel", () => (userScrolled = true), { passive: true });
function setFollow(v) { follow = v; const b = $("#follow"); b.textContent = t(v ? "live.follow" : "live.unfollow"); b.classList.toggle("off", !v); if (v) { userScrolled = false; scrollEnd(); } }
$("#follow").onclick = () => setFollow(!follow);

// ---------- 翻译(OpenAI Chat Completions) ----------
const queue = [];
const history = [];

// ---------- 识别(OpenAI Realtime 转写会话,WebSocket) ----------
let reconnectTimer = null;
const partial = new Map();
// 流式模型:不支持 turn_detection,整段音频只在一个 item 里不断吐 delta,没有 completed。
// 所以客户端按句末标点切句;停顿 LIVE_IDLE_MS 没新 delta 就把剩下的也当一句,并 commit 一下让服务端开新 item。
const STREAMING_ASR = new Set(["gpt-live-transcribe", "gpt-realtime-whisper"]);
const LIVE_IDLE_MS = 2000;
let liveBuf = "", liveIdle = null, liveUncommitted = false;
function isStreamingAsr() { return STREAMING_ASR.has(cfg.asrModel); }
function sessionConfig() {
  const streaming = isStreamingAsr();
  const transcription = { model: cfg.asrModel };
  const lang = (LANGS[cfg.tpl.source] || LANGS.auto).asr;
  if (lang) transcription.language = lang;
  // 实测 gpt-transcribe:关键词 + 提示一起给最准(只给提示时节目名写成片假名,都不给时羊宮妃那听成陽空ひな)
  const kw = keywords(cfg.glossary);
  if ((cfg.asrModel === "gpt-live-transcribe" || cfg.asrModel === "gpt-transcribe") && kw.length) transcription.keywords = kw;
  const prompt = asrPrompt(cfg);
  if (cfg.asrModel !== "gpt-realtime-whisper" && prompt) transcription.prompt = prompt; // whisper 两个都不收
  return { type: "transcription", audio: { input: {
    format: { type: "audio/pcm", rate: 24000 },
    transcription,
    noise_reduction: cfg.nr === "off" ? null : { type: cfg.nr },
    turn_detection: streaming ? null : { type: "server_vad", threshold: cfg.vad, prefix_padding_ms: cfg.prefix, silence_duration_ms: cfg.silence },
  } } };
}
function emitLine(text) {
  // 只有标点/空白的碎片(比如 delta 开头单独一个「。」)丢掉
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  diag.asr++; queue.push(addLine(++state.nextId, text)); pumpTranslate(); showLat();
}
function liveDelta(delta) {
  liveBuf += delta; liveUncommitted = true;
  // 日中文只按全角句末标点断句:半角 ! ? 常出现在节目名里(EXTEND STEP HOOOOPE!);其他语言按半角句末 + 空格
  const re = ["ja", "zh"].includes(cfg.tpl.source) ? /^[\s\S]*?[。！？]+[」』）)]*/ : /^[\s\S]*?(?:[。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))/;
  let m;
  while ((m = liveBuf.match(re))) {
    emitLine(m[0].trim());
    liveBuf = liveBuf.slice(m[0].length);
  }
  liveBuf = liveBuf.replace(/^\s+/, "");
  $("#partial").textContent = liveBuf;
  clearTimeout(liveIdle);
  liveIdle = setTimeout(liveFlush, LIVE_IDLE_MS);
}
function liveFlush() {
  clearTimeout(liveIdle); liveIdle = null;
  const s = liveBuf.trim(); liveBuf = "";
  $("#partial").textContent = "";
  emitLine(s);
  // 停顿时 commit,免得一整场都堆在同一个 item 里;commit 后的 completed 文本已经按 delta 出过了,忽略
  if (liveUncommitted && state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); liveUncommitted = false; }
}
let speechSince = 0, turnEndAt = 0;
// 实时延迟显示:翻译 = 请求往返;识别 = 云端判定一句结束(或强制断句)到出识别结果,流式模型没有句末信号所以不测
const lat = { asr: 0, mt: 0, mtAvg: 0 };
const mtHist = [];
const diag = { asr: 0, noise: 0, err: 0, deltas: 0 }; // 现场排障计数
function fmtS(ms) { return ms ? t("sec", { s: (ms / 1000).toFixed(1) }) : "—"; }
function showLat() {
  const asr = isStreamingAsr() ? t("lat.stream") : fmtS(lat.asr);
  const gain = state.running && !micBroken ? agc.agcGain.toFixed(agc.agcGain < 10 ? 1 : 0) + "×" : "—";
  const item = (k, v, cls = "") => el("span", { className: "ib " + cls }, el("span", { className: "k", textContent: t(k) }), el("b", { textContent: String(v) }));
  $("#ibItems").replaceChildren(...[
    isFileSess() ? null : item("ib.gain", gain), isFileSess() ? null : item("ib.asr", asr), item("ib.mt", fmtS(lat.mt)), item("ib.avg", fmtS(lat.mtAvg)),
    queue.length ? item("ib.queue", queue.length, "warn") : null,
    item("ib.lines", diag.asr), item("ib.noise", diag.noise), item("ib.err", diag.err, diag.err ? "bad" : ""),
    item("ib.cost", "$" + cost.total().toFixed(cost.total() < 1 ? 3 : 2)),
  ].filter(Boolean));
  $("#infobar").title = t("ib.deltas", { n: diag.deltas }); $("#signal").title = t("ib.level");
  showCost();
}
// 费用估算(单价和计算见 cost.ts)
const cost = {
  asr: Number(store.get("costAsr", "0")) || 0, mt: Number(store.get("costMt", "0")) || 0,
  total() { return this.asr + this.mt; },
  save() { store.set("costAsr", String(this.asr)); store.set("costMt", String(this.mt)); },
};
let costShownAt = 0;
function showCost() {
  const usd = (v) => "$" + v.toFixed(v < 1 ? 3 : 2);
  $("#costOut").textContent = t("cost", { a: usd(cost.asr), m: usd(cost.mt), t: usd(cost.total()) });
}
function addAsrCost(seconds, model = cfg.asrModel) {
  cost.asr += asrCost(seconds, model);
  if (performance.now() - costShownAt > 1000) { costShownAt = performance.now(); cost.save(); showLat(); }
}
function addMtCost(model, u, extra = 0) {
  const usd = mtCost(model, u, extra);
  if (usd === null) return; // 没有 usage 或 ChatGPT 订阅:不计费
  cost.mt += usd;
  cost.save(); showLat();
}
setInterval(() => {
  if (!state.running || isStreamingAsr() || !speechSince || !state.ws || state.ws.readyState !== 1) return;
  if (performance.now() - speechSince > cfg.maxTurn * 1000) {
    speechSince = performance.now();
    state.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }
}, 250);
function connect() {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  setStatus("status.connecting", "warn");
  state.ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]);
  liveUncommitted = false;
  state.ws.onopen = () => { state.ws.send(JSON.stringify({ type: "session.update", session: sessionConfig() })); setStatus("status.listening", "on"); showLat(); };
  state.ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    // 强制断句:持续噪声/背景音乐下 server VAD 一直认为在说话,一句话要等很久才出
    if (m.type === "input_audio_buffer.speech_started") speechSince = performance.now();
    else if (m.type === "input_audio_buffer.speech_stopped") { speechSince = 0; turnEndAt = performance.now(); }
    else if (m.type === "input_audio_buffer.committed" && !isStreamingAsr() && !turnEndAt) turnEndAt = performance.now(); // 强制断句
    if (m.type === "conversation.item.input_audio_transcription.completed" && !isStreamingAsr() && turnEndAt) { lat.asr = performance.now() - turnEndAt; turnEndAt = 0; showLat(); }
    if (m.type === "conversation.item.input_audio_transcription.delta") { diag.deltas++; if (diag.deltas % 10 === 1) showLat(); }
    if (m.type === "conversation.item.input_audio_transcription.delta" && isStreamingAsr()) {
      liveDelta(m.delta || "");
    } else if (m.type === "conversation.item.input_audio_transcription.completed" && isStreamingAsr()) {
      // 已经按 delta 切过句了
    } else if (m.type === "conversation.item.input_audio_transcription.delta") {
      const s = (partial.get(m.item_id) || "") + (m.delta || "");
      partial.set(m.item_id, s);
      $("#partial").textContent = s;
    } else if (m.type === "conversation.item.input_audio_transcription.completed") {
      partial.delete(m.item_id);
      $("#partial").textContent = "";
      const text = (m.transcript || "").trim();
      if (text) emitLine(text);
    } else if (m.type === "error") {
      const msg = (m.error && (m.error.message || m.error.code)) || "?";
      console.error(m);
      flash(t("flash.asr") + msg); diag.err++; showLat();
      if (/api key|auth|unauthorized|invalid_api_key/i.test(msg)) { stop(); setStatus("status.keyBad", "err"); }
    }
  };
  speechSince = 0;
  state.ws.onclose = (ev) => {
    if (!state.running) return;
    setStatus("status.reconnect", "err");
    console.warn("ws closed", ev.code, ev.reason);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => state.running && connect(), 1500);
  };
  state.ws.onerror = () => {};
}
// 状态:key 是 I18N 键,extra 是附加的原样文字(增益倍数等)
let statusKey = "status.idle", statusKind = "", statusExtra = "";
function setStatus(key, kind, extra = "") { statusKey = key; statusKind = kind || ""; statusExtra = extra; const s = $("#status"); s.textContent = t(key) + extra; s.className = "chip" + (kind ? " " + kind : ""); }

// ---------- 麦克风 → 24 kHz PCM16 ----------
let stream = null, actx = null, tap = null, wakeLock = null;
let rs = null, agc = new Agc(), gainShownAt = 0;
// 数字增益:离声源远、收音小声时放大(见 audio.ts);信息栏上的倍数每秒最多刷新一次
function applyGain(x) {
  x = agc.apply(x, cfg.gain, cfg.maxGain, cfg.agcTarget);
  if (x.length && state.running && !micBroken && performance.now() - gainShownAt > 1000) { gainShownAt = performance.now(); showLat(); }
  return x;
}
// 信号格:放大后的音量分 5 格,只在格数变化时改 DOM
function setSignal(v) {
  const n = sigStep(v), s = $("#signal");
  if (s.dataset.level !== String(n)) s.dataset.level = n;
}
let lastSampleAt = 0;
function onSamples(input) {
  if (!actx) return; // 停止后 worklet 可能还有一条消息在路上
  lastSampleAt = performance.now();
  let x = rs.resample(input);
  x = applyGain(x);
  let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  setSignal(Math.sqrt(rms / (x.length || 1)) * 4);
  for (const pcm of rs.chunk(x)) {
    if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) })); addAsrCost(CHUNK / 24000); }
  }
}
async function startMic() {
  // iOS Safari:AudioContext 要在点击的同步阶段建好并 resume(await 之后就不算用户手势了);
  // 也不能指定 24 kHz(和硬件采样率不一致时麦克风只出静音),统一用默认采样率再在 JS 里重采样
  const Ctx = window.AudioContext || window.webkitAudioContext;
  actx = new Ctx(); rs = new Resampler(actx.sampleRate);
  const resumed = actx.resume().catch(() => {});
  const want = { channelCount: 1, ...cfg.mic };
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: cfg.micId ? { ...want, deviceId: { exact: cfg.micId } } : want }); }
  catch (e) {
    // 选定的麦克风拔掉了:退回系统默认,不让整个收音失败
    if (!cfg.micId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(e.name)) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: want }); flash(t("flash.micFallback"));
  }
  listMics();
  await resumed; actx.resume().catch(() => {});
  const code = `class Tap extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("tap", Tap);`;
  await actx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
  const src = actx.createMediaStreamSource(stream);
  tap = new AudioWorkletNode(actx, "tap");
  tap.port.onmessage = (e) => onSamples(e.data);
  const mute = actx.createGain(); mute.gain.value = 0;
  src.connect(tap); tap.connect(mute); mute.connect(actx.destination);
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (state.running && document.visibilityState === "visible") { keepAwake(); actx && actx.resume(); } });

async function start() {
  applySettings();
  if (!cfg.hasKey) { openSettings(); $("#apiKey").focus(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices) { setStatus("status.https", "err"); flash(t("flash.https")); return; }
  try { await startMic(); } catch (e) { setStatus("status.noMic", "err"); flash(t("flash.mic") + e.message); return; }
  state.running = true; micBroken = false; lastSampleAt = performance.now();
  $("#go").textContent = t("live.stop"); $("#go").classList.add("stop");
  keepAwake();
  connect();
}
function stop() {
  state.running = false;
  speechSince = 0;
  clearTimeout(reconnectTimer);
  if (liveBuf) liveFlush();
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  if (stream) stream.getTracks().forEach((x) => x.stop());
  if (actx) actx.close();
  stream = actx = tap = rs = null; agc = new Agc();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $("#go").textContent = t("live.start"); $("#go").classList.remove("stop");
  setSignal(0); showLat();
  setStatus("status.stopped");
}
$("#go").onclick = () => (isFileSess() ? (fileJob.active ? filePause() : fileStart()) : state.running ? stop() : start());
// iOS:音频上下文偶尔起不来(suspended),点一下屏幕任意处再试
document.addEventListener("touchend", () => {
  if (!state.running) return;
  if (micBroken) restartMic(); // 在点击里重建,iOS 才允许音频上下文启动
  else if (actx && actx.state !== "running") actx.resume().catch(() => {});
}, { passive: true });
// 麦克风看门狗:iOS 锁屏/切后台/来电后麦克风可能中断,页面却还显示收音中。
// 发现音轨结束、被静音、音频上下文没在跑或 2.5 秒没收到采样,就自动重开麦克风;重开不成功就提示点屏幕
let micBroken = false, micRestarting = false, lastRestartAt = 0;
function micProblem() {
  const tr = stream && stream.getAudioTracks()[0];
  if (!tr || tr.readyState === "ended") return "mic.ended";
  if (tr.muted) return "mic.muted";
  if (actx && actx.state !== "running") return "mic.ctx";
  if (performance.now() - lastSampleAt > 2500) return "mic.nodata";
  return "";
}
setInterval(() => {
  if (!state.running || micRestarting || document.visibilityState !== "visible") return;
  const why = micProblem();
  if (!why) { if (micBroken) { micBroken = false; setStatus("status.listening", "on"); } return; }
  micBroken = true;
  setStatus(why, "err", t("status.tapFix"));
  if (performance.now() - lastRestartAt > 4000) restartMic();
}, 1000);
async function restartMic() {
  if (micRestarting) return;
  micRestarting = true; lastRestartAt = performance.now();
  try {
    if (stream) stream.getTracks().forEach((x) => x.stop());
    if (actx) actx.close().catch(() => {});
    stream = actx = tap = rs = null;
    await startMic();
    lastSampleAt = performance.now();
  } catch (e) {
    console.error(e);
    setStatus("status.micCant", "err");
  } finally { micRestarting = false; }
}

// ---------- 视图切换 ----------
function show(v) {
  if (v === "live" && !state.curSess) v = "home";
  state.view = v; document.body.dataset.view = v;
  for (const [id, name] of [["#viewHome", "home"], ["#viewTpl", "tpl"], ["#viewLive", "live"], ["#viewCreate", "create"]]) $(id).hidden = v !== name;
  $("#toHome").hidden = v === "home"; $("#toTpl").hidden = v === "tpl";
  $("#title").textContent = v === "live" ? state.curSess.name : v === "create" ? t(creator.editId ? "create.titleEdit" : "create.titleNew") : v === "tpl" ? t("tpl.title") : t("app");
  document.title = $("#title").textContent;
  if (v === "home") renderSessions();
  if (v === "tpl") renderHome();
  if (v === "live") { setupFileView(); showEmptyHint(); scrollEnd(); }
  if (v !== "live") spkPanel(false);
  if (v === "create") renderCreator();
  store.set("view", v);
}
$("#toHome").onclick = () => show("home");
$("#toTpl").onclick = () => show("tpl");
$("#newSession").onclick = () => show("tpl");


// ---------- 文件翻译 ----------
// 浏览器内用 ffmpeg.wasm 提取音轨(边读边解,不把整个视频读进内存)→ 24 kHz 单声道 PCM → 按 FILE_SPEED 倍速送进实时转写
// 固定 gpt-transcribe + server VAD:每段都有 audio_start_ms / audio_end_ms,字幕能和视频精确对齐(以后声纹切片也靠它)
// 实测 4 倍速与 1 倍速识别结果一致,8 倍速开始丢字
const FILE_SPEED = 4, MEDIA_BASE = new Date(2000, 0, 1).getTime();
const fileJob = { active: false, phase: "idle", sid: null, pcm: null, pos: 0, total: 0, t0: 0, from: 0, ws: null, items: {}, pending: 0, lastEnd: 0, speakFrom: null, lastEvt: 0, err: "", extractPct: 0 };
function isFileSess() { return !!(state.curSess && state.curSess.kind === "file"); }
function setLineTime(line, s, e) {
  line.ms = s; line.endMs = e; line.t = new Date(MEDIA_BASE + e);
  if (!line.el.querySelector(".tm")) line.el.prepend(el("div", { className: "tm", textContent: fmtClock(s) }));
}
async function loadLineStore() {
  for (const [kv, name] of [[idb, "IndexedDB"], [lsKV, "localStorage"]]) {
    const st = new LineStore(kv, storageFailed);
    try { await st.load(); state.lineStore = st; break; } catch (e) { console.warn(name + " unavailable for subtitles", e); }
  }
  // 旧版存在 localStorage 的 slines.<id>:合并进新存储,写成功后再删,腾出空间。
  // 迁移后又用旧版记过字幕的话,两边都有,旧版那部分接在后面
  try {
    let changed = false;
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith("jls.slines."))) {
      const id = k.slice("jls.slines.".length);
      let arr = null; try { arr = JSON.parse(localStorage.getItem(k)); } catch {}
      const cur = state.lineStore.get(id), merged = Array.isArray(arr) ? mergeLegacy(cur, arr) : cur;
      if (merged.length !== cur.length) {
        if (!(await state.lineStore.set(id, merged))) continue;
        const ss = state.sessions.find((x) => x.id === id); if (ss) { ss.count = merged.length; changed = true; }
      }
      localStorage.removeItem(k);
    }
    if (changed) saveSessions();
  } catch (e) { console.warn("legacy subtitle migration skipped", e); }
}
let mediaUrl = null, pickFor = null;
// 先直接存 File;Safari 无痕模式等不让存 Blob 时,300 MB 以内改存 ArrayBuffer
async function storeMedia(id, f) {
  try { await idb.put(id, f); return true; } catch {}
  if (f.size > 300 * 1048576) return false;
  try { await idb.put(id, { name: f.name, type: f.type, buf: await f.arrayBuffer() }); return true; } catch { return false; }
}
async function loadMedia(id) {
  const v = await idb.get(id).catch(() => null);
  return v && v.buf ? new File([v.buf], v.name, { type: v.type }) : v || null;
}
function pickMedia(tplId) { pickFor = { tplId }; $("#mediaFile").value = ""; $("#mediaFile").click(); }
$("#reattach").onclick = () => { pickFor = { reattach: state.curSess.id }; $("#mediaFile").value = ""; $("#mediaFile").click(); };
$("#mediaFile").onchange = async () => {
  const f = $("#mediaFile").files[0]; if (!f || !pickFor) return;
  let ss;
  if (pickFor.reattach) ss = state.sessions.find((x) => x.id === pickFor.reattach);
  else {
    ss = newSession(pickFor.tplId);
    Object.assign(ss, { kind: "file", name: f.name.replace(/\.[^.]+$/, ""), file: { name: f.name, size: f.size, type: f.type, duration: 0 }, progress: 0, done: false });
    saveSessions();
  }
  pickFor = null; state.mediaBlob = f; fileJob.pcm = null; fileJob.sid = null;
  ss.file.stored = await storeMedia(ss.id, f);
  if (!ss.file.stored) flash(t("file.noStore"));
  saveSessions(); useSession(ss.id); show("live");
  if (ss.done) spkAuto(ss);
};
async function setupFileView() {
  const on = isFileSess();
  document.body.classList.toggle("filemode", on);
  $("#playerBox").hidden = $("#fileBar").hidden = !on;
  if (!on) { $("#go").textContent = t(state.running ? "live.stop" : "live.start"); return; }
  const ss = state.curSess;
  if (!state.mediaBlob || fileJob.sid !== ss.id) { state.mediaBlob = await loadMedia(ss.id) || (state.mediaBlob && state.mediaBlob.name === ss.file.name && fileJob.sid == null ? state.mediaBlob : null); fileJob.sid = ss.id; fileJob.pcm = null; }
  if (state.curSess !== ss) return;
  const p = $("#player");
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = state.mediaBlob ? URL.createObjectURL(state.mediaBlob) : null;
  if (mediaUrl) p.src = mediaUrl; else p.removeAttribute("src");
  $("#playerBox").classList.toggle("audio", /^audio\//.test(ss.file.type) || /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(ss.file.name));
  $("#playerBox").hidden = !state.mediaBlob;
  $("#reattach").hidden = true; // 缺文件时主按钮就是「重新选择原文件」
  p.onloadedmetadata = () => { if (isFinite(p.duration) && !ss.file.duration) { ss.file.duration = p.duration * 1000; saveSessions(); fileProgress(); } };
  fileJob.phase = fileJob.active ? fileJob.phase : ss.done ? "done" : ss.progress ? "paused" : "idle";
  fileProgress();
}
// 播放时叠加当前字幕、高亮对应行
$("#player").ontimeupdate = () => {
  const ms = $("#player").currentTime * 1000;
  let cur = null;
  for (const l of lines) { if (l.ms == null) continue; if (l.ms <= ms + 150 && ms <= l.endMs + 400) cur = l; if (l.ms > ms + 150) break; }
  $("#ovl .ot").textContent = cur && cur.tgt ? spkPrefix(cur) + cur.tgt : ""; $("#ovl .os").textContent = cur ? cur.src : "";
  if (state.spkStopAt != null && ms >= state.spkStopAt) { state.spkStopAt = null; $("#player").pause(); }
  const prev = $("#log .row.active");
  if (cur && prev !== cur.el) { if (prev) prev.classList.remove("active"); cur.el.classList.add("active"); if (!$("#player").paused) cur.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  else if (!cur && prev) prev.classList.remove("active");
};
function seekTo(ms) { const p = $("#player"); if (!p.src) return; state.spkStopAt = null; p.currentTime = ms / 1000; p.play().catch(() => {}); }
// extractPcm 的进度写进 fileJob,和文件翻译进度条共用
const pcmCb = {
  onPhase(ph) { fileJob.phase = ph; if (ph === "loading") fileJob.loadPct = 0; else fileJob.extractPct = 0; fileProgress(); },
  onLoad(p) { fileJob.loadPct = p; fileProgress(); },
  onExtract(p) { fileJob.extractPct = p; fileProgress(); },
};
// 按说话人断句时停顿 0.3 秒就断句(快速接话时换人处更容易断开),识别费用不变
function fileConfig() {
  const keep = [cfg.asrModel, cfg.silence]; cfg.asrModel = "gpt-transcribe"; cfg.silence = Math.min(cfg.silence, 300); // 短停顿就断句,便于区分说话人
  const c = sessionConfig(); [cfg.asrModel, cfg.silence] = keep; return c;
}
async function fileStart() {
  const ss = state.curSess;
  applySettings();
  if (!cfg.hasKey) { openSettings(); $("#apiKey").focus(); return; }
  if (!state.mediaBlob) { $("#reattach").click(); return; }
  if (ss.done && !$("#go").dataset.armed) { // 重新处理会清空字幕:先确认
    $("#go").dataset.armed = "1"; $("#go").textContent = t("file.redoSure");
    setTimeout(() => { delete $("#go").dataset.armed; setGoFile(); }, 3000); return;
  }
  delete $("#go").dataset.armed;
  if (ss.done) { // 重新处理:清空字幕从头来
    cancelSave(); bumpGen(sessKey()); lines.length = 0; history.length = 0; queue.length = 0; state.nextId = 0;
    $("#log").replaceChildren(); state.lineStore.set(sessKey(), null); ss.progress = 0; ss.done = false; ss.count = 0; saveSessions(); setMemo([]);
  }
  fileJob.active = true; fileJob.err = ""; setGoFile(); setStatus("status.processing", "on"); keepAwake();
  try {
    if (!fileJob.pcm) fileJob.pcm = await extractPcm(state.mediaBlob, pcmCb);
  } catch (e) { fileJob.active = false; fileJob.phase = "error"; fileJob.err = e.message; setGoFile(); fileProgress(); setStatus("status.paused", "err"); return; }
  if (!fileJob.active || state.curSess !== ss) return;
  fileJob.total = fileJob.pcm.length / 24; ss.file.duration = fileJob.total; saveSessions();
  fileJob.from = fileJob.pos = Math.min(ss.progress || 0, fileJob.total); fileJob.items = {}; fileJob.pending = 0; fileJob.forcedAt = []; fileJob.commitEnd = null; fileJob.lastEnd = fileJob.from; fileJob.speakFrom = null; fileJob.phase = "run";
  fileConnect(ss);
}
function fileConnect(ss) {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  const ws2 = (fileJob.ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]));
  const J = fileJob, off = J.from; // 转写会话里的 audio_*_ms 从本次连接开始送的第一帧算起
  ws2.onopen = () => { ws2.send(JSON.stringify({ type: "session.update", session: fileConfig() })); J.t0 = performance.now(); J.lastEvt = performance.now(); filePump(ws2, ss); };
  ws2.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    J.lastEvt = performance.now();
    if (m.type === "input_audio_buffer.speech_started") { (J.items[m.item_id] ||= {}).s = off + m.audio_start_ms; J.speakFrom = off + m.audio_start_ms; J.pending++; }
    else if (m.type === "input_audio_buffer.speech_stopped") { (J.items[m.item_id] ||= {}).e = off + m.audio_end_ms; J.speakFrom = null; }
    else if (m.type === "input_audio_buffer.committed") {
      // 强制断句的段没有 speech_stopped:结束时间用发 commit 时的位置;紧接着的下一段从这里开始
      const it = (J.items[m.item_id] ||= {});
      if (it.s == null) { it.s = J.commitEnd ?? J.lastEnd; J.pending++; }
      if (it.e == null) it.e = J.forcedAt.shift() ?? J.pos;
      J.commitEnd = it.e;
    }
    else if (m.type === "conversation.item.input_audio_transcription.delta") { $("#partial").textContent = (($("#partial").textContent || "") + (m.delta || "")).slice(-120); }
    else if (m.type === "conversation.item.input_audio_transcription.completed") {
      const it = J.items[m.item_id] || {}; delete J.items[m.item_id]; J.pending = Math.max(0, J.pending - 1);
      const s0 = it.s ?? J.lastEnd, e0 = Math.max(s0 + 300, it.e ?? J.pos);
      J.lastEnd = e0; $("#partial").textContent = "";
      emitTimed((m.transcript || "").trim(), s0, e0);
      if (state.curSess === ss) { ss.progress = Math.max(ss.progress || 0, e0); saveSessions(); }
    } else if (m.type === "error") {
      const msg = (m.error && (m.error.message || m.error.code)) || "?";
      console.error(m); diag.err++; showLat();
      if (/api key|auth|unauthorized|invalid_api_key/i.test(msg)) { J.err = msg; filePause(true); }
    }
    fileProgress();
  };
  ws2.onclose = () => { if (J.ws === ws2 && J.active && J.phase !== "finish") { J.err = t("status.reconnect"); filePause(true); } };
}
// 按 FILE_SPEED 倍速、每 100 ms 一帧送音频;一句超过「单句最长时长」就强制断句;送完后等最后几段识别和翻译收尾
function filePump(ws2, ss) {
  const J = fileJob, CHUNK_MS = 100, N = 2400;
  const tick = () => {
    if (!J.active || J.ws !== ws2 || ws2.readyState !== 1) return;
    const target = Math.min(J.total, J.from + (performance.now() - J.t0) * FILE_SPEED);
    while (J.pos < target) {
      const i = Math.round(J.pos * 24), chunk = J.pcm.subarray(i, Math.min(i + N, J.pcm.length));
      if (!chunk.length) { J.pos = J.total; break; }
      ws2.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(chunk) }));
      J.pos += CHUNK_MS; addAsrCost(CHUNK_MS / 1000, "gpt-transcribe");
      if (J.speakFrom != null && J.pos - J.speakFrom > cfg.maxTurn * 1000) { ws2.send(JSON.stringify({ type: "input_audio_buffer.commit" })); J.forcedAt.push(J.pos); J.speakFrom = J.pos; }
    }
    if (J.pos >= J.total) {
      if (J.phase === "run") { J.phase = "flush"; if (J.speakFrom != null) { ws2.send(JSON.stringify({ type: "input_audio_buffer.commit" })); J.forcedAt.push(J.pos); } J.flushAt = performance.now(); }
      const quiet = performance.now() - J.lastEvt > 4000;
      if ((J.pending === 0 && quiet || performance.now() - J.flushAt > 60000) && !queue.length && !state.translating) return fileFinish(ss);
    }
    fileProgress();
    setTimeout(tick, CHUNK_MS);
  };
  tick();
}
function emitTimed(text, s, e) {
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  // 一段里有几句就拆开,时间按字数比例分
  for (const p of splitTimed(text, s, e, ["ja", "zh"].includes(cfg.tpl.source))) {
    diag.asr++; const line = addLine(++state.nextId, p.text); setLineTime(line, Math.round(p.s), Math.round(p.e)); queue.push(line);
    const j = lines.findIndex((l) => l !== line && l.ms != null && l.ms > line.ms);
    if (j >= 0) { lines.splice(lines.indexOf(line), 1); lines.splice(j, 0, line); lines[j + 1].el.before(line.el); }
  }
  pumpTranslate(); showLat(); saveLines();
}
function fileFinish(ss) {
  const J = fileJob;
  J.active = false; J.phase = "done"; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  ss.done = true; ss.progress = J.total; saveSessions();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus("status.done", "on"); fileProgress();
  spkAfterFile(ss); // 开着说话人识别:自动识别;之前识别过:先按已有声纹结果标注新字幕,GPT 判定重做
}
function filePause(isErr) {
  const J = fileJob;
  J.active = false; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  J.phase = isErr ? "error" : "paused";
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus(isErr ? "status.paused" : "status.paused", isErr ? "err" : "warn"); fileProgress();
}
function setGoFile() {
  if (!isFileSess()) return;
  const ss = state.curSess, g = $("#go");
  if (g.dataset.armed) return;
  g.textContent = t(fileJob.active ? "file.pause" : !state.mediaBlob ? "file.reattach" : ss.done ? "file.redo" : ss.progress ? "file.resume" : "file.start");
  g.classList.toggle("stop", fileJob.active);
  g.classList.toggle("redo", !fileJob.active && !!ss.done);
}
function fileProgress() {
  if (!isFileSess()) return;
  const ss = state.curSess, J = fileJob, total = J.total || (ss.file && ss.file.duration) || 0;
  const done = lines.filter((l) => l.done).length, n = lines.length, pos = J.active ? J.pos : ss.progress || 0;
  let pct = total ? pos / total : 0, txt;
  const fill = $("#pfill"); fill.classList.toggle("busy", J.phase === "flush");
  if (J.phase === "loading") { txt = t("file.loading", { pct: Math.round((J.loadPct || 0) * 100) }); pct = J.loadPct || 0; }
  else if (J.phase === "extract") { txt = t("file.extract", { pct: Math.round(J.extractPct * 100) }); pct = J.extractPct; }
  else if (J.phase === "run") { const left = (total - pos) / FILE_SPEED + (n - done) * 400; txt = t("file.run", { pct: Math.round(pct * 100), pos: fmtClock(pos), total: fmtClock(total), speed: FILE_SPEED, eta: fmtClock(left), done, n }); }
  else if (J.phase === "flush") { txt = t("file.flush", { done, n }); pct = 1; }
  else if ((J.phase === "done" || ss.done) && spkRunning() && spkNow.msg) { txt = t("file.spk", { m: spkNow.msg }); pct = spkNow.p == null ? 1 : spkNow.p; fill.classList.toggle("busy", spkNow.p == null); }
  else if (J.phase === "done" || ss.done) { txt = t("file.done", { total: fmtClock(total), n }); pct = 1; }
  else if (J.phase === "error") txt = t("file.err", { m: J.err || "?" });
  else if (!state.mediaBlob) txt = t("file.missing");
  else if (ss.progress) txt = t("file.paused", { pos: fmtClock(pos), total: fmtClock(total), n });
  else txt = t("file.idle", { total: total ? fmtClock(total) : "—", speed: FILE_SPEED });
  fill.style.width = Math.round(Math.min(1, pct) * 1000) / 10 + "%";
  $("#pinfo").textContent = txt;
  $("#expSrt").hidden = $("#expVtt").hidden = !lines.some((l) => l.ms != null && l.done);
  setGoFile();
}
const makeSubs = (kind) => subtitleFile(kind, lines, $("#showSrc").checked, spkPrefix);
$("#expSrt").onclick = () => download(fileName(state.curSess.name) + ".srt", makeSubs("srt"), "application/x-subrip");
$("#expVtt").onclick = () => download(fileName(state.curSess.name) + ".vtt", makeSubs("vtt"), "text/vtt");


// ---------- 说话人识别(实验功能,全部在本机计算,不调用 API) ----------
// 能量检测在 0.25 秒的停顿处细切 → 每段算 CAM++ 声纹(onnxruntime-web)→ 1.5 秒以上的片段做层次聚类分组 → 每段归到最近的组
// → 每句字幕按重叠时长投票,最多的一组占比达到阈值才标名字。实测(3 人快速接话的电台节目):片段 93%,按句约 75%,约一半的句子有标签
// 声纹存在 IndexedDB「spk:<会话 id>」,改阈值、改名字只重新分组/投票,不用重算
const SPK_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e64980", "#5c7cfa"];
let spkBusy = false, spkModelP = null;
// 一句字幕里声纹占比达到这个比例才算声纹确定(MyGO 实测的最优值),不确定的交给 GPT 判定
const SPK_SHARE = 0.85;
// 分组阈值(余弦距离)、投票时句子两端放宽的秒数、没有重叠片段时找最近片段的最大距离:
// 都按 MyGO #199 官方字幕颜色标注(真实说话人)实测选定,0.5–0.9 的阈值结果几乎一样
const SPK_DIST = 0.5, SPK_PAD = 0.5, SPK_NEAR = 2;
function spkOn() { return sget("spkOn", "0") === "1"; }
function spkPrefix(l) { return l.spk && spkOn() ? l.spk + (CJK.test(l.tgt || l.src || "") ? "：" : ": ") : ""; }
function spkName(c) { return (state.spk.names[c] || "").trim() || (state.spk.llm && state.spk.llm.names[c]) || t("spk.n", { n: c + 1 }); }
function paintSpk(l) {
  const tm = l.el.querySelector(".tm"); if (!tm) return;
  let w = tm.querySelector(".who");
  if (l.spk == null) { if (w) w.remove(); return; }
  if (!w) tm.append(w = el("span", { className: "who" }));
  w.textContent = l.spk || t("spk.unsure"); w.classList.toggle("unsure", !l.spk); w.style.setProperty("--c", l.spk ? SPK_COLORS[(l.spc || 0) % SPK_COLORS.length] : "");
  w.classList.toggle("ai", !!l.spkBy); w.title = l.spkBy ? t("spk.by." + l.spkBy) : "";
}
// onnxruntime-web 的 wasm(14 MB)和声纹模型都随页面同源发布;模型 28 MB,边下边显示进度
function loadSpkModel(onPct) {
  return (spkModelP ||= (async () => {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const buf = await fetchProgress(SPK_MODEL, onPct, 28281138);
    return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  })().catch((e) => { spkModelP = null; throw e; }));
}
async function spkEmbed(model, x) {
  const { data, T } = spkFbank(x);
  const r = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", data, [1, T, 80]) });
  return spkNorm(r[model.outputNames[0]].data);
}
async function spkLoad() {
  if (!state.curSess) return null;
  if (state.spk && state.spk.sid === state.curSess.id) return state.spk;
  const sid = state.curSess.id, rec = await idb.get("spk:" + sid).catch(() => null);
  if (!state.curSess || state.curSess.id !== sid) return null;
  state.spk = rec ? { ...rec, sid } : null;
  if (state.spk) spkRecluster(false, true);
  return state.spk;
}
function spkSave() { if (state.spk) idb.put("spk:" + state.spk.sid, { segs: state.spk.segs, emb: state.spk.emb, n: state.spk.n, cents: state.spk.cents, names: state.spk.names, llm: state.spk.llm || null }).catch(() => {}); }
async function spkAnalyze() {
  const ss = state.curSess;
  if (!ss || spkBusy) return;
  if (fileJob.active) return spkMsg(t("spk.busy"));
  if (!state.mediaBlob) return spkMsg(t("spk.needMedia"));
  spkBusy = true; renderSpk(); spkBar(0);
  try {
    spkMsg(t("spk.loadModel", { pct: 0 }));
    const model = await loadSpkModel((p) => { spkBar(p); spkMsg(t("spk.loadModel", { pct: Math.round(p * 100) })); });
    if (!fileJob.pcm) {
      spkBar(null); spkMsg(t("spk.extract"));
      const keep = fileJob.phase;
      try { fileJob.pcm = await extractPcm(state.mediaBlob, pcmCb); } finally { fileJob.phase = keep; fileProgress(); }
    }
    if (state.curSess !== ss) return;
    const pcm = fileJob.pcm, segs = spkSegments(pcm, 24000), n = segs.length, emb = new Float32Array(n * SPK_DIM);
    // 模型在主线程里跑,await 不会真的把控制权还给浏览器:每 40 ms 主动让一次,页面才能响应、进度条才会刷新
    let yieldAt = performance.now();
    for (let i = 0; i < n; i++) {
      if (state.curSess !== ss) return;
      emb.set(await spkEmbed(model, spkResample(pcm, Math.round(segs[i][0] * 24000), Math.round(segs[i][1] * 24000))), i * SPK_DIM);
      if (performance.now() - yieldAt > 40) { spkBar(i / n); spkMsg(t("spk.embed", { i, n })); await new Promise((r) => setTimeout(r, 0)); yieldAt = performance.now(); }
    }
    const old = state.spk && state.spk.sid === ss.id ? state.spk : null;
    state.spk = { sid: ss.id, segs: Float32Array.from(segs.flat()), emb, n, cents: old ? old.cents : null, names: old ? old.names : [] };
    spkRecluster(true); spkSave();
  } catch (e) { console.error(e); spkMsg(t("spk.err", { m: e.message || String(e) })); }
  finally { spkBusy = false; spkBar(null); if (state.curSess === ss) renderSpk(); }
}
// 分组:长片段聚类(最多取最长的 600 段),太小的组(少于 3 段且不到 3%)并进最近的组;组按总时长排序。
// 重新分组后,和旧的组声纹很像的沿用旧名字
function spkRecluster(inherit, keepLlm) {
  const { n, segs, emb } = state.spk, vec = (i) => emb.subarray(i * SPK_DIM, (i + 1) * SPK_DIM), dur = (i) => segs[2 * i + 1] - segs[2 * i];
  let long = []; for (let i = 0; i < n; i++) if (dur(i) >= 1.5) long.push(i);
  if (long.length > 600) long = long.sort((a, b) => dur(b) - dur(a)).slice(0, 600);
  if (long.length < 2) for (let i = 0; i < n; i++) if (!long.includes(i)) long.push(i);
  const lab = spkCluster(long.map(vec), SPK_DIST), groups = new Map();
  long.forEach((i, k) => { const g = groups.get(lab[k]) || []; g.push(i); groups.set(lab[k], g); });
  let keep = [...groups.values()].filter((g) => g.length >= Math.max(3, 0.03 * long.length));
  if (!keep.length) keep = [[...groups.values()].sort((a, b) => b.length - a.length)[0]];
  const mean = (idx) => { const m = new Float32Array(SPK_DIM); for (const i of idx) { const v = vec(i); for (let d = 0; d < SPK_DIM; d++) m[d] += v[d]; } return spkNorm(m); };
  let cents = keep.map(mean);
  const assign = () => { state.spk.lab = new Int16Array(n); state.spk.sim = new Float32Array(n); for (let i = 0; i < n; i++) { let b = 0, bs = -2; const v = vec(i); cents.forEach((c, k) => { const s2 = spkDot(v, c); if (s2 > bs) { bs = s2; b = k; } }); state.spk.lab[i] = b; state.spk.sim[i] = bs; } };
  assign();
  const tot = cents.map((_, k) => { let s2 = 0; for (let i = 0; i < n; i++) if (state.spk.lab[i] === k) s2 += dur(i); return s2; });
  const order = cents.map((_, k) => k).sort((a, b) => tot[b] - tot[a]);
  cents = order.map((k) => cents[k]); assign();
  // 前后文平滑:短片段结合前后片段一起定组(MyGO 三集实测按时长准确率 +0~2 个百分点)
  { const K = cents.length, sims = new Float32Array(n * K);
    for (let i = 0; i < n; i++) { const v = vec(i); cents.forEach((c, k) => { sims[i * K + k] = spkDot(v, c); }); }
    state.spk.lab = spkSmooth(segs, sims, K); for (let i = 0; i < n; i++) state.spk.sim[i] = sims[i * K + state.spk.lab[i]]; }
  const oldC = state.spk.cents ? Array.from({ length: state.spk.cents.length / SPK_DIM }, (_, k) => state.spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) : [], oldN = state.spk.names || [];
  if (inherit !== false) { // 新旧两组互为最像、且余弦 ≥ 0.8 才沿用名字,避免名字沿着相近的组一路传下去
    const best = (v, arr) => { let b = -1, bs = 0.8; arr.forEach((o, k) => { const s2 = spkDot(v, o); if (s2 >= bs) { bs = s2; b = k; } }); return b; };
    state.spk.names = cents.map((c, k) => { const o = best(c, oldC); return o >= 0 && best(oldC[o], cents) === k ? oldN[o] || "" : ""; });
  }
  const same = state.spk.cents && state.spk.cents.length === cents.length * SPK_DIM && cents.every((c, k) => spkDot(c, state.spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) > 0.999);
  if (!keepLlm && !same) state.spk.llm = null; // 分组变了,之前的 LLM 判定对不上组号,作废
  state.spk.cents = new Float32Array(cents.length * SPK_DIM); cents.forEach((c, k) => state.spk.cents.set(c, k * SPK_DIM));
  state.spk.groups = cents.map((_, k) => {
    let d = 0, cnt = 0, best = -1, bs = -2;
    for (let i = 0; i < n; i++) if (state.spk.lab[i] === k) { d += dur(i); cnt++; if (dur(i) >= 1.5 && state.spk.sim[i] > bs) { bs = state.spk.sim[i]; best = i; } }
    if (best < 0) for (let i = 0; i < n; i++) if (state.spk.lab[i] === k && (best < 0 || dur(i) > dur(best))) best = i;
    return { dur: d, n: cnt, sample: best };
  });
  spkVote();
}
// 每句字幕:和它重叠的片段按时长投票(1.5 秒以下的片段权重减半),同名的组合并计票;
// 按组的候选分布记在 l.spkV(给 LLM 判定用)。有 LLM 判定且开着时:声纹不确定的句子用 LLM 的结论;
// 声纹确定的句子只在 LLM 有明确证据(自我介绍、被点名后回答)时改判
function spkVote() {
  if (!state.spk) return;
  const share = SPK_SHARE, { n, segs } = state.spk, color = {};
  state.spk.groups.forEach((_, k) => { const nm = spkName(k); if (!(nm in color)) color[nm] = k; });
  const llm = state.spk.llm ? new Map(state.spk.llm.lines.map(([id, who, basis]) => [id, { who, basis }])) : null;
  const llmName = (who) => (/^G\d+$/.test(who) ? spkName(Number(who.slice(1)) - 1) : who);
  let tagged = 0, timed = 0;
  for (const l of lines) {
    if (l.ms == null) continue;
    timed++;
    const s = l.ms / 1000 - SPK_PAD, e = l.endMs / 1000 + SPK_PAD, vote = {}, gv = {}; let sum = 0;
    for (let i = 0; i < n; i++) {
      const ov = Math.min(e, segs[2 * i + 1]) - Math.max(s, segs[2 * i]);
      if (ov <= 0) continue;
      const w = ov * (segs[2 * i + 1] - segs[2 * i] >= 1.5 ? 1 : 0.5), nm = spkName(state.spk.lab[i]);
      vote[nm] = (vote[nm] || 0) + w; gv[state.spk.lab[i]] = (gv[state.spk.lab[i]] || 0) + w; sum += w;
    }
    l.spkV = Object.entries(gv).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, w]) => [Number(k), w / sum]); delete l.spkNear;
    // 句子的时间戳有时偏短、落在两段声音之间:取前后 SPK_NEAR 秒内最近的片段作参考,但不算声纹确定,交给 GPT 判断
    if (!sum) { let bi = -1, bg = Infinity; for (let i = 0; i < n; i++) { const g = Math.max(segs[2 * i] - e, s - segs[2 * i + 1]); if (g < bg) { bg = g; bi = i; } } if (bi >= 0 && bg <= SPK_NEAR) { l.spkV = [[state.spk.lab[bi], 1]]; l.spkNear = Math.max(0, bg); } }
    const top = Object.entries(vote).sort((a, b) => b[1] - a[1])[0], sure = top && top[1] / sum >= share - 1e-9;
    delete l.spkBy;
    if (!top) delete l.spk; else if (sure) l.spk = top[0]; else l.spk = "";
    const j = llm && llm.get(l.id);
    if (j && j.who) {
      const nm = llmName(j.who);
      const unnamed = sure && /^G\d+$/.test(j.who) === false && state.spk.groups.some((_, k) => spkName(k) === l.spk && spkName(k) === t("spk.n", { n: k + 1 }));
      if (nm !== l.spk && (!sure || unnamed || j.basis === "self_intro" || j.basis === "addressed")) { l.spk = nm; l.spkBy = j.basis; }
    }
    if (l.spk) { if (!(l.spk in color)) color[l.spk] = Object.keys(color).length; l.spc = color[l.spk]; tagged++; } else delete l.spc;
    paintSpk(l);
  }
  state.spk.tagged = tagged; state.spk.timed = timed;
  saveLines();
}
// 模板声纹库:{ 名字: { v: base64(192 维 float32), d: 累计秒数 } }。确认过组名后存进模板,之后同一模板的文件自动对照
const f32b64 = (v) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(v).buffer)));
const b64f32 = (s) => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
function spkGroupVecs() { return state.spk.groups.map((_, k) => state.spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)); } // 各组质心
function spkSaveVoices() {
  const tp = getTemplate(cfg.tpl.id); if (!tp || !state.spk) return;
  const lib = { ...(tp.voices || {}) }, acc = {}, G = spkGroupVecs();
  for (let k = 0; k < state.spk.groups.length; k++) {
    const nm = spkName(k); if (nm === t("spk.n", { n: k + 1 })) continue; // 没认出名字的组不存
    const a = (acc[nm] ||= { v: new Float32Array(SPK_DIM), d: 0 }), d = state.spk.groups[k].dur;
    for (let i = 0; i < SPK_DIM; i++) a.v[i] += G[k][i] * d; a.d += d;
  }
  for (const [nm, a] of Object.entries(acc)) { // 和库里同名的按时长加权合并
    const old = lib[nm];
    if (old) { const ov = b64f32(old.v); for (let i = 0; i < SPK_DIM; i++) a.v[i] += ov[i] * old.d; a.d += old.d; }
    lib[nm] = { v: f32b64(spkNorm(a.v)), d: Math.round(a.d) };
  }
  putTemplate({ ...tp, voices: lib }); renderSpk(); spkMsg(t("spk.saved", { names: Object.keys(acc).join("、") || "—" }));
}
// 对照规则(MyGO 四集跨集实测):余弦 ≥ 0.88、比第二像的高 0.05 以上、且互为最像 —— 不同人的误认全部排除;
// 同一声优的「本人声线」和「角色声线」可能互相匹配,所以只作为提示交给 GPT,由它按本集是角色回还是本人回定名字
const SPK_LIB_MIN = 0.88, SPK_LIB_MARGIN = 0.05;
function spkLibMatch() {
  const lib = Object.entries((cfg.tpl && cfg.tpl.voices) || {}).map(([name, x]) => ({ name, v: b64f32(x.v) }));
  if (!state.spk || !lib.length) return [];
  const G = spkGroupVecs();
  return G.map((c, k) => {
    const sc = lib.map((x) => spkDot(c, x.v)).map((s2, i) => [s2, i]).sort((a, b) => b[0] - a[0]);
    const [s1, i1] = sc[0], s2 = sc[1] ? sc[1][0] : -1;
    const mutual = G.every((h, j) => j === k || spkDot(h, lib[i1].v) < s1);
    return s1 >= SPK_LIB_MIN && s1 - s2 >= SPK_LIB_MARGIN && mutual ? { name: lib[i1].name, sim: s1 } : null;
  });
}
// LLM 判定:声纹候选 + 字幕文本 + 模板(背景、说话人线索、出演者)→ 每组的名字、每句的说话人
let spkJudging = false;
async function spkJudge() {
  const ss = state.curSess;
  if (!state.spk || spkJudging || !ss) return;
  applySettings();
  if (!cfg.hasKey) return spkMsg(t("spk.needKey"));
  spkJudging = true; renderSpk(); spkBar(null);
  const t0 = Date.now(), tick = () => spkMsg(t("spk.judging", { s: Math.round((Date.now() - t0) / 1000), n: lines.length })), timer = setInterval(tick, 1000); tick();
  try {
    const g = cfg.glossary, tl = lines.filter((l) => l.ms != null && (l.src || l.raw));
    const jl = tl.map((l) => ({ id: l.id, s: l.ms / 1000, e: l.endMs / 1000, text: l.src || l.raw, voice: l.spkV || [], near: l.spkNear }));
    const r = await judgeSpeakers({
      lines: jl,
      groups: (() => { const lm = spkLibMatch(); return state.spk.groups.map((gr, k) => ({ k, name: (state.spk.names[k] || "").trim(), dur: gr.dur, lib: lm[k] || undefined })); })(),
      description: cfg.tpl.description || "", spkNotes: cfg.tpl.spkNotes || "", people: g.people,
      share: SPK_SHARE,
    }, async (system, user, schema) => {
      const res = await fetch(cfg.apiBase + "/chat/completions", { method: "POST", headers: apiHeaders(), body: JSON.stringify({
        model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "speakers", strict: true, schema } } }) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json(); addMtCost(cfg.ctModel, data.usage);
      return JSON.parse(data.choices[0].message.content);
    });
    if (state.curSess !== ss) return;
    const names = reconcileGroupNames(jl, r, SPK_SHARE, state.spk.groups.length); // 组名和逐句判定对齐,重名且没句子支持的清空
    state.spk.llm = { names, lines: [...r.lines].map(([id, v]) => [id, v.who, v.basis]), at: Date.now() };
    spkVote(); spkSave();
  } catch (e) { console.error(e); clearInterval(timer); spkJudging = false; spkMsg(t("spk.err", { m: e.message || String(e) })); renderSpk(false); return; }
  finally { spkJudging = false; clearInterval(timer); spkBar(null); }
  if (state.curSess === ss) renderSpk();
}
// 开着说话人识别时自动跑完两步:本机声纹分析(没做过才做)→ GPT 判定(没判过或已作废才判)
let spkAutoP = null;
function spkAuto(ss = state.curSess) {
  if (!ss || ss !== state.curSess || !spkOn() || !isFileSess() || fileJob.active || !ss.done || spkAutoP) return spkAutoP;
  return (spkAutoP = (async () => {
    try {
      await spkLoad();
      if (!state.spk) { if (!state.mediaBlob) return spkMsg(t("spk.needMedia")); await spkAnalyze(); }
      if (state.spk && state.curSess === ss && !state.spk.llm) await spkJudge();
    } finally { spkAutoP = null; if (state.curSess === ss) { if (!$("#spkPanel").hidden) renderSpk(); fileProgress(); } }
  })());
}
async function spkAfterFile(ss) {
  if (state.curSess !== ss) return;
  if (await spkLoad()) { state.spk.llm = null; spkVote(); spkSave(); } // 字幕重新生成了,旧的 GPT 判定对不上
  spkAuto(ss);
}
// 面板里的进度同步到主进度条(spkNow 记下当前这一步)
const spkNow = { msg: "", p: null };
function spkRunning() { return spkBusy || spkJudging || !!spkAutoP; }
function spkMsg(m) { $("#spkMsg").textContent = m; spkNow.msg = m; fileProgress(); }
function spkBar(p) { $("#spkBar").hidden = p == null; if (p != null) $("#spkBar i").style.width = Math.round(p * 1000) / 10 + "%"; spkNow.p = p; fileProgress(); }
function spkPanel(on) { $("#spkPanel").hidden = !on; document.body.classList.toggle("spkopen", on); }
function renderSpk(msg = true) {
  const on = spkOn(), busy = spkBusy || spkJudging || !!spkAutoP;
  $("#spkIntro").textContent = t(on ? "spk.introOn" : "spk.introOff");
  $("#spkRun").textContent = t(!on ? "spk.enable" : state.spk ? "spk.rerun" : "spk.start"); $("#spkRun").disabled = busy || (on && !(state.curSess && state.curSess.done));
  const list = $("#spkList"); list.replaceChildren(); $("#spkVoices").hidden = true;
  if (!on) { if (!busy) spkMsg(""); return; }
  if (!state.spk) { if (!busy) spkMsg(t(!(state.curSess && state.curSess.done) ? "spk.wait" : state.mediaBlob ? "spk.none" : "spk.needMedia")); return; }
  if (!busy && msg) spkMsg(t("spk.done", { k: state.spk.groups.length, a: state.spk.tagged, b: state.spk.timed }) + (state.spk.llm ? " " + t("spk.judged", { n: lines.filter((l) => l.spkBy).length }) : ""));
  const libM = spkLibMatch(), libN = Object.keys((cfg.tpl && cfg.tpl.voices) || {});
  $("#spkVoices").hidden = false; $("#spkSaveVoices").disabled = busy || !state.spk.groups.some((_, k) => spkName(k) !== t("spk.n", { n: k + 1 }));
  $("#spkLib").textContent = libN.length ? t("spk.lib", { names: libN.join("、") }) : t("spk.libNone"); $("#spkClearVoices").hidden = !libN.length;
  state.spk.groups.forEach((g, k) => {
    const ai = state.spk.llm && state.spk.llm.names[k], lm = libM[k];
    const inp = el("input", { type: "text", value: state.spk.names[k] || "", placeholder: ai ? ai + " · AI" : t("spk.n", { n: k + 1 }) });
    inp.onchange = () => { state.spk.names[k] = inp.value.trim(); spkVote(); spkSave(); renderSpk(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    const play = el("button", { className: "btn i-play", textContent: t("spk.play"), onclick: () => { const i = g.sample; if (i < 0) return; seekTo(state.spk.segs[2 * i] * 1000); state.spkStopAt = state.spk.segs[2 * i + 1] * 1000 + 200; } });
    list.append(el("div", { className: "spkItem" }, el("i", { className: "dot", style: "--c:" + SPK_COLORS[k % SPK_COLORS.length] }), inp, el("span", { className: "meta", textContent: t("spk.meta", { dur: fmtClock(g.dur * 1000), n: g.n }) + (lm ? " · " + t("spk.libMatch", { name: lm.name }) : "") }), play));
  });
}
$("#spkOpen").onclick = async () => { spkPanel(true); renderSpk(); await spkLoad(); renderSpk(); };
$("#spkClose").onclick = () => spkPanel(false);
$("#spkRun").onclick = () => {
  if (!spkOn()) return spkAskEnable();
  if (state.spk) { state.spk.llm = null; spkVote(); spkSave(); } // 重新识别:保留声纹分组和你起的名字,GPT 重新判定
  spkAuto(); renderSpk();
};
$("#spkSaveVoices").onclick = spkSaveVoices;
$("#spkClearVoices").onclick = () => {
  const b = $("#spkClearVoices");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = t("spk.clearVoicesSure"); setTimeout(() => { delete b.dataset.armed; b.textContent = t("spk.clearVoices"); }, 3000); return; }
  delete b.dataset.armed; b.textContent = t("spk.clearVoices");
  const tp = getTemplate(cfg.tpl.id); if (tp) { putTemplate({ ...tp, voices: {} }); renderSpk(); }
};
$("#spkSettings").onclick = () => { openSettings(); $("#secSpk").scrollIntoView({ block: "start" }); };
// 第一次开启先确认(要下载约 40 MB 组件、GPT 判定消耗 API),确认过一次就不再问
function spkAskEnable() {
  if (store.get("spkConsent", "") === "1") return spkSetOn(true);
  $("#spkOn").checked = false; $("#spkConfirm").hidden = false;
  if ($("#settings").hidden) openSettings();
  $("#secSpk").scrollIntoView({ block: "start" });
}
$("#spkConfirmOk").onclick = () => { store.set("spkConsent", "1"); $("#spkConfirm").hidden = true; spkSetOn(true); };
$("#spkConfirmNo").onclick = () => { $("#spkConfirm").hidden = true; };
$("#spkOn").onchange = () => { if ($("#spkOn").checked) spkAskEnable(); else { $("#spkConfirm").hidden = true; spkSetOn(false); } };
function spkSetOn(on) {
  $("#spkOn").checked = on;
  sset("spkOn", on ? "1" : null); document.body.classList.toggle("nospk", !spkOn());
  for (const l of lines) paintSpk(l);
  if (!$("#spkPanel").hidden) renderSpk();
  spkAuto();
};

// ---------- 模板列表 ----------
function renderHome() {
  $("#noKey").hidden = cfg.hasKey;
  const list = $("#tplList");
  list.replaceChildren();
  for (const tp of allTemplates()) {
    const g = parseGlossary(tp.glossary);
    const h = el("h3", { textContent: tp.name });
    if (tp.builtin) h.append(el("span", { className: "tag", textContent: t(tp.modified ? "card.modified" : "card.builtin") }));
    if (state.curSess && state.curSess.tplId === tp.id) h.append(el("span", { className: "tag", textContent: t("card.current") }));
    const btn = (key, fn, primary, icon) => el("button", { className: "btn" + (primary ? " primary" : "") + " i-" + icon, textContent: t(key), onclick: fn });
    const btns = el("div", { className: "btns" },
      btn("card.open", () => { newSession(tp.id); show("live"); }, true, "play"),
      btn("card.file", () => pickMedia(tp.id), false, "film"),
      btn("card.edit", () => openCreator(tp), false, "edit"),
      btn("card.dup", () => { putTemplate({ ...tp, id: newId(), name: tp.name + t("card.copy") }); renderHome(); }, false, "copy"),
      btn("card.export", () => exportTemplate(tp), false, "download"));
    if (!tp.builtin || tp.modified) {
      const del = btn(tp.builtin ? "card.reset" : "card.del", (e) => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = t("card.delSure"); setTimeout(() => { delete del.dataset.armed; del.textContent = t(tp.builtin ? "card.reset" : "card.del"); }, 3000); return; }
        removeTemplate(tp.id); renderHome();
      }, false, tp.builtin ? "restore" : "trash");
      btns.append(del);
    }
    list.append(el("div", { className: "card" + (state.curSess && state.curSess.tplId === tp.id ? " current" : "") },
      h, el("div", { className: "meta", textContent: t("card.meta", { src: srcName(tp.source), tgt: tgtName(tp.target), p: g.people.length, n: g.terms.length }) }),
      tp.description ? el("div", { className: "meta desc", textContent: tp.description.slice(0, 120) + (tp.description.length > 120 ? "…" : "") }) : null, btns));
  }
}
function exportTemplate(tp) {
  const { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, voices } = tp;
  download((name || "template").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) + ".json",
    JSON.stringify({ format: "tsuji-template", version: 1, template: { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, ...(voices ? { voices } : {}) } }, null, 2), "application/json");
}
$("#importTpl").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text()), tp = d.template || d;
    if (!tp.name || typeof tp.glossary !== "string") throw new Error();
    putTemplate({ ...tp, id: getTemplate(tp.id) ? newId() : tp.id || newId(), source: LANGS[tp.source] ? tp.source : "auto", target: TARGETS[tp.target] ? tp.target : "zh-Hans" });
    renderHome();
  } catch { alert(t("home.importFail")); }
};
$("#newTpl").onclick = () => openCreator(null);

// ---------- 创建 / 编辑模板(和 GPT 对话) ----------
initCreator({ show, newSession, putTemplate, newId, applySettings, apiHeaders, addMtCost });

// ---------- 设置面板 ----------
function openSettings() { showCost(); listMics(); $("#settings").hidden = false; }
// 麦克风列表:授权前浏览器不给设备名,只能显示「麦克风 1/2…」
async function listMics() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && !["default", "communications"].includes(d.deviceId)); } catch {}
  const sel = $("#micDev"), cur = store.get("micId", "");
  sel.replaceChildren(el("option", { value: "", textContent: t("opt.micDefault") }), ...devs.map((d, i) => el("option", { value: d.deviceId, textContent: d.label || t("opt.micN", { n: i + 1 }) })));
  if (cur && !devs.some((d) => d.deviceId === cur)) sel.append(el("option", { value: cur, textContent: t("opt.micMissing") }));
  sel.value = cur;
  $("#micDevHint").textContent = t(devs.length && devs.every((d) => d.label) ? "set.micDevHint" : "set.micDevNoLabel");
}
$("#micDev").onchange = () => { store.set("micId", $("#micDev").value || null); cfg.micId = $("#micDev").value; if (state.running) restartMic(); };
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listMics);
$("#openSettings").onclick = openSettings;
$("#closeSettings").onclick = () => {
  applySettings();
  // 语言只改当前会话,不动模板
  if (state.curSess && ($("#srcLang").value !== state.curSess.source || $("#tgtLang").value !== state.curSess.target)) { state.curSess.source = $("#srcLang").value; state.curSess.target = $("#tgtLang").value; saveSessions(); refreshTemplate(); }
  $("#settings").hidden = true;
  if (state.running && state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "session.update", session: sessionConfig() }));
  if (state.view === "home") renderSessions();
  if (state.view === "tpl") renderHome();
  if (state.view === "live") showEmptyHint();
};
$("#uiLang").onchange = () => {
  setUiLang($("#uiLang").value); store.set("uiLang", getUiLang());
  applyI18n(); applySettings(); listMics(); setStatus(statusKey, statusKind, statusExtra); setFollow(follow); showLat();
  $("#go").textContent = t(state.running ? "live.stop" : "live.start");
  refreshTemplate(); if (state.view === "home") renderSessions(); if (state.view === "tpl") renderHome();
};
["#asrModel", "#mtModel", "#ctModel"].forEach((s) => $(s).addEventListener("change", showModelHints));
$("#editCurTpl").onclick = () => { $("#settings").hidden = true; openCreator(sessTemplate(state.curSess) || cfg.tpl); };
["#showSrc", "#tgtSize"].forEach((s) => $(s).addEventListener("input", applySettings));
["#maxGain", "#agcTarget", "#vad", "#silence", "#prefix", "#maxTurn", "#gain"].forEach((s) => $(s).addEventListener("input", applySettings));
$("#resetAudio").onclick = () => { for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id); if (e.type === "checkbox") e.checked = d; else e.value = d; } applySettings(); };

function transcriptText() {
  return lines.filter((l) => l.src || l.tgt).map((l) => `[${l.ms != null ? fmtClock(l.ms) : l.t.toTimeString().slice(0, 8)}] ${l.tgt}\n           ${l.src}`).join("\n");
}
$("#copyAll").onclick = async (e) => {
  try { await navigator.clipboard.writeText(transcriptText()); flashBtn(e.target, t("rec.copied")); }
  catch { flashBtn(e.target, t("rec.copyFail")); }
};
$("#saveAll").onclick = () => download(fileName(state.curSess ? state.curSess.name : cfg.tpl.name) + ".txt", transcriptText());
$("#memoClear").onclick = (e) => { setMemo([]); flashBtn(e.target, t("rec.memoCleared")); };
$("#resetCost").onclick = (e) => { cost.asr = cost.mt = 0; cost.save(); showLat(); flashBtn(e.target, t("rec.costCleared")); };
let clearArmed = false;
$("#clearAll").onclick = (e) => {
  if (!clearArmed) { clearArmed = true; e.target.textContent = t("rec.clearSure"); setTimeout(() => { clearArmed = false; e.target.textContent = t("rec.clear"); }, 3000); return; }
  lines.length = 0; history.length = 0; $("#log").replaceChildren(); clearArmed = false; e.target.textContent = t("rec.clear"); setMemo([]);
  cancelSave(); bumpGen(sessKey()); state.lineStore.set(sessKey(), null); if (state.curSess) { state.curSess.count = 0; saveSessions(); } showEmptyHint();
};
// 摘要:整段记录一次发给模型;估算超过模型上下文的 40% 就按行切成几段,每段先写详细笔记,最后合并成摘要。
// 估算偏保守,接口仍报上下文超长时把每段减半重来
const CONTEXT = { "gpt-6.1-sol": 500000, "gpt-6-luna": 272000 };
async function recapCall(prompt) {
  const res = await fetch(cfg.apiBase + "/chat/completions", {
    method: "POST", headers: apiHeaders(),
    body: JSON.stringify({ model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) { const txt = await res.text(), err = new Error(res.status + " " + txt.slice(0, 200)); err.tooLong = res.status === 400 && /context|too long|maximum/i.test(txt); throw err; }
  const rd = await res.json(); addMtCost(cfg.ctModel, rd.usage);
  return rd.choices[0].message.content;
}
async function makeRecap(rows, onStep, budgetOverride = 0) {
  const tgt = tgtName(cfg.tpl.target, "en"), ctx = glossaryForLLM(cfg);
  const intro = `a live subtitle log of "${cfg.tpl.name}" (ASR + live correction; may still contain recognition errors)`;
  const final = `Write in ${tgt}, plain text:\n1. Summary (about 300 words or 300 characters): what happened, segments, highlights and important announcements (events, merchandise, release dates — list dates exactly).\n2. Section by section: split by segment/topic, give each a short heading, and rewrite the content as clear, complete prose.\n3. Uncertain points: places where the ASR may have misheard or that cannot be determined.`;
  let budget = budgetOverride || Math.floor((CONTEXT[cfg.ctModel] || 128000) * 0.4) - estTokens(ctx) - 2000;
  for (let attempt = 0; ; attempt++) {
    const parts = splitByTokens(rows, budgetOverride ? budget : Math.max(budget, 4000));
    try {
      if (parts.length === 1) return await recapCall(`Below is ${intro}. ${final}\n\nTemplate context:\n${ctx}\n\nLog (time | original | live translation):\n${rows.join("\n")}`);
      const notes = [];
      for (let i = 0; i < parts.length; i++) {
        onStep(t("rec.recapPart", { i: i + 1, n: parts.length }));
        notes.push(await recapCall(`Below is part ${i + 1} of ${parts.length} of ${intro}. Write detailed notes in ${tgt}, plain text, for a later merge into one summary: go through this part in order, split by segment/topic with the time range and a short heading, and rewrite what was said as clear prose. Keep every announcement, name, number and date exactly. End with a list of places where the ASR may have misheard.\n\nTemplate context:\n${ctx}\n\nLog (time | original | live translation):\n${parts[i].join("\n")}`));
      }
      onStep(t("rec.recapMerge", { n: parts.length }));
      return await recapCall(`Below are notes on ${parts.length} consecutive parts of ${intro}, written part by part. Merge them into one result. ${final}\n\nTemplate context:\n${ctx}\n\n` + notes.map((x, i) => `=== Part ${i + 1} of ${parts.length} ===\n${x}`).join("\n\n"));
    } catch (e) {
      if (!e.tooLong || attempt >= 3) throw e;
      budget = Math.floor(budget / 2);
    }
  }
}
$("#recap").onclick = async (e) => {
  applySettings();
  const rows = lines.filter((l) => l.src).map((l) => `${l.ms != null ? fmtClock(l.ms) : l.t.toTimeString().slice(0, 5)} | ${l.src} | ${l.tgt}`); // 文件会话用视频内时间
  if (!rows.length) { $("#recapOut").textContent = t("rec.recapEmpty"); return; }
  e.target.disabled = true; $("#recapOut").textContent = t("rec.recapBusy");
  try { $("#recapOut").textContent = await makeRecap(rows, (m) => ($("#recapOut").textContent = m)); }
  catch (err) { $("#recapOut").textContent = t("rec.recapFail") + err.message; }
  e.target.disabled = false;
};

// ---------- 启动 ----------
initSessions({ AUDIO_DEFAULTS, builtins, allTemplates, getTemplate, loadSettings, stop, fileJob, filePause, flushLines, restoreLines, loadMemo, spkPanel, history, queue, sessionConfig, bumpGen, show });
initTranslate({ queue, history, sessKey, curGen, renderLine, addMtCost, lat, mtHist, diag, showLat });
// 旧版(单一节目,subs.html)的字幕记录复制到内置模板下。旧版页面和这里同源、共用存储,所以只复制不删除
if (store.get("lines", null) && !store.get("lines.hoooope-2026", null)) store.set("lines.hoooope-2026", store.get("lines", null));
buildTicks();
applyI18n();
await loadLineStore();
migrateToSessions();
useSession(store.get("curSession", null));
setFollow(true);
setStatus("status.idle");
showLat();
show(["home", "tpl", "live", "create"].includes(store.get("view", "")) ? store.get("view", "") : "home");
// 收音中离开页面先确认(iOS 不一定弹,字幕反正已存本地)
window.addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
// 切到后台 / 关页面前把防抖中的字幕写掉(iOS 回收后台标签页时不一定有 beforeunload)
window.addEventListener("pagehide", flushLines);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushLines(); });
// 给端到端测试用的观察口(模块作用域里的状态外面看不到)
Object.assign(window, { __t: { get lines() { return lines; }, get spk() { return state.spk; }, setPickFor: (v) => (pickFor = v), subtitleFile, fileConfig, sessionConfig, makeRecap, splitByTokens, estTokens } });
