import "./style.css";
import { BUILTIN, SERVER_API, ASR_MODEL, MT_MODEL, CT_MODEL, VAD, BUILD } from "./config";
import { parseGlossary } from "./glossary";
import { fmtClock, subtitleFile } from "./subtitle";
import { estTokens, splitByTokens } from "./tokens";
import { LineStore, mergeLegacy } from "./linestore";
import { store, storageFailed, setStorageWarn, idb, lsKV } from "./storage";
import { toBase64, CHUNK, Resampler, Agc, sigStep } from "./audio";
import { getUiLang, setUiLang, t, LANGS, TARGETS, srcName, tgtName, CJK } from "./i18n";
import { extractPcm, splitTimed } from "./media";
import { asrPrompt, keywords, glossaryForLLM } from "./prompts";
import { asrCost, mtCost } from "./cost";
import { state, cfg, lines, type Line, type Session, type Template, type View } from "./state";
import type { KV } from "./linestore";
import type { Usage } from "./cost";
import type { ExtractCallbacks } from "./media";
import { $, el, flash, flashBtn, download } from "./dom";
import { initSessions, saveSessions, sget, sset, sessTemplate, newSession, useSession, refreshTemplate, migrateToSessions, fileName, renderSessions } from "./sessions";
import { initTranslate, pumpTranslate, apiHeaders, loadMemo, setMemo } from "./translate";
import { creator, openCreator, renderCreator, initCreator } from "./creator";
import { liveAudio, lineAudio } from "./live-audio";
import { initRecord, recBegin, recEnd, recUi } from "./live-record";
import { initSpeaker, spkOn, spkPrefix, paintSpk, spkPanel, spkAuto, spkAfterFile, spkRunning, spkNow } from "./speaker-ui";

// ---------- 小工具 ----------
// 存储写满 / 被禁用时的提示文案(节流在 storage.ts)
setStorageWarn((kind) => flash(t(kind === "full" ? "flash.storage" : "flash.storageOff")));

function showModelHints() { $("#asrModelHint").textContent = t("asrDesc." + $("#asrModel").value); $("#mtModelHint").textContent = t("mtDesc." + $("#mtModel").value); $("#ctModelHint").textContent = t("ctDesc." + $("#ctModel").value) + (getUiLang() === "zh" ? "" : " ") + t("set.ctModelHint"); }

// 滑动条刻度:每项列出带数字的主刻度,默认值高亮;点刻度直接跳到该值
const TICKS: Record<string, number[]> = {
  maxGain: [1, 10, 20, 30, 40, 50], agcTarget: [2, 8, 14, 20, 25], vad: [0.05, 0.2, 0.4, 0.6, 0.9],
  silence: [200, 600, 1000, 1500, 2000], maxTurn: [3, 8, 15, 20, 25, 30], prefix: [0, 300, 500, 750, 1000], tgtSize: [16, 24, 32, 40],
};
const TICK_DEF: Record<string, number> = { tgtSize: 24 }; // 不在收音设置里的滑动条的默认值
function buildTicks() {
  for (const [id, marks] of Object.entries(TICKS)) {
    const r = $("#" + id), min = Number(r.min), max = Number(r.max), def = TICK_DEF[id] ?? AUDIO_DEFAULTS[id];
    const box = el("div", { className: "ticks", ariaHidden: "true" }, ...marks.map((v) => el("span", {
      className: v === def ? "def" : "", textContent: String(v), style: `left:${((v - min) / (max - min)) * 100}%`,
      onclick: (e: Event) => { e.preventDefault(); r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); },
    })));
    r.after(box);
    // 数值标放进标签第一行(名称右侧)
    const head = r.closest("label").querySelector("span");
    const row = el("span", { className: "rhead" }); head.replaceWith(row); row.append(head, el("output", { className: "rv", id: "rv-" + id }));
  }
}
// 每个滑动条标签右侧显示当前值(带单位),和填充色一起刷新
const RANGE_UNIT: Record<string, string> = { maxGain: "u.x", silence: "u.ms", prefix: "u.ms", maxTurn: "u.s", tgtSize: "u.px" };
function updateRangeFill() {
  document.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((r) => {
    r.style.setProperty("--p", ((+r.value - +r.min) / (+r.max - +r.min)) * 100 + "%");
    const o = document.getElementById("rv-" + r.id), v = String(Number(Number(r.value).toFixed(2)));
    if (o) { o.textContent = RANGE_UNIT[r.id] ? t(RANGE_UNIT[r.id], { v }) : v; o.classList.toggle("changed", TICKS[r.id] && Number(r.value) !== (TICK_DEF[r.id] ?? AUDIO_DEFAULTS[r.id])); }
  });
}

// ---------- 界面语言 ----------
setUiLang(store.get("uiLang", /^zh/i.test(navigator.language || "") ? "zh" : "en"));
function applyI18n() {
  document.documentElement.lang = getUiLang() === "zh" ? "zh-CN" : "en";
  document.title = t("app");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((n) => (n.textContent = t(!SERVER_API && n.dataset.i18n === "set.keyHint" ? "set.keyHintByok" : n.dataset.i18n!)));
  document.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((n) => (n.placeholder = t(n.dataset.i18nPh!)));
  fillLangSelects();
  document.querySelectorAll<HTMLElement>("section.sess h3").forEach((h) => (h.dataset.chip = t("set.sessChip")));
  $("#buildVer").textContent = t("set.ver", { v: BUILD });
}

function fillLangSelects() {
  document.querySelectorAll<HTMLSelectElement>("select.srcLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(LANGS).map((c) => el("option", { value: c, textContent: srcName(c) }))); if (v) s.value = v; });
  document.querySelectorAll<HTMLSelectElement>("select.tgtLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(TARGETS).map((c) => el("option", { value: c, textContent: tgtName(c) }))); if (v) s.value = v; });
}

// ---------- 模板 ----------
// 模板 = { id, name, source, target, description, style, asrPrompt, glossary(文本) }
// 内置模板随页面更新;改过的内置模板以同 id 存在本机,可恢复内置版本
const GENERAL: Omit<Template, "name"> = { id: "general", source: "ja", target: "zh-Hans", description: "", style: "", asrPrompt: "", glossary: "" };
function builtins(): Template[] { return [...(BUILTIN as Template[]), { ...GENERAL, name: t("tpl.blank") }]; }
function userTemplates(): Template[] { return store.json("templates", []); }
function allTemplates(): Template[] {
  const user = userTemplates(), byId = new Map(user.map((x) => [x.id, x] as const));
  const out: Template[] = builtins().map((b) => (byId.has(b.id) ? { ...b, ...byId.get(b.id), builtin: true, modified: true } : { ...b, builtin: true }));
  return out.concat(user.filter((x) => !builtins().some((b) => b.id === x.id)));
}
function getTemplate(id: string): Template | undefined { return allTemplates().find((x) => x.id === id); }
function putTemplate(tp: Template): void {
  const prev = getTemplate(tp.id), voices = tp.voices !== undefined ? tp.voices : prev && prev.voices; // 编辑模板时草稿里没有声纹库,沿用原来的
  const clean = { ...(voices && Object.keys(voices).length ? { voices } : {}), id: tp.id, name: tp.name, source: tp.source, target: tp.target, description: tp.description || "", style: tp.style || "", asrPrompt: tp.asrPrompt || "", spkNotes: tp.spkNotes || "", glossary: tp.glossary || "", updatedAt: Date.now() };
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== tp.id).concat(clean)));
  if (cfg.tpl && cfg.tpl.id === tp.id) refreshTemplate();
}
function removeTemplate(id: string): void {
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== id)));
  if (cfg.tpl && cfg.tpl.id === id) refreshTemplate();
}
function newId() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// 收音参数默认值(和设置面板的控件 id 一一对应);和默认值相同就不落盘,以后改默认值设备会跟着变
const AUDIO_DEFAULTS: Record<string, string | number | boolean> = { gain: "auto", maxGain: 40, agcTarget: 14, vad: VAD, silence: 600, prefix: 300, maxTurn: 8, nr: "off", micAgc: true, micNs: false, micEc: false };
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
function sessKey(ss: Session | null = state.curSess): string { return ss ? ss.id : "none"; }
// 会话的字幕被清空、重新处理或删除时加一。在途的翻译、防抖中的保存发现代数变了就丢弃,
// 免得旧结果按 id 写到新行上(重新处理会从 id 1 重新编号),或者把已删会话的数据写回存储
const linesGen = new Map<string, number>();
function curGen(key: string): number { return linesGen.get(key) || 0; }
function bumpGen(key: string): void { linesGen.set(key, curGen(key) + 1); }
function showEmptyHint() {
  if (isFileSess()) return;
  if (lines.length || $("#log").children.length) return;
  $("#log").append(el("div", { className: "empty", id: "emptyHint", textContent: t(cfg.hasKey ? "live.empty" : "live.emptyKey") }));
}
function addLine(id: number, raw: string): Line {
  const h = $("#emptyHint"); if (h) h.remove();
  const e = el("div", { className: "row pending" }, el("div", { className: "tgt", textContent: t("line.translating") }), el("div", { className: "src", textContent: raw }));
  $("#log").append(e);
  const line: Line = { id, raw, src: raw, tgt: "", t: new Date(), el: e, done: false };
  e.onclick = () => { if (isFileSess() && line.ms != null) seekTo(line.ms); };
  lines.push(line);
  scrollEnd();
  saveLines();
  return line;
}
// 字幕存到本地(按会话分开,见 linestore.ts):刷新、误触下拉刷新、iOS 回收标签页之后打开还在
let saveLinesTimer: ReturnType<typeof setTimeout> | undefined, pendingSave: (() => void) | null = null;
function saveLines() {
  clearTimeout(saveLinesTimer);
  const ss = state.curSess, key = sessKey(ss), gen = curGen(key);
  pendingSave = () => {
    pendingSave = null;
    if (curGen(key) !== gen) return;
    state.lineStore.set(key, lines.map((l) => ({ id: l.id, raw: l.raw, src: l.src, tgt: l.tgt, t: l.t.getTime(), done: l.done, ...(l.ms != null ? { s: l.ms, e: l.endMs } : {}), ...(l.aStart != null ? { as: l.aStart, ae: l.aEnd } : {}), ...(l.spk != null ? { k: l.spk, kc: l.spc, ...(l.spkBy ? { kb: l.spkBy } : {}) } : {}) })));
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
    const line = addLine(s.id, s.raw as string);
    line.src = (s.src ?? s.ja ?? s.raw) as string; line.tgt = s.tgt ?? s.zh ?? ""; line.t = new Date(s.t as number);
    if (s.s != null) setLineTime(line, s.s, s.e as number);
    if (s.as != null) { line.aStart = s.as; line.aEnd = s.ae; }
    if (s.k != null) { line.spk = s.k; line.spc = s.kc; if (s.kb) line.spkBy = s.kb; paintSpk(line); }
    if (s.done) { line.done = true; renderLine(line, false); }
    else { line.el.className = "row"; line.el.querySelector(".tgt")!.textContent = t("line.unfinished"); }
    if (line.done && line.src) history.push(line);
    state.nextId = Math.max(state.nextId, s.id);
  }
  $("#log").append(el("div", { className: "empty sep", textContent: t("line.sep", { n: saved.length }) }));
  cancelSave(); // 只是恢复显示,不算新的活动,别改会话的最后更新时间
}
// 超长的一条(几个人的话被并成一句)按句末标点分行显示,内容不变
function breakLong(s: string): string { return s.length > (CJK.test(s) ? 40 : 90) ? s.replace(/([。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))\s*(?=\S)/g, "$1\n") : s; }
// 只有几个字的碎句(「那……」「好。」「OK.」)且紧跟上一条,就并进上一条,少占一行
const MERGE_GAP_MS = 3000;
function isShort(s: string): boolean {
  const x = s.replace(/[\s。、！？!?,.，…「」『』()（）ー〜~"']/g, "");
  return CJK.test(x) ? x.length <= 4 : s.trim().split(/\s+/).filter(Boolean).length <= 2;
}
function tryMerge(line: Line): boolean {
  if (isFileSess()) return false; // 文件会话按说话人断句:不合并,免得把不同人的话拼成一行
  const i = lines.indexOf(line), prev = lines[i - 1];
  if (i < 1 || !prev.done || !prev.tgt || !prev.el.isConnected || prev.tgt.length > 60) return false;
  if (+line.t - +(prev.tEnd || prev.t) > MERGE_GAP_MS || !isShort(line.src)) return false;
  prev.src += " " + line.src; prev.tgt += " " + line.tgt; prev.raw += " " + line.raw; prev.tEnd = line.t;
  if (line.endMs != null) prev.endMs = line.endMs;
  if (line.aEnd != null && clockLines.has(prev)) { prev.aEnd = Math.max(prev.aEnd ?? 0, line.aEnd); lineAudio(prev); }
  prev.el.querySelector(".tgt")!.textContent = breakLong(prev.tgt);
  prev.el.querySelector(".src")!.textContent = breakLong(prev.src);
  line.el.remove(); lines.splice(i, 1); saveLines(); scrollEnd();
  return true;
}
function renderLine(line: Line, merge = true): void {
  line.done = true; saveLines();
  if (!line.tgt.trim()) line.tgt = "";
  if (!line.tgt && line.failed) { line.el.className = "row"; line.el.querySelector(".tgt")!.textContent = t("line.failed"); line.el.querySelector(".src")!.textContent = breakLong(line.src || line.raw); return; }
  if (!line.tgt) {
    diag.noise++; showLat();
    // 原始识别有实际内容(不只是标点/单个语气词)就别删,灰显原文
    if (/[\p{L}]{3,}/u.test(line.raw)) { line.src = line.raw; line.el.className = "row pending"; line.el.querySelector(".tgt")!.textContent = t("line.noise"); line.el.querySelector(".src")!.textContent = line.raw; return; }
    line.el.remove(); return;
  }
  if (merge && tryMerge(line)) return;
  line.el.className = "row";
  line.el.querySelector(".tgt")!.textContent = breakLong(line.tgt);
  line.el.querySelector(".src")!.textContent = breakLong(line.src);
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
function setFollow(v: boolean): void { follow = v; const b = $("#follow"); b.textContent = t(v ? "live.follow" : "live.unfollow"); b.classList.toggle("off", !v); if (v) { userScrolled = false; scrollEnd(); } }
$("#follow").onclick = () => setFollow(!follow);

// ---------- 翻译(OpenAI Chat Completions) ----------
const queue: Line[] = [];
const history: Line[] = [];

// ---------- 识别(OpenAI Realtime 转写会话,WebSocket) ----------
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const partial = new Map<string, string>();
// 流式模型:不支持 turn_detection,整段音频只在一个 item 里不断吐 delta,没有 completed。
// 所以客户端按句末标点切句;停顿 LIVE_IDLE_MS 没新 delta 就把剩下的也当一句,并 commit 一下让服务端开新 item。
const STREAMING_ASR = new Set(["gpt-live-transcribe", "gpt-realtime-whisper"]);
const LIVE_IDLE_MS = 2000;
let liveBuf = "", liveIdle: ReturnType<typeof setTimeout> | null = null, liveUncommitted = false;
function isStreamingAsr() { return STREAMING_ASR.has(cfg.asrModel); }
function sessionConfig() {
  const streaming = isStreamingAsr();
  const transcription: { model: string; language?: string; keywords?: string[]; prompt?: string } = { model: cfg.asrModel };
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
// 本次收音(当前音频时钟)里出的行;恢复出来的行的 aStart / aEnd 是以前的时钟,合并时不能混用
let clockLines = new WeakSet<Line>();
/** tm:这一句在音频时钟上的 [起, 止](VAD 事件给的);流式模型没有,按能量切分估 */
function emitLine(text: string, tm?: [number, number]): void {
  // 只有标点/空白的碎片(比如 delta 开头单独一个「。」)丢掉
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  const line = addLine(++state.nextId, text);
  [line.aStart, line.aEnd] = tm || liveAudio.guess(); clockLines.add(line); // 不设 ms:那是文件会话的媒体时间
  diag.asr++; queue.push(line); lineAudio(line); pumpTranslate(); showLat();
}
function liveDelta(delta: string): void {
  liveBuf += delta; liveUncommitted = true;
  // 日中文只按全角句末标点断句:半角 ! ? 常出现在节目名里(EXTEND STEP HOOOOPE!);其他语言按半角句末 + 空格
  const re = ["ja", "zh"].includes(cfg.tpl.source) ? /^[\s\S]*?[。！？]+[」』）)]*/ : /^[\s\S]*?(?:[。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))/;
  let m: RegExpMatchArray | null;
  while ((m = liveBuf.match(re))) {
    emitLine(m[0].trim());
    liveBuf = liveBuf.slice(m[0].length);
  }
  liveBuf = liveBuf.replace(/^\s+/, "");
  $("#partial").textContent = liveBuf;
  clearTimeout(liveIdle ?? undefined);
  liveIdle = setTimeout(liveFlush, LIVE_IDLE_MS);
}
function liveFlush() {
  clearTimeout(liveIdle ?? undefined); liveIdle = null;
  const s = liveBuf.trim(); liveBuf = "";
  $("#partial").textContent = "";
  emitLine(s);
  // 停顿时 commit,免得一整场都堆在同一个 item 里;commit 后的 completed 文本已经按 delta 出过了,忽略
  if (liveUncommitted && state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); liveUncommitted = false; }
}
let speechSince = 0, turnEndAt = 0;
// 实时延迟显示:翻译 = 请求往返;识别 = 云端判定一句结束(或强制断句)到出识别结果,流式模型没有句末信号所以不测
const lat = { asr: 0, mt: 0, mtAvg: 0 };
const mtHist: number[] = [];
const diag = { asr: 0, noise: 0, err: 0, deltas: 0 }; // 现场排障计数
function fmtS(ms: number): string { return ms ? t("sec", { s: (ms / 1000).toFixed(1) }) : "—"; }
function showLat() {
  const asr = isStreamingAsr() ? t("lat.stream") : fmtS(lat.asr);
  const gain = state.running && !micBroken ? agc.agcGain.toFixed(agc.agcGain < 10 ? 1 : 0) + "×" : "—";
  const item = (k: string, v: string | number, cls = "") => el("span", { className: "ib " + cls }, el("span", { className: "k", textContent: t(k) }), el("b", { textContent: String(v) }));
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
  const usd = (v: number) => "$" + v.toFixed(v < 1 ? 3 : 2);
  $("#costOut").textContent = t("cost", { a: usd(cost.asr), m: usd(cost.mt), t: usd(cost.total()) });
}
function addAsrCost(seconds: number, model = cfg.asrModel): void {
  cost.asr += asrCost(seconds, model);
  if (performance.now() - costShownAt > 1000) { costShownAt = performance.now(); cost.save(); showLat(); }
}
function addMtCost(model: string, u: Usage | null | undefined, extra = 0): void {
  const usd = mtCost(model, u, extra);
  if (usd === null) return; // 没有 usage 或 ChatGPT 订阅:不计费
  cost.mt += usd;
  cost.save(); showLat();
}
setInterval(() => {
  if (!state.running || isStreamingAsr() || !speechSince || !state.ws || state.ws.readyState !== 1) return;
  if (performance.now() - speechSince > cfg.maxTurn * 1000) {
    speechSince = performance.now();
    state.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); liveAudio.forced();
  }
}, 250);
function connect() {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  setStatus("status.connecting", "warn");
  state.ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]);
  liveUncommitted = false; wsSending = false;
  state.ws.onopen = () => { state.ws!.send(JSON.stringify({ type: "session.update", session: sessionConfig() })); setStatus("status.listening", "on"); showLat(); };
  state.ws.onmessage = (ev) => {
    let m: any; try { m = JSON.parse(ev.data); } catch { return; } // 服务端事件的 JSON,字段随 type 变
    const tm = isStreamingAsr() ? null : liveAudio.event(m); // item 起止时间(音频时钟)
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
      if (text) emitLine(text, tm || undefined);
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
function setStatus(key: string, kind?: string, extra = ""): void { statusKey = key; statusKind = kind || ""; statusExtra = extra; const s = $("#status"); s.textContent = t(key) + extra; s.className = "chip" + (kind ? " " + kind : ""); }

// ---------- 麦克风 → 24 kHz PCM16 ----------
let stream: MediaStream | null = null, actx: AudioContext | null = null, tap: AudioWorkletNode | null = null, wakeLock: WakeLockSentinel | null = null;
let rs: Resampler | null = null, agc = new Agc(), gainShownAt = 0;
// 数字增益:离声源远、收音小声时放大(见 audio.ts);信息栏上的倍数每秒最多刷新一次
function applyGain(x: Float32Array): Float32Array {
  x = agc.apply(x, cfg.gain, cfg.maxGain, cfg.agcTarget);
  if (x.length && state.running && !micBroken && performance.now() - gainShownAt > 1000) { gainShownAt = performance.now(); showLat(); }
  return x;
}
// 信号格:放大后的音量分 5 格,只在格数变化时改 DOM
function setSignal(v: number): void {
  const n = sigStep(v), s = $("#signal");
  if (s.dataset.level !== String(n)) s.dataset.level = String(n);
}
let lastSampleAt = 0, wsSending = false; // wsSending:当前连接已经开始送音频(connAt 已记下)
function onSamples(input: Float32Array): void {
  if (!actx) return; // 停止后 worklet 可能还有一条消息在路上
  lastSampleAt = performance.now();
  let x = rs!.resample(input);
  x = applyGain(x);
  let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  setSignal(Math.sqrt(rms / (x.length || 1)) * 4);
  for (const pcm of rs!.chunk(x)) {
    const open = !!state.ws && state.ws.readyState === 1;
    if (open && !wsSending) { wsSending = true; liveAudio.begin(); } // 服务端的 audio_*_ms 从这一块算起
    liveAudio.push(pcm); // 不管连没连上都进缓冲,时钟不断
    if (open) { state.ws!.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) })); addAsrCost(CHUNK / 24000); }
  }
}
async function startMic() {
  // iOS Safari:AudioContext 要在点击的同步阶段建好并 resume(await 之后就不算用户手势了);
  // 也不能指定 24 kHz(和硬件采样率不一致时麦克风只出静音),统一用默认采样率再在 JS 里重采样
  const Ctx: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext; // 旧版 Safari 只有带前缀的
  actx = new Ctx(); rs = new Resampler(actx.sampleRate);
  const resumed = actx.resume().catch(() => {});
  const want = { channelCount: 1, ...cfg.mic };
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: cfg.micId ? { ...want, deviceId: { exact: cfg.micId } } : want }); }
  catch (e) {
    // 选定的麦克风拔掉了:退回系统默认,不让整个收音失败
    if (!cfg.micId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes((e as Error).name)) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: want }); flash(t("flash.micFallback"));
  }
  listMics();
  await resumed; actx!.resume().catch(() => {});
  const code = `class Tap extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("tap", Tap);`;
  await actx!.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
  const src = actx!.createMediaStreamSource(stream);
  tap = new AudioWorkletNode(actx!, "tap");
  tap.port.onmessage = (e) => onSamples(e.data);
  const mute = actx!.createGain(); mute.gain.value = 0;
  src.connect(tap); tap.connect(mute); mute.connect(actx!.destination);
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (state.running && document.visibilityState === "visible") { keepAwake(); actx && actx.resume(); } });

async function start() {
  applySettings();
  if (!cfg.hasKey) { openSettings(); $("#apiKey").focus(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices) { setStatus("status.https", "err"); flash(t("flash.https")); return; }
  try { await startMic(); } catch (e) { setStatus("status.noMic", "err"); flash(t("flash.mic") + (e as Error).message); return; }
  state.running = true; micBroken = false; lastSampleAt = performance.now();
  $("#go").textContent = t("live.stop"); $("#go").classList.add("stop");
  keepAwake();
  connect();
  recBegin(stream); recUi();
}
function stop() {
  state.running = false;
  speechSince = 0;
  clearTimeout(reconnectTimer);
  if (liveBuf) liveFlush();
  liveAudio.stop(); wsSending = false; clockLines = new WeakSet();
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  recEnd(); // 先结束录音这一段,再停麦克风
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
    recEnd(); // 流换了:旧段结束,新流上开新的一段
    if (stream) stream.getTracks().forEach((x) => x.stop());
    if (actx) actx.close().catch(() => {});
    stream = actx = tap = rs = null;
    await startMic();
    lastSampleAt = performance.now();
    recBegin(stream);
  } catch (e) {
    console.error(e);
    setStatus("status.micCant", "err");
  } finally { micRestarting = false; }
}

// ---------- 视图切换 ----------
function show(v: View): void {
  if (v === "live" && !state.curSess) v = "home";
  state.view = v; document.body.dataset.view = v;
  for (const [id, name] of [["#viewHome", "home"], ["#viewTpl", "tpl"], ["#viewLive", "live"], ["#viewCreate", "create"]]) $(id).hidden = v !== name;
  $("#toHome").hidden = v === "home"; $("#toTpl").hidden = v === "tpl";
  $("#title").textContent = v === "live" ? state.curSess!.name : v === "create" ? t(creator.editId ? "create.titleEdit" : "create.titleNew") : v === "tpl" ? t("tpl.title") : t("app");
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
/** 文件处理任务的状态(位置、时间都是毫秒;items 按转写 item_id 记一段的起止) */
interface FileJob {
  active: boolean; phase: string; sid: string | null; pcm: Int16Array | null;
  pos: number; total: number; t0: number; from: number; ws: WebSocket | null;
  items: Record<string, { s?: number; e?: number }>; pending: number; lastEnd: number; speakFrom: number | null; lastEvt: number;
  err: string; extractPct: number; loadPct?: number;
  /** 强制断句时发 commit 的位置,按顺序对应之后的 committed 事件 */
  forcedAt: number[]; commitEnd: number | null; flushAt: number;
}
const fileJob: FileJob = { active: false, phase: "idle", sid: null, pcm: null, pos: 0, total: 0, t0: 0, from: 0, ws: null, items: {}, pending: 0, lastEnd: 0, speakFrom: null, lastEvt: 0, err: "", extractPct: 0, forcedAt: [], commitEnd: null, flushAt: 0 };
function isFileSess() { return !!(state.curSess && state.curSess.kind === "file"); }
function setLineTime(line: Line, s: number, e: number): void {
  line.ms = s; line.endMs = e; line.t = new Date(MEDIA_BASE + e);
  if (!line.el.querySelector(".tm")) line.el.prepend(el("div", { className: "tm", textContent: fmtClock(s) }));
}
async function loadLineStore() {
  for (const [kv, name] of [[idb, "IndexedDB"], [lsKV, "localStorage"]] as [KV, string][]) {
    const st = new LineStore(kv, storageFailed);
    try { await st.load(); state.lineStore = st; break; } catch (e) { console.warn(name + " unavailable for subtitles", e); }
  }
  // 旧版存在 localStorage 的 slines.<id>:合并进新存储,写成功后再删,腾出空间。
  // 迁移后又用旧版记过字幕的话,两边都有,旧版那部分接在后面
  try {
    let changed = false;
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith("jls.slines."))) {
      const id = k.slice("jls.slines.".length);
      let arr = null; try { arr = JSON.parse(localStorage.getItem(k)!); } catch {}
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
let mediaUrl: string | null = null, pickFor: { tplId?: string; reattach?: string } | null = null;
// 先直接存 File;Safari 无痕模式等不让存 Blob 时,300 MB 以内改存 ArrayBuffer
async function storeMedia(id: string, f: File): Promise<boolean> {
  try { await idb.put(id, f); return true; } catch {}
  if (f.size > 300 * 1048576) return false;
  try { await idb.put(id, { name: f.name, type: f.type, buf: await f.arrayBuffer() }); return true; } catch { return false; }
}
async function loadMedia(id: string): Promise<File | null> {
  const v = await idb.get(id).catch(() => null);
  return v && v.buf ? new File([v.buf], v.name, { type: v.type }) : v || null;
}
function pickMedia(tplId: string): void { pickFor = { tplId }; $("#mediaFile").value = ""; $("#mediaFile").click(); }
$("#reattach").onclick = () => { pickFor = { reattach: state.curSess!.id }; $("#mediaFile").value = ""; $("#mediaFile").click(); };
// 新建文件会话(选文件、实时录音转文件共用);extra 覆盖默认字段
function newFileSession(tplId: string, f: File, extra: Partial<Session> = {}): Session {
  const ss = newSession(tplId);
  Object.assign(ss, { kind: "file", name: f.name.replace(/\.[^.]+$/, ""), file: { name: f.name, size: f.size, type: f.type, duration: 0 }, progress: 0, done: false }, extra);
  saveSessions(); return ss;
}
// 文件存进本地,切到这个会话
async function attachMedia(ss: Session, f: File): Promise<void> {
  state.mediaBlob = f; fileJob.pcm = null; fileJob.sid = null;
  ss.file!.stored = await storeMedia(ss.id, f);
  if (!ss.file!.stored) flash(t("file.noStore"));
  saveSessions(); useSession(ss.id); show("live");
  if (ss.done) spkAuto(ss);
}
$("#mediaFile").onchange = async () => {
  const f = $("#mediaFile").files[0]; if (!f || !pickFor) return;
  const ss = pickFor.reattach ? state.sessions.find((x) => x.id === pickFor!.reattach)! : newFileSession(pickFor.tplId!, f);
  pickFor = null;
  await attachMedia(ss, f);
};
async function setupFileView() {
  const on = isFileSess();
  document.body.classList.toggle("filemode", on);
  $("#playerBox").hidden = $("#fileBar").hidden = !on;
  recUi();
  if (!on) { $("#go").textContent = t(state.running ? "live.stop" : "live.start"); return; }
  const ss = state.curSess!;
  if (!state.mediaBlob || fileJob.sid !== ss.id) { state.mediaBlob = await loadMedia(ss.id) || (state.mediaBlob && state.mediaBlob.name === ss.file!.name && fileJob.sid == null ? state.mediaBlob : null); fileJob.sid = ss.id; fileJob.pcm = null; }
  if (state.curSess !== ss) return;
  const p = $("#player");
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = state.mediaBlob ? URL.createObjectURL(state.mediaBlob) : null;
  if (mediaUrl) p.src = mediaUrl; else p.removeAttribute("src");
  $("#playerBox").classList.toggle("audio", /^audio\//.test(ss.file!.type) || /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(ss.file!.name));
  $("#playerBox").hidden = !state.mediaBlob;
  $("#reattach").hidden = true; // 缺文件时主按钮就是「重新选择原文件」
  p.onloadedmetadata = () => { if (isFinite(p.duration) && !ss.file!.duration) { ss.file!.duration = p.duration * 1000; saveSessions(); fileProgress(); } };
  fileJob.phase = fileJob.active ? fileJob.phase : ss.done ? "done" : ss.progress ? "paused" : "idle";
  fileProgress();
}
// 播放时叠加当前字幕、高亮对应行
$("#player").ontimeupdate = () => {
  const ms = $("#player").currentTime * 1000;
  let cur: Line | null = null;
  for (const l of lines) { if (l.ms == null) continue; if (l.ms <= ms + 150 && ms <= l.endMs! + 400) cur = l; if (l.ms > ms + 150) break; }
  $("#ovl .ot").textContent = cur && cur.tgt ? spkPrefix(cur) + cur.tgt : ""; $("#ovl .os").textContent = cur ? cur.src : "";
  if (state.spkStopAt != null && ms >= state.spkStopAt) { state.spkStopAt = null; $("#player").pause(); }
  const prev = $("#log .row.active");
  if (cur && prev !== cur.el) { if (prev) prev.classList.remove("active"); cur.el.classList.add("active"); if (!$("#player").paused) cur.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  else if (!cur && prev) prev.classList.remove("active");
};
function seekTo(ms: number): void { const p = $("#player"); if (!p.src) return; state.spkStopAt = null; p.currentTime = ms / 1000; p.play().catch(() => {}); }
// extractPcm 的进度写进 fileJob,和文件翻译进度条共用
const pcmCb: ExtractCallbacks = {
  onPhase(ph) { fileJob.phase = ph; if (ph === "loading") fileJob.loadPct = 0; else fileJob.extractPct = 0; fileProgress(); },
  onLoad(p) { fileJob.loadPct = p; fileProgress(); },
  onExtract(p) { fileJob.extractPct = p; fileProgress(); },
};
// 按说话人断句时停顿 0.3 秒就断句(快速接话时换人处更容易断开),识别费用不变
function fileConfig() {
  const keep: [string, number] = [cfg.asrModel, cfg.silence]; cfg.asrModel = "gpt-transcribe"; cfg.silence = Math.min(cfg.silence, 300); // 短停顿就断句,便于区分说话人
  const c = sessionConfig(); [cfg.asrModel, cfg.silence] = keep; return c;
}
async function fileStart() {
  const ss = state.curSess!;
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
  } catch (e) { fileJob.active = false; fileJob.phase = "error"; fileJob.err = (e as Error).message; setGoFile(); fileProgress(); setStatus("status.paused", "err"); return; }
  if (!fileJob.active || state.curSess !== ss) return;
  fileJob.total = fileJob.pcm!.length / 24; ss.file!.duration = fileJob.total; saveSessions();
  fileJob.from = fileJob.pos = Math.min(ss.progress || 0, fileJob.total); fileJob.items = {}; fileJob.pending = 0; fileJob.forcedAt = []; fileJob.commitEnd = null; fileJob.lastEnd = fileJob.from; fileJob.speakFrom = null; fileJob.phase = "run";
  fileConnect(ss);
}
function fileConnect(ss: Session): void {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  const ws2 = (fileJob.ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]));
  const J = fileJob, off = J.from; // 转写会话里的 audio_*_ms 从本次连接开始送的第一帧算起
  ws2.onopen = () => { ws2.send(JSON.stringify({ type: "session.update", session: fileConfig() })); J.t0 = performance.now(); J.lastEvt = performance.now(); filePump(ws2, ss); };
  ws2.onmessage = (ev) => {
    let m: any; try { m = JSON.parse(ev.data); } catch { return; } // 服务端事件的 JSON
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
function filePump(ws2: WebSocket, ss: Session): void {
  const J = fileJob, CHUNK_MS = 100, N = 2400;
  const tick = () => {
    if (!J.active || J.ws !== ws2 || ws2.readyState !== 1) return;
    const target = Math.min(J.total, J.from + (performance.now() - J.t0) * FILE_SPEED);
    while (J.pos < target) {
      const i = Math.round(J.pos * 24), chunk = J.pcm!.subarray(i, Math.min(i + N, J.pcm!.length));
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
function emitTimed(text: string, s: number, e: number): void {
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  // 一段里有几句就拆开,时间按字数比例分
  for (const p of splitTimed(text, s, e, ["ja", "zh"].includes(cfg.tpl.source))) {
    diag.asr++; const line = addLine(++state.nextId, p.text); setLineTime(line, Math.round(p.s), Math.round(p.e)); queue.push(line);
    const j = lines.findIndex((l) => l !== line && l.ms != null && l.ms > line.ms!);
    if (j >= 0) { lines.splice(lines.indexOf(line), 1); lines.splice(j, 0, line); lines[j + 1].el.before(line.el); }
  }
  pumpTranslate(); showLat(); saveLines();
}
function fileFinish(ss: Session): void {
  const J = fileJob;
  J.active = false; J.phase = "done"; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  ss.done = true; ss.progress = J.total; saveSessions();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus("status.done", "on"); fileProgress();
  spkAfterFile(ss); // 开着说话人识别:自动识别;之前识别过:先按已有声纹结果标注新字幕,GPT 判定重做
}
function filePause(isErr?: boolean): void {
  const J = fileJob;
  J.active = false; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  J.phase = isErr ? "error" : "paused";
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus(isErr ? "status.paused" : "status.paused", isErr ? "err" : "warn"); fileProgress();
}
function setGoFile() {
  if (!isFileSess()) return;
  const ss = state.curSess!, g = $("#go");
  if (g.dataset.armed) return;
  g.textContent = t(fileJob.active ? "file.pause" : !state.mediaBlob ? "file.reattach" : ss.done ? "file.redo" : ss.progress ? "file.resume" : "file.start");
  g.classList.toggle("stop", fileJob.active);
  g.classList.toggle("redo", !fileJob.active && !!ss.done);
}
function fileProgress() {
  if (!isFileSess()) return;
  const ss = state.curSess!, J = fileJob, total = J.total || (ss.file && ss.file.duration) || 0;
  const done = lines.filter((l) => l.done).length, n = lines.length, pos = J.active ? J.pos : ss.progress || 0;
  let pct = total ? pos / total : 0, txt: string;
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
const makeSubs = (kind: "srt" | "vtt") => subtitleFile(kind, lines, $("#showSrc").checked, spkPrefix);
$("#expSrt").onclick = () => download(fileName(state.curSess!.name) + ".srt", makeSubs("srt"), "application/x-subrip");
$("#expVtt").onclick = () => download(fileName(state.curSess!.name) + ".vtt", makeSubs("vtt"), "text/vtt");


// ---------- 说话人识别(在 speaker-ui.ts) ----------
initSpeaker({ sget, sset, fileJob, pcmCb, fileProgress, isFileSess, seekTo, saveLines, getTemplate, putTemplate, applySettings, apiHeaders, addMtCost, openSettings });

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
    const btn = (key: string, fn: () => void, primary: boolean, icon: string) => el("button", { className: "btn" + (primary ? " primary" : "") + " i-" + icon, textContent: t(key), onclick: fn });
    const btns = el("div", { className: "btns" },
      btn("card.open", () => { newSession(tp.id); show("live"); }, true, "play"),
      btn("card.file", () => pickMedia(tp.id), false, "film"),
      btn("card.edit", () => openCreator(tp), false, "edit"),
      btn("card.dup", () => { putTemplate({ ...tp, id: newId(), name: tp.name + t("card.copy") }); renderHome(); }, false, "copy"),
      btn("card.export", () => exportTemplate(tp), false, "download"));
    if (!tp.builtin || tp.modified) {
      const del: HTMLButtonElement = btn(tp.builtin ? "card.reset" : "card.del", () => {
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
function exportTemplate(tp: Template): void {
  const { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, voices } = tp;
  download((name || "template").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) + ".json",
    JSON.stringify({ format: "tsuji-template", version: 1, template: { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, ...(voices ? { voices } : {}) } }, null, 2), "application/json");
}
$("#importTpl").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e: Event) => {
  const input = e.target as HTMLInputElement, f = input.files![0]; input.value = "";
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
  let devs: MediaDeviceInfo[] = [];
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
  recUi(); refreshTemplate(); if (state.view === "home") renderSessions(); if (state.view === "tpl") renderHome();
};
["#asrModel", "#mtModel", "#ctModel"].forEach((s) => $(s).addEventListener("change", showModelHints));
$("#editCurTpl").onclick = () => { $("#settings").hidden = true; openCreator(sessTemplate(state.curSess) || cfg.tpl); };
["#showSrc", "#tgtSize"].forEach((s) => $(s).addEventListener("input", applySettings));
["#maxGain", "#agcTarget", "#vad", "#silence", "#prefix", "#maxTurn", "#gain"].forEach((s) => $(s).addEventListener("input", applySettings));
$("#resetAudio").onclick = () => { for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id); if (e.type === "checkbox") e.checked = d; else e.value = d; } applySettings(); };

function transcriptText() {
  return lines.filter((l) => l.src || l.tgt).map((l) => `[${l.ms != null ? fmtClock(l.ms) : l.t.toTimeString().slice(0, 8)}] ${l.tgt}\n           ${l.src}`).join("\n");
}
$("#copyAll").onclick = async (e: MouseEvent) => {
  const b = e.target as HTMLElement;
  try { await navigator.clipboard.writeText(transcriptText()); flashBtn(b, t("rec.copied")); }
  catch { flashBtn(b, t("rec.copyFail")); }
};
$("#saveAll").onclick = () => download(fileName(state.curSess ? state.curSess.name : cfg.tpl.name) + ".txt", transcriptText());
$("#memoClear").onclick = (e: MouseEvent) => { setMemo([]); flashBtn(e.target as HTMLElement, t("rec.memoCleared")); };
$("#resetCost").onclick = (e: MouseEvent) => { cost.asr = cost.mt = 0; cost.save(); showLat(); flashBtn(e.target as HTMLElement, t("rec.costCleared")); };
let clearArmed = false;
$("#clearAll").onclick = (e: MouseEvent) => {
  const b = e.target as HTMLElement;
  if (!clearArmed) { clearArmed = true; b.textContent = t("rec.clearSure"); setTimeout(() => { clearArmed = false; b.textContent = t("rec.clear"); }, 3000); return; }
  lines.length = 0; history.length = 0; $("#log").replaceChildren(); clearArmed = false; b.textContent = t("rec.clear"); setMemo([]);
  cancelSave(); bumpGen(sessKey()); state.lineStore.set(sessKey(), null); if (state.curSess) { state.curSess.count = 0; saveSessions(); } showEmptyHint();
};
// 摘要:整段记录一次发给模型;估算超过模型上下文的 40% 就按行切成几段,每段先写详细笔记,最后合并成摘要。
// 估算偏保守,接口仍报上下文超长时把每段减半重来
const CONTEXT: Record<string, number> = { "gpt-6.1-sol": 500000, "gpt-6-luna": 272000 };
async function recapCall(prompt: string): Promise<string> {
  const res = await fetch(cfg.apiBase + "/chat/completions", {
    method: "POST", headers: apiHeaders(),
    body: JSON.stringify({ model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) { const txt = await res.text(), err: Error & { tooLong?: boolean } = new Error(res.status + " " + txt.slice(0, 200)); err.tooLong = res.status === 400 && /context|too long|maximum/i.test(txt); throw err; }
  const rd = await res.json(); addMtCost(cfg.ctModel, rd.usage);
  return rd.choices[0].message.content;
}
async function makeRecap(rows: string[], onStep: (msg: string) => void, budgetOverride = 0): Promise<string> {
  const tgt = tgtName(cfg.tpl.target, "en"), ctx = glossaryForLLM(cfg);
  const intro = `a live subtitle log of "${cfg.tpl.name}" (ASR + live correction; may still contain recognition errors)`;
  const final = `Write in ${tgt}, plain text:\n1. Summary (about 300 words or 300 characters): what happened, segments, highlights and important announcements (events, merchandise, release dates — list dates exactly).\n2. Section by section: split by segment/topic, give each a short heading, and rewrite the content as clear, complete prose.\n3. Uncertain points: places where the ASR may have misheard or that cannot be determined.`;
  let budget = budgetOverride || Math.floor((CONTEXT[cfg.ctModel] || 128000) * 0.4) - estTokens(ctx) - 2000;
  for (let attempt = 0; ; attempt++) {
    const parts = splitByTokens(rows, budgetOverride ? budget : Math.max(budget, 4000));
    try {
      if (parts.length === 1) return await recapCall(`Below is ${intro}. ${final}\n\nTemplate context:\n${ctx}\n\nLog (time | original | live translation):\n${rows.join("\n")}`);
      const notes: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        onStep(t("rec.recapPart", { i: i + 1, n: parts.length }));
        notes.push(await recapCall(`Below is part ${i + 1} of ${parts.length} of ${intro}. Write detailed notes in ${tgt}, plain text, for a later merge into one summary: go through this part in order, split by segment/topic with the time range and a short heading, and rewrite what was said as clear prose. Keep every announcement, name, number and date exactly. End with a list of places where the ASR may have misheard.\n\nTemplate context:\n${ctx}\n\nLog (time | original | live translation):\n${parts[i].join("\n")}`));
      }
      onStep(t("rec.recapMerge", { n: parts.length }));
      return await recapCall(`Below are notes on ${parts.length} consecutive parts of ${intro}, written part by part. Merge them into one result. ${final}\n\nTemplate context:\n${ctx}\n\n` + notes.map((x, i) => `=== Part ${i + 1} of ${parts.length} ===\n${x}`).join("\n\n"));
    } catch (e) {
      if (!(e as { tooLong?: boolean }).tooLong || attempt >= 3) throw e;
      budget = Math.floor(budget / 2);
    }
  }
}
$("#recap").onclick = async (e: MouseEvent) => {
  const b = e.target as HTMLButtonElement;
  applySettings();
  const rows = lines.filter((l) => l.src).map((l) => `${l.ms != null ? fmtClock(l.ms) : l.t.toTimeString().slice(0, 5)} | ${l.src} | ${l.tgt}`); // 文件会话用视频内时间
  if (!rows.length) { $("#recapOut").textContent = t("rec.recapEmpty"); return; }
  b.disabled = true; $("#recapOut").textContent = t("rec.recapBusy");
  try { $("#recapOut").textContent = await makeRecap(rows, (m) => ($("#recapOut").textContent = m)); }
  catch (err) { $("#recapOut").textContent = t("rec.recapFail") + (err as Error).message; }
  b.disabled = false;
};

// ---------- 启动 ----------
// init* 必须在下面第一个 await 之前调用:在那之前模块代码同步执行,点击等事件回调插不进来,不会用到还没注入依赖的模块
initSessions({ AUDIO_DEFAULTS, builtins, allTemplates, getTemplate, loadSettings, stop, fileJob, filePause, flushLines, restoreLines, loadMemo, spkPanel, history, queue, sessionConfig, bumpGen, show });
// 录音转文件会话:同一模板、同样的语言
initRecord({ saveSessions, getStream: () => stream, audioNow: () => liveAudio.now(), toFileSession: async (live, f) => { const ss = newFileSession(live.tplId, f, { source: live.source, target: live.target, fromLive: live.id }); await attachMedia(ss, f); return ss; } });
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
show(["home", "tpl", "live", "create"].includes(store.get("view", "")) ? store.get("view", "") as View : "home");
// 收音中离开页面先确认(iOS 不一定弹,字幕反正已存本地)
window.addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
// 切到后台 / 关页面前把防抖中的字幕写掉(iOS 回收后台标签页时不一定有 beforeunload)
window.addEventListener("pagehide", flushLines);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushLines(); });
// 给端到端测试用的观察口(模块作用域里的状态外面看不到)
Object.assign(window, { __t: { get lines() { return lines; }, get spk() { return state.spk; }, liveAudio, setPickFor: (v: typeof pickFor) => (pickFor = v), subtitleFile, fileConfig, sessionConfig, makeRecap, splitByTokens, estTokens } });
