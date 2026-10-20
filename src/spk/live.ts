// 实时说话人流水线:每句实时字幕的音频段 → CAM++ 声纹(同时只算一段)→ 在线分组(live-core.ts)→ 组质心对照声纹库 → 字幕上的彩色标签。
// 字幕从不等它:标签在声纹算完后才补上,之后重新聚类、改名时就地改 DOM。组存 IndexedDB「lspk:<会话 id>」(质心 base64),
// 每句的标签随字幕存(saveLines 的 lg / ln / ls / lc)。spk/live-judge.ts 通过 liveSpk() 的接口读组、提名字
import { liveAudio, onLineAudio } from "../live-audio";
import { loadModel, embed } from "./engine";
import { SPK_DIM, spkNorm } from "./core";
import { LIVE_SPK, LiveCore, letterOf, liveLibEntries, f32b64, b64f32 } from "./live-core";
import type { LiveLibEntry, SavedGroups } from "./live-core";
import { detectCue } from "./live-schedule";
import type { NameSrc } from "./live-schedule";
import { state, cfg, lines } from "../state";
import type { Line, LiveLabel, Template } from "../state";
import { idb } from "../storage";
import { $, el } from "../dom";
import { t, CJK } from "../i18n";
import { spkOn, SPK_COLORS } from "../speaker-ui";
import { fmtClock } from "../subtitle";

// ---------- 对外接口(docs/live-speaker.md) ----------
export interface LiveGroup { id: number; letter: string; name: string | null; src: NameSrc | null; cent: Float32Array; dur: number; n: number; visible: boolean }
export interface LiveSpkApi {
  /** 已显示的组 */
  groups(): LiveGroup[];
  /** 本次收音里 aStart >= at 的行 */
  linesSince(at: number): { id: number; text: string; g: number | null; aStart: number }[];
  /** 有声音但没标上组的行 */
  uncertain(): number;
  /** 最近一小时的事件(墙钟毫秒) */
  events(): { kind: "new-group" | "merge" | "split" | "cue"; at: number }[];
  /** 按名字来源优先级(applyNames)给组起名 */
  propose(p: { id: number; name: string; src: NameSrc }[]): { changed: boolean };
}

export interface LiveSpkDeps {
  saveLines(): void;
  getTemplate(id: string): Template | undefined;
  putTemplate(tp: Template): void;
  isFileSess(): boolean;
}
let D: LiveSpkDeps;

let core = new LiveCore(), sid: string | null = null, gen = 0;
/** 收音中且开着说话人识别 */
let running = false;
let ready = false, loading = false, loadPct = 0, errMsg = "", savedMsg = "";
/** 模型加载失败:不再排队(重试成功或下次开始收音再说);loadFails = 连续失败次数 */
let failed = false, loadFails = 0, retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 加载失败后隔多久重试(毫秒),用完就等下次开始收音 */
const LOAD_RETRY = [2000, 8000, 30_000];
/** 这个会话存的组:0 还没读(说话人识别关着时不读)、1 在读、2 读完。读完才处理新句子、才存 */
let lstate = 2;
const queue: { line: Line; pcm?: Float32Array | null }[] = [];
let busy = false, lastRecluster = 0, clockStop = 0, saveTimer: ReturnType<typeof setTimeout> | undefined, pendingSave: (() => void) | null = null;
let tick: ReturnType<typeof setInterval> | undefined;
/** 本次收音里出的行 */
let runLines = new Set<Line>();
let cues: number[] = [];
/** 测试 / 测速用:每句的标签历史(音频时钟)、积压和延迟 */
const hist = new Map<number, { at: number; label: string | null }[]>();
const perf = { n: 0, lagMax: 0, lagSum: 0, dropped: 0, skipped: 0, qMax: 0, embedMs: 0 };

const clock = () => (state.running ? liveAudio.now() : clockStop);
const color = (g: number) => SPK_COLORS[g % SPK_COLORS.length];
const labelOf = (x: LiveLabel | undefined) => (x && x.g != null ? x.name || letterOf(x.g) : null);
function lib(): LiveLibEntry[] { return liveLibEntries(cfg.tpl && cfg.tpl.voices); }

// ---------- 标签 ----------
/** 字幕上的标签:有名字显示名字,否则组字母;g 为 null 不显示。点一下给这一组起名 */
export function paintLive(l: Line): void {
  const x = l.lspk; let w = l.el.querySelector<HTMLButtonElement>(".lwho");
  if (!x || x.g == null) { if (w) w.remove(); return; }
  if (!w) { w = el("button", { type: "button", className: "who lwho" }); l.el.prepend(w); }
  const g = x.g;
  w.textContent = x.name || letterOf(g); w.style.setProperty("--c", color(g));
  w.classList.toggle("ai", x.src === "gpt-guess"); w.title = x.src ? t("lspk.src." + x.src) : "";
  w.onclick = (e) => { e.stopPropagation(); openPick(g, w!); };
}
/** 按当前分组刷新每行的标签,有变化才改 DOM 和存储 */
function paintAll() {
  let dirty = false;
  for (const l of lines) {
    const lab = core.label(l.id), old = l.lspk;
    let nx: LiveLabel | undefined = old;
    if (lab) { const g = core.group(lab.g); nx = { g: lab.g, name: g ? g.name : null, src: g ? g.src : null, conf: lab.conf }; }
    else if (old && old.g != null) { const g = core.group(old.g); if (g) nx = { ...old, name: g.name, src: g.src }; } // 以前的行(刷新前、上次收音)
    if (!nx || (old && old.g === nx.g && old.name === nx.name && old.src === nx.src && old.conf === nx.conf)) continue;
    const changed = labelOf(old) !== labelOf(nx);
    l.lspk = nx; dirty = true;
    if (changed || !old) { paintLive(l); note(l); }
  }
  if (dirty) D.saveLines();
}
function note(l: Line) {
  const h = hist.get(l.id) || [], lb = labelOf(l.lspk);
  if (!h.length || h[h.length - 1].label !== lb) h.push({ at: clock(), label: lb });
  hist.set(l.id, h);
}
function save() {
  clearTimeout(saveTimer);
  const s = sid, c = core;
  if (!s || lstate !== 2) { pendingSave = null; return; }
  // 会话已经删了(或换了)就不写,免得留下孤立的 lspk:<id>
  pendingSave = () => { pendingSave = null; if (sid === s && c === core && state.sessions.some((x) => x.id === s)) idb.put("lspk:" + s, c.save()).catch(() => {}); };
  saveTimer = setTimeout(pendingSave, 600);
}
/** 切换会话、关页面前:把还在防抖里的组立刻写掉(main.ts 的 flushLines 也调用) */
export function liveSpkFlush(): void { clearTimeout(saveTimer); if (pendingSave) pendingSave(); }

// ---------- 流水线 ----------
function cut(l: Line): Float32Array | null {
  if (l.aStart == null || l.aEnd == null) return null;
  return liveAudio.slice(l.aStart, Math.min(l.aEnd, l.aStart + LIVE_SPK.maxSeg * 1000));
}
function onLine(l: Line) {
  if (!running) return;
  if (!runLines.has(l)) {
    runLines.add(l);
    if (detectCue(l.src || l.raw, cfg.tpl.source, cfg.glossary.people)) cues.push(Date.now());
  }
  if (failed) return; // 模型加载失败:不排队,队列不会越积越长
  if (!queue.some((q) => q.line === l)) queue.push({ line: l });
  perf.qMax = Math.max(perf.qMax, queue.length);
  pump();
}
async function pump() {
  if (busy || !ready || lstate !== 2) return;
  busy = true; const g0 = gen;
  try {
    while (queue.length && gen === g0) {
      // 积压太多:丢掉队首结束已超过 maxLag 的(停止收音时已经切好的不丢)
      while (queue.length && queue[0].pcm === undefined && clock() - (queue[0].line.aEnd ?? 0) > LIVE_SPK.maxLag) { queue.shift(); perf.dropped++; }
      const q = queue.shift(); if (!q) break;
      const l = q.line, pcm = q.pcm === undefined ? cut(l) : q.pcm;
      if (!pcm) { perf.skipped++; continue; } // 已经被挤出缓冲
      if (!lines.includes(l)) continue; // 并进上一句了
      if (pcm.length < LIVE_SPK.minDur * 16000) { l.lspk = { g: null, name: null, src: null, conf: 0 }; paintLive(l); note(l); D.saveLines(); continue; }
      const t0 = performance.now();
      let vec: Float32Array;
      try { vec = await embed(pcm); } catch (e) { console.error(e); errMsg = (e as Error).message || String(e); ui(); continue; }
      if (gen !== g0) break;
      perf.embedMs += performance.now() - t0;
      const ids = new Set(lines.map((x) => x.id));
      for (const s of [...core.segs]) if (!ids.has(s.line)) core.drop(s.line);
      core.deferNew = lib().length > 0;
      core.add(l.id, pcm.length / 16000, vec, Date.now());
      if (core.due(Date.now(), lastRecluster)) recluster();
      core.nameFromLibrary(lib());
      paintAll(); save();
      if (state.running && l.aEnd != null) { const lag = clock() - l.aEnd; perf.n++; perf.lagSum += lag; perf.lagMax = Math.max(perf.lagMax, lag); }
    }
    // 收音停了、队列做完:最后整体聚一次
    if (gen === g0 && !running && !queue.length && core.fresh) { recluster(); core.nameFromLibrary(lib()); paintAll(); save(); }
  } finally { busy = false; }
  // gen 变了(切会话、关了又开)时队列里可能已经是新一轮的句子:不管 gen,有就接着做
  if (queue.length) pump();
  else ui();
}
function recluster() { core.recluster(Date.now()); lastRecluster = Date.now(); }
// 没有新句子时也按时间整体重新聚类(每 reclusterMs 一次,有新片段才做);只在收音且开着说话人识别时跑
function ticking(on: boolean) {
  clearInterval(tick); tick = undefined;
  if (on) tick = setInterval(() => { if (running && !busy && lstate === 2 && core.due(Date.now(), lastRecluster)) { recluster(); core.nameFromLibrary(lib()); paintAll(); save(); } }, 5000);
}
function ensureModel() {
  if (ready || loading) return;
  clearTimeout(retryTimer);
  loading = true; failed = false; loadPct = 0; errMsg = ""; ui();
  loadModel((p) => { loadPct = p; ui(); })
    .then(() => { ready = true; loadFails = 0; pump(); }, (e) => {
      console.error(e); errMsg = (e as Error).message || String(e); failed = true; queue.length = 0;
      // 退避重试几次;都失败就等下次开始收音
      const wait = LOAD_RETRY[loadFails++];
      if (wait != null) retryTimer = setTimeout(() => { if (running) ensureModel(); }, wait);
    })
    .finally(() => { loading = false; ui(); });
}
/** 读回这个会话存的组(只读一次;读完才开始处理句子) */
function loadGroups() {
  const s = sid, c = core;
  if (!s || lstate !== 0) return;
  lstate = 1;
  idb.get("lspk:" + s).then((rec) => { if (sid === s && core === c && rec) { c.load(rec as SavedGroups); paintAll(); } }).catch(() => {})
    .finally(() => { if (sid === s && core === c) { lstate = 2; pump(); ui(); } });
}

// ---------- 生命周期(main.ts 调用) ----------
/** 切换会话(restoreLines 里):清掉上一个会话的状态,读回这个会话存的组 */
export function liveSpkSession(): void {
  liveSpkFlush();
  gen++; queue.length = 0; core = new LiveCore(); running = false; ticking(false); runLines = new Set(); cues = []; hist.clear(); savedMsg = ""; closePick();
  const ss = state.curSess; sid = ss && ss.kind !== "file" ? ss.id : null;
  lstate = sid ? 0 : 2;
  $("#lspkSaveBox").hidden = true;
  if (spkOn()) loadGroups(); // 说话人识别关着就不读,打开时再读
  ui();
}
/** 开始收音时(开着说话人识别才真正启动;模型在后台加载) */
export function liveSpkStart(): void {
  if (!sid || !state.curSess || state.curSess.id !== sid || !spkOn() || running) return;
  running = true; runLines = new Set(); savedMsg = ""; $("#lspkSaveBox").hidden = true;
  if (failed && !loading) loadFails = 0; // 上次加载失败:这次开始收音再试一轮
  loadGroups(); ensureModel(); ticking(true); ui();
}
/** 停止收音时(在 liveAudio.stop() 之前):还在排队的句子先把音频切出来,停了也能算完 */
export function liveSpkStop(): void {
  if (!running) return;
  clockStop = liveAudio.now();
  for (const q of queue) if (q.pcm === undefined) q.pcm = cut(q.line);
  running = false; ticking(false); clearTimeout(retryTimer); pump(); ui();
}
/** 设置里开关说话人识别 */
export function liveSpkToggle(on: boolean): void {
  if (on) { loadGroups(); if (state.running) liveSpkStart(); }
  else if (running) { running = false; queue.length = 0; gen++; ticking(false); clearTimeout(retryTimer); }
  ui();
}
/** 清空记录:组也清掉 */
export function liveSpkClear(): void {
  clearTimeout(saveTimer); pendingSave = null; // 防抖里的是清空前的组:不写,下面直接删
  gen++; queue.length = 0; core = new LiveCore(); hist.clear(); cues = []; runLines = new Set(); closePick();
  lstate = 2;
  if (sid) idb.del("lspk:" + sid).catch(() => {});
  $("#lspkSaveBox").hidden = true; ui();
}
/** 导出用:已知的名字(没名字、关着说话人识别时为空) */
export function liveSpkPrefix(l: Line): string {
  const nm = l.lspk && l.lspk.g != null && l.lspk.name;
  return nm && spkOn() ? nm + (CJK.test(l.tgt || l.src || "") ? "：" : ": ") : "";
}

// ---------- 接口 ----------
const api: LiveSpkApi = {
  groups: () => core.visible().map((g) => ({ id: g.id, letter: letterOf(g.id), name: g.name, src: g.src, cent: g.cent, dur: g.dur, n: g.n, visible: true })),
  linesSince(at) {
    const cur = new Set(lines);
    return [...runLines].filter((l) => cur.has(l) && l.aStart != null && l.aStart >= at).sort((a, b) => a.aStart! - b.aStart!)
      .map((l) => ({ id: l.id, text: l.src || l.raw, g: l.lspk ? l.lspk.g : null, aStart: l.aStart! }));
  },
  uncertain() { const cur = new Set(lines); let n = 0; for (const l of runLines) if (cur.has(l) && l.lspk && l.lspk.g == null) n++; return n; },
  events() {
    const now = Date.now(); cues = cues.filter((x) => x > now - LIVE_SPK.eventsMs);
    return [...core.recent(now).map((e) => ({ kind: e.kind, at: e.at })), ...cues.map((at) => ({ kind: "cue" as const, at }))].sort((a, b) => a.at - b.at);
  },
  propose(p) {
    const ch = core.propose(p);
    if (ch.length) { paintAll(); save(); ui(); }
    return { changed: ch.length > 0 };
  },
};
/** 实时说话人识别没开或没在跑时为 null */
export function liveSpk(): LiveSpkApi | null { return running && spkOn() ? api : null; }
/** 端到端测试的观察口 */
export const liveSpkDebug = { get core() { return core; }, hist, perf, get queue() { return queue.length; }, get busy() { return busy; }, get ready() { return ready; }, api, rename: (id: number, nm: string | null) => { if (core.rename(id, nm)) { paintAll(); save(); ui(); } } };

// ---------- 界面:进度 / 存声纹 ----------
function ui() {
  const bar = $("#lspkBar"); if (!bar) return;
  const live = !!sid && !D.isFileSess() && spkOn(), named = core.visible().filter((g) => g.name);
  let msg = "";
  if (live && loading) msg = t("lspk.loading", { pct: Math.round(loadPct * 100) });
  else if (live && errMsg) msg = t("lspk.err", { m: errMsg });
  else if (live && savedMsg) msg = savedMsg;
  else if (live && !state.running && named.length) msg = t("lspk.named", { names: named.map((g) => g.name).join(getSep()) });
  bar.hidden = !msg; $("#lspkInfo").textContent = msg;
  $("#lspkSave").hidden = !(live && !state.running && named.length && !loading);
}
const getSep = () => (CJK.test(t("lspk.save")) ? "、" : ", ");
function openSave() {
  const box = $("#lspkSaveBox"), named = core.visible().filter((g) => g.name);
  if (!box.hidden || !named.length) { box.hidden = true; return; }
  const checks = named.map((g) => el("input", { type: "checkbox", checked: g.src === "manual" || g.src === "gpt-evidence" || g.src === "library", value: String(g.id) }));
  box.replaceChildren(
    el("div", { className: "hint", textContent: t("lspk.saveHint") }),
    ...named.map((g, i) => el("label", { className: "check" }, checks[i], " ", el("i", { className: "dot", style: "--c:" + color(g.id) }), `${g.name} · ${letterOf(g.id)} · ${fmtClock(g.dur * 1000)} · ${t("lspk.src." + g.src)}`)),
    el("div", { className: "btns" },
      el("button", { className: "btn primary i-download", id: "lspkSaveDo", textContent: t("lspk.saveDo"), onclick: () => { saveVoices(checks.filter((c) => c.checked).map((c) => Number(c.value))); box.hidden = true; } }),
      el("button", { className: "btn", textContent: t("lspk.cancel"), onclick: () => { box.hidden = true; } })));
  box.hidden = false;
}
/** 选中的组存进模板声纹库:按名字合并,作为 src: "live" 的 alt(和已有的 live alt 按时长加权合并);库里没这个人时 v 只占位(d = 0) */
function saveVoices(ids: number[]) {
  const tp = D.getTemplate(cfg.tpl.id); if (!tp) return;
  const voices = { ...(tp.voices || {}) }, acc: Record<string, { v: Float32Array; d: number }> = {};
  for (const id of ids) {
    const g = core.group(id); if (!g || !g.name) continue;
    const a = (acc[g.name] ||= { v: new Float32Array(SPK_DIM), d: 0 });
    for (let i = 0; i < SPK_DIM; i++) a.v[i] += g.cent[i] * g.dur;
    a.d += g.dur;
  }
  for (const [nm, a] of Object.entries(acc)) {
    const old = voices[nm], alts = [...((old && old.alts) || [])], k = alts.findIndex((x) => x.src === "live");
    if (k >= 0) { const ov = b64f32(alts[k].v); for (let i = 0; i < SPK_DIM; i++) a.v[i] += ov[i] * alts[k].d; a.d += alts[k].d; }
    const alt = { v: f32b64(spkNorm(a.v)), d: Math.round(a.d), src: "live" as const };
    if (k >= 0) alts[k] = alt; else alts.push(alt);
    voices[nm] = old ? { ...old, alts } : { v: alt.v, d: 0, alts };
  }
  if (!Object.keys(acc).length) return;
  D.putTemplate({ ...tp, voices });
  savedMsg = t("lspk.saved", { names: Object.keys(acc).join(getSep()) }); ui();
}

// ---------- 界面:给组起名 ----------
let pickEl: HTMLElement | null = null;
function outside(e: Event) { if (pickEl && !pickEl.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".lwho")) closePick(); }
function closePick() { if (pickEl) pickEl.remove(); pickEl = null; document.removeEventListener("pointerdown", outside, true); }
function openPick(id: number, anchor: HTMLElement) {
  closePick();
  const g = core.group(id); if (!g) return;
  const names = [...new Set([...cfg.glossary.people.map((p) => p.src), ...Object.keys((cfg.tpl && cfg.tpl.voices) || {})].map((s) => s.trim()).filter(Boolean))];
  const pick = (nm: string | null) => { if (core.rename(id, nm)) { paintAll(); save(); ui(); } closePick(); };
  const inp = el("input", { type: "text", placeholder: t("lspk.otherPh"), hidden: true });
  const ok = el("button", { className: "btn primary", textContent: t("lspk.ok"), hidden: true, onclick: () => { if (inp.value.trim()) pick(inp.value); } });
  inp.onkeydown = (e) => { if (e.key === "Enter") ok.click(); if (e.key === "Escape") closePick(); };
  const other: HTMLButtonElement = el("button", { className: "btn", textContent: t("lspk.other"), onclick: () => { other.hidden = true; inp.hidden = ok.hidden = false; inp.focus(); } });
  const box = pickEl = el("div", { id: "lspkPick", className: "card" },
    el("div", { className: "hint", textContent: t("lspk.who", { g: g.name || letterOf(id) }) }),
    el("div", { className: "btns names" }, ...names.map((nm) => el("button", { className: "btn" + (nm === g.name ? " primary" : ""), textContent: nm, onclick: () => pick(nm) })), other),
    el("div", { className: "btns other" }, inp, ok),
    el("div", { className: "btns" },
      g.name ? el("button", { className: "btn", id: "lspkClearName", textContent: t("lspk.clear"), onclick: () => pick(null) }) : null,
      el("button", { className: "btn", textContent: t("lspk.close"), onclick: closePick })));
  box.style.setProperty("--c", color(id));
  document.body.append(box);
  const r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  box.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
}

/** main.ts 启动时调用一次 */
export function initLiveSpk(deps: LiveSpkDeps): void {
  D = deps;
  onLineAudio(onLine);
  $("#lspkSave").onclick = openSave;
}
