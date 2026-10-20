// 会话:新建 / 切换 / 删除 / 旧数据升级,会话级设置读写,首页的会话列表
import { state, cfg, lines } from "./state";
import type { Session, Template, View } from "./state";
import { $, el, download } from "./dom";
import { getUiLang, t, srcName, tgtName } from "./i18n";
import { store, idb } from "./storage";
import { parseGlossary } from "./glossary";
import { fmtClock } from "./subtitle";
import type { SavedLine } from "./linestore";
import { fmtBytes, recPrefix } from "./live-record";

/** main.ts 和其他功能里的东西,启动时由 main.ts 注入 */
export interface SessionDeps {
  /** 收音参数默认值(main.ts 的 AUDIO_DEFAULTS),用来算 SESSION_KEYS */
  AUDIO_DEFAULTS: Record<string, unknown>;
  builtins: () => Template[];
  allTemplates: () => Template[];
  getTemplate: (id: string) => Template | undefined;
  /** 设置面板:按当前会话重新填控件并生效 */
  loadSettings: () => void;
  stop: () => void;
  /** 文件会话的处理任务;切会话时在跑就先暂停 */
  fileJob: { active: boolean };
  filePause: () => void;
  flushLines: () => void;
  restoreLines: () => void;
  loadMemo: () => void;
  spkPanel: (on: boolean) => void;
  /** 翻译队列和上下文,切会话时清空 */
  history: unknown[];
  queue: unknown[];
  sessionConfig: () => unknown;
  bumpGen: (key: string) => void;
  show: (v: View) => void;
}
let d: SessionDeps;
let SESSION_KEYS: string[];
export function initSessions(deps: SessionDeps): void {
  d = deps;
  SESSION_KEYS = ["asrModel", "mtModel", "mtEffort", ...Object.keys(d.AUDIO_DEFAULTS), "showSrc", "tgtSize"];
}

// ---------- 会话 ----------
// 会话 = {id, name, tplId, source, target, settings, createdAt, updatedAt, count};字幕存在 IndexedDB 的 lines:<id>
// settings 只存和默认值不同的项;没有会话时这些项存在 sessDefaults,作为新会话的初始值
export function saveSessions(): void { store.set("sessions", JSON.stringify(state.sessions)); }
function sessSettings(): Record<string, string> { return state.curSess ? (state.curSess.settings ||= {}) : state.sessDefaults; }
export function sget(k: string, d: string): string { const v = sessSettings()[k]; return v == null ? d : String(v); }
export function sset(k: string, v: unknown): void { const o = sessSettings(); if (v == null) delete o[k]; else o[k] = String(v); if (state.curSess) saveSessions(); else store.set("sessDefaults", JSON.stringify(state.sessDefaults)); }
export function sessTemplate(ss: Session | null): Template | null | undefined { return ss && d.getTemplate(ss.tplId); }
function fmtWhen(ms: number): string { return new Date(ms).toLocaleString(getUiLang() === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
export function newSession(tplId: string): Session {
  const tp = d.getTemplate(tplId) || d.builtins()[0], now = Date.now();
  const ss: Session = { id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6), name: tp.name + " · " + fmtWhen(now), tplId: tp.id, source: tp.source, target: tp.target,
    settings: { ...(state.curSess ? state.curSess.settings : state.sessDefaults) }, createdAt: now, updatedAt: now, count: 0 };
  state.sessions.push(ss); saveSessions(); useSession(ss.id);
  return ss;
}
// 切换会话:收音中先停;重新读该会话的设置和字幕
export function useSession(id: string | null): void {
  const ss = state.sessions.find((x) => x.id === id) || null;
  const changed = ss !== state.curSess;
  if (changed && state.running) d.stop();
  if (changed && d.fileJob.active) d.filePause();
  if (changed) d.flushLines();
  state.curSess = ss; store.set("curSession", ss ? ss.id : null);
  if (changed) { state.spk = null; d.spkPanel(false); }
  d.loadSettings(); refreshTemplate();
  if (changed) {
    lines.length = 0; d.history.length = 0; d.queue.length = 0; state.nextId = 0;
    $("#log").replaceChildren(); $("#partial").textContent = "";
    if (state.curSess) d.restoreLines();
    d.loadMemo();
  }
}
// 会话引用模板:模板改了(补词表等)这里重新取;语言用会话自己的
export function refreshTemplate(): void {
  // general 是内置的空白模板,一定在
  const tp = sessTemplate(state.curSess) || d.builtins().find((x) => x.id === "general")!;
  cfg.tpl = state.curSess ? { ...tp, source: state.curSess.source, target: state.curSess.target } : tp;
  cfg.glossary = parseGlossary(tp.glossary);
  $("#srcLang").value = cfg.tpl.source; $("#tgtLang").value = cfg.tpl.target;
  $("#curTplName").textContent = state.curSess ? t("set.sessCur", { name: state.curSess.name }) + "\n" + t("set.curTpl", { name: tp.name }) : t("set.sessNone");
  $("#langSec .two").hidden = $("#editCurTpl").hidden = !state.curSess;
  if (state.running && state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "session.update", session: d.sessionConfig() }));
  if (state.view === "live" && state.curSess) $("#title").textContent = state.curSess.name;
}
function deleteSession(id: string): void {
  d.bumpGen(id);
  state.sessions = state.sessions.filter((x) => x.id !== id);
  for (const x of state.sessions) if (x.recSession === id) delete x.recSession; // 录音转出的文件会话删了:实时会话可以再转
  saveSessions(); state.lineStore.set(id, null); store.set("smemo." + id, null); idb.del(id).catch(() => {}); idb.del("spk:" + id).catch(() => {}); idb.delPrefix(recPrefix(id)).catch(() => {});
  if (state.curSess && state.curSess.id === id) useSession(state.sessions.length ? [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id : null);
}
// 旧版数据(字幕按模板存、设置全局存)升级成会话:每个有字幕的模板一个会话,当前设置带进去。只复制,不删旧数据
export function migrateToSessions(): void {
  if (store.get("sessMigrated", null)) return;
  const legacy: Record<string, string> = {};
  for (const k of SESSION_KEYS) { const v = store.get(k, null); if (v != null) legacy[k] = v; }
  if (legacy.showSrc == null && store.get("showJa", null) != null) legacy.showSrc = store.get("showJa", null)!;
  if (legacy.tgtSize == null && store.get("zhSize", null) != null) legacy.tgtSize = store.get("zhSize", null)!;
  if (legacy.tgtSize === "24") delete legacy.tgtSize;
  if (legacy.showSrc === "1") delete legacy.showSrc;
  state.sessDefaults = { ...legacy }; store.set("sessDefaults", JSON.stringify(state.sessDefaults));
  const cur = store.get("current", null);
  for (const tp of d.allTemplates()) {
    const arr: SavedLine[] = store.json("lines." + tp.id, []);
    if (!arr.length) continue;
    const first = arr[0].t || Date.now(), last = arr[arr.length - 1].t || first;
    const ss: Session = { id: "s" + first.toString(36) + Math.random().toString(36).slice(2, 6), name: tp.name + " · " + fmtWhen(first), tplId: tp.id, source: tp.source, target: tp.target,
      settings: { ...legacy }, createdAt: first, updatedAt: last, count: arr.length };
    state.sessions.push(ss); state.lineStore.set(ss.id, arr);
    if (tp.id === cur || !store.get("curSession", null)) store.set("curSession", ss.id);
  }
  saveSessions(); store.set("sessMigrated", "1");
}

// ---------- 会话列表 ----------
// 存储格式里 s = 媒体内起始毫秒(文件会话),t = 时间戳(见 main.ts 的 saveLines)
function sessTranscript(arr: SavedLine[]): string { return arr.filter((l) => l.src || l.tgt).map((l) => `[${l.s != null ? fmtClock(l.s as number) : new Date(l.t as number).toTimeString().slice(0, 8)}] ${l.tgt}\n           ${l.src}`).join("\n"); }
export function fileName(name: string | null | undefined): string { return (name || "subs").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60); }
export function renderSessions(): void {
  $("#noKey").hidden = cfg.hasKey;
  const list = $("#sessList");
  list.replaceChildren();
  if (!state.sessions.length) { list.append(el("div", { className: "emptyList", textContent: t("home.noSessions") })); return; }
  for (const ss of [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const tp = sessTemplate(ss), cur = state.curSess && state.curSess.id === ss.id;
    const h = el("h3", { textContent: ss.name });
    h.append(el("span", { className: "tag", textContent: t(ss.kind === "file" ? "sess.file" : "sess.live") }));
    if (cur) h.append(el("span", { className: "tag", textContent: t("card.current") }));
    const btn = (key: string, fn: () => void, primary: boolean, icon: string) => el("button", { className: "btn" + (primary ? " primary" : "") + " i-" + icon, textContent: t(key), onclick: fn });
    const rename = () => {
      const inp = el("input", { type: "text", value: ss.name });
      const done = () => { const v = inp.value.trim(); if (v && v !== ss.name) { ss.name = v; saveSessions(); if (cur) refreshTemplate(); } renderSessions(); };
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = ss.name; inp.blur(); } };
      inp.onblur = done; h.replaceChildren(inp); inp.focus(); inp.select();
    };
    const del = btn("sess.del", () => {
      if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = t("sess.delSure"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("sess.del"); }, 3000); return; }
      deleteSession(ss.id); renderSessions();
    }, false, "trash");
    list.append(el("div", { className: "card" + (cur ? " current" : "") }, h,
      el("div", { className: "meta", textContent: t("sess.meta", { tpl: tp ? tp.name : t("sess.tplMissing"), src: srcName(ss.source), tgt: tgtName(ss.target) }) }),
      el("div", { className: "when", textContent: t("sess.when", { time: fmtWhen(ss.updatedAt), n: ss.count || 0 }) + (ss.kind === "file" && ss.file && ss.file.duration ? " · " + fmtClock(ss.file.duration) : "") + (ss.rec && ss.rec.bytes ? " · " + t("sess.recSize", { size: fmtBytes(ss.rec.bytes) }) : "") }),
      el("div", { className: "btns" },
        btn("sess.continue", () => { useSession(ss.id); d.show("live"); }, true, "play"),
        btn("sess.rename", rename, false, "edit"),
        btn("sess.export", () => download(fileName(ss.name) + ".txt", sessTranscript(state.lineStore.get(ss.id))), false, "download"),
        del)));
  }
}
