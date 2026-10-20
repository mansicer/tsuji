// 翻译流水线(OpenAI Chat Completions)和按会话存的翻译记忆。
// 队列 queue / 上下文 history、生成代数(sessKey / curGen)、renderLine、延迟和费用显示都还在 main.ts(别的功能也用),
// 启动时由 initTranslate 注入
import { applyMemo, memoPrompt, type MemoOps } from "./memo";
import { patchTranslations } from "./linestore";
import { store } from "./storage";
import { t, srcName, tgtName } from "./i18n";
import { SYSTEM, SCHEMA } from "./prompts";
import type { Usage } from "./cost";
import { state, cfg, lines, type Line, type Session } from "./state";
import { $, el, flash } from "./dom";

export interface TranslateDeps {
  /** 待翻译的行(识别、文件处理往里放) */
  queue: Line[];
  /** 已翻译的行,取最近几条作上下文 */
  history: Line[];
  sessKey(ss?: Session | null): string;
  curGen(key: string): number;
  renderLine(line: Line, merge?: boolean): void;
  addMtCost(model: string, u: Usage | null | undefined, extra?: number): void;
  lat: { mt: number; mtAvg: number };
  mtHist: number[];
  diag: { err: number };
  showLat(): void;
}
let queue: Line[], history: Line[];
let sessKey: TranslateDeps["sessKey"], curGen: TranslateDeps["curGen"], renderLine: TranslateDeps["renderLine"];
let addMtCost: TranslateDeps["addMtCost"], lat: TranslateDeps["lat"], mtHist: number[], diag: TranslateDeps["diag"], showLat: TranslateDeps["showLat"];
export function initTranslate(deps: TranslateDeps): void {
  ({ queue, history, sessKey, curGen, renderLine, addMtCost, lat, mtHist, diag, showLat } = deps);
}

// 翻译记忆(见 memo.ts):按会话存,随字幕一起清空
export function loadMemo(): void { state.memo = state.curSess ? store.json("smemo." + state.curSess.id, []) : []; renderMemo(); }
export function getMemo(ss: Session): string[] { return ss === state.curSess ? state.memo : store.json("smemo." + ss.id, []); }
export function setMemo(next: string[], ss = state.curSess): void {
  if (ss) store.set("smemo." + ss.id, next.length ? JSON.stringify(next) : null);
  if (ss === state.curSess) { state.memo = next; renderMemo(); }
}
export function renderMemo(): void {
  $("#memoSum").textContent = t("rec.memo", { n: state.memo.length });
  $("#memoList").replaceChildren(...(state.memo.length ? state.memo.map((m) => el("li", { textContent: m })) : [el("li", { className: "empty", textContent: t("rec.memoEmpty") })]));
}

// ---------- 翻译(OpenAI Chat Completions) ----------
export async function pumpTranslate(): Promise<void> {
  if (state.translating || !queue.length) return;
  state.translating = true;
  const batch = queue.splice(0, 6);
  const tplId = cfg.tpl.id, ss = state.curSess, key = sessKey(ss), gen = curGen(key);
  try {
    const ctx = history.slice(-8).map((l) => `${l.src} → ${l.tgt}`).join("\n") || "(none)";
    const user = `Running notes:\n${memoPrompt(state.memo)}\n\nRecent context (already translated, reference only):\n${ctx}\n\nNew ASR segments:\n` + JSON.stringify(batch.map((l) => ({ id: l.id, asr: l.raw })));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const mtStart = performance.now();
    const res = await fetch(cfg.apiBase + "/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: apiHeaders(),
      body: JSON.stringify({
        model: cfg.mtModel, ...effort(),
        messages: [{ role: "system", content: SYSTEM(cfg, srcName(cfg.tpl.source, "en"), tgtName(cfg.tpl.target, "en")) }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "subtitles", strict: true, schema: SCHEMA } },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    addMtCost(cfg.mtModel, data.usage);
    lat.mt = performance.now() - mtStart; mtHist.push(lat.mt); if (mtHist.length > 10) mtHist.shift();
    lat.mtAvg = mtHist.reduce((a, b) => a + b, 0) / mtHist.length; showLat();
    const out: { items?: { id: number; src: string; tgt: string }[]; memory?: Partial<MemoOps> } = JSON.parse(data.choices[0].message.content), items = out.items || [];
    if (curGen(key) !== gen) return; // 翻译途中这个会话被清空、重新处理或删除了
    if (ss !== state.curSess || !lines.includes(batch[0])) { // 翻译途中切走了会话:结果写回原会话,别混进当前会话的上下文
      if (ss) setMemo(applyMemo(getMemo(ss), out.memory), ss);
      if (ss !== state.curSess) { state.lineStore.set(key, patchTranslations(state.lineStore.get(key), items)); return; }
      const byId = new Map(items.map((it) => [it.id, it])); // 又切回来了:页面上的行是从存储重建的,按 id 对上
      for (const l of lines) { const it = byId.get(l.id); if (it) { l.src = it.src.trim(); l.tgt = it.tgt.trim(); renderLine(l); if (l.src) history.push(l); } }
      return;
    }
    if (cfg.tpl.id !== tplId) return; // 翻译途中换了模板,这批行已经不在页面上
    setMemo(applyMemo(state.memo, out.memory), ss);
    const byId = new Map(items.map((it) => [it.id, it]));
    for (const l of batch) {
      const it = byId.get(l.id);
      if (it) { l.src = it.src.trim(); l.tgt = it.tgt.trim(); }
      renderLine(l);
      if (l.src) history.push(l);
    }
  } catch (e: any) { // 可能是 AbortError、网络错误或上面抛的 Error,只读 name / message
    console.error(e);
    flash(t("flash.mt") + (e.name === "AbortError" ? t("flash.timeout") : e.message)); diag.err++;
    if (ss === state.curSess && curGen(key) === gen && cfg.tpl.id === tplId) for (const l of batch) { l.tgt = ""; l.failed = true; renderLine(l); }
  } finally {
    state.translating = false;
    pumpTranslate();
  }
}
export function apiHeaders(): Record<string, string> { return { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}) }; }
function effort(): { reasoning_effort?: string } { return cfg.mtEffort ? { reasoning_effort: cfg.mtEffort } : {}; }
