// ---------- 说话人识别(实验功能,全部在本机计算,不调用 API) ----------
// 能量检测在 0.25 秒的停顿处细切 → 每段算 CAM++ 声纹(onnxruntime-web)→ 1.5 秒以上的片段做层次聚类分组 → 每段归到最近的组
// → 每句字幕按重叠时长投票,最多的一组占比达到阈值才标名字。实测(3 人快速接话的电台节目):片段 93%,按句约 75%,约一半的句子有标签
// 声纹存在 IndexedDB「spk:<会话 id>」,改阈值、改名字只重新分组/投票,不用重算
import * as ort from "onnxruntime-web/wasm";
import { SPK_MODEL } from "./config";
import { judgeSpeakers, reconcileGroupNames } from "./spk/judge";
import type { Basis, JudgeLine } from "./spk/judge";
import { SPK_DIM, spkResample, spkSegments, spkFbank, spkCluster, spkNorm, spkDot, spkSmooth } from "./spk/core";
import { t, CJK } from "./i18n";
import { fetchProgress, extractPcm } from "./media";
import type { ExtractCallbacks } from "./media";
import { fmtClock } from "./subtitle";
import { store, idb } from "./storage";
import { state, cfg, lines } from "./state";
import type { Line, Template, Voice } from "./state";
import { $, el } from "./dom";

/** 说话人识别要用、但留在 main.ts 或属于别的功能的东西 */
export interface SpeakerDeps {
  /** 读写会话级设置(spkOn) */
  sget(k: string, d: string): string;
  sset(k: string, v: string | null): void;
  /** 文件翻译的任务状态:分析时要知道是否在跑,并复用 / 缓存提取好的 PCM */
  fileJob: { active: boolean; phase: string; pcm: Int16Array | null };
  /** extractPcm 的进度回调(写进 fileJob,和文件翻译进度条共用) */
  pcmCb: ExtractCallbacks;
  fileProgress(): void;
  isFileSess(): boolean;
  seekTo(ms: number): void;
  saveLines(): void;
  getTemplate(id: string): Template | undefined;
  putTemplate(tp: Template): void;
  applySettings(): void;
  apiHeaders(): Record<string, string>;
  addMtCost(model: string, usage: unknown): void;
  openSettings(): void;
}
let D: SpeakerDeps;

const SPK_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e64980", "#5c7cfa"];
let spkBusy = false, spkModelP: Promise<ort.InferenceSession> | null = null;
// 一句字幕里声纹占比达到这个比例才算声纹确定(MyGO 实测的最优值),不确定的交给 GPT 判定
const SPK_SHARE = 0.85;
// 分组阈值(余弦距离)、投票时句子两端放宽的秒数、没有重叠片段时找最近片段的最大距离:
// 都按 MyGO #199 官方字幕颜色标注(真实说话人)实测选定,0.5–0.9 的阈值结果几乎一样
const SPK_DIST = 0.5, SPK_PAD = 0.5, SPK_NEAR = 2;
export function spkOn(): boolean { return D.sget("spkOn", "0") === "1"; }
export function spkPrefix(l: { spk?: string; tgt?: string; src?: string }): string { return l.spk && spkOn() ? l.spk + (CJK.test(l.tgt || l.src || "") ? "：" : ": ") : ""; }
function spkName(c: number): string { return (state.spk!.names[c] || "").trim() || (state.spk!.llm && state.spk!.llm.names[c]) || t("spk.n", { n: c + 1 }); }
export function paintSpk(l: Line): void {
  const tm = l.el.querySelector(".tm"); if (!tm) return;
  let w = tm.querySelector<HTMLElement>(".who");
  if (l.spk == null) { if (w) w.remove(); return; }
  if (!w) tm.append(w = el("span", { className: "who" }));
  w.textContent = l.spk || t("spk.unsure"); w.classList.toggle("unsure", !l.spk); w.style.setProperty("--c", l.spk ? SPK_COLORS[(l.spc || 0) % SPK_COLORS.length] : "");
  w.classList.toggle("ai", !!l.spkBy); w.title = l.spkBy ? t("spk.by." + l.spkBy) : "";
}
// onnxruntime-web 的 wasm(14 MB)和声纹模型都随页面同源发布;模型 28 MB,边下边显示进度
function loadSpkModel(onPct: (p: number) => void): Promise<ort.InferenceSession> {
  return (spkModelP ||= (async () => {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const buf = await fetchProgress(SPK_MODEL, onPct, 28281138);
    return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  })().catch((e) => { spkModelP = null; throw e; }));
}
async function spkEmbed(model: ort.InferenceSession, x: Float32Array): Promise<Float32Array> {
  const { data, T } = spkFbank(x);
  const r = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", data, [1, T, 80]) });
  return spkNorm(r[model.outputNames[0]].data as Float32Array);
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
  if (D.fileJob.active) return spkMsg(t("spk.busy"));
  if (!state.mediaBlob) return spkMsg(t("spk.needMedia"));
  spkBusy = true; renderSpk(); spkBar(0);
  try {
    spkMsg(t("spk.loadModel", { pct: 0 }));
    const model = await loadSpkModel((p) => { spkBar(p); spkMsg(t("spk.loadModel", { pct: Math.round(p * 100) })); });
    if (!D.fileJob.pcm) {
      spkBar(null); spkMsg(t("spk.extract"));
      const keep = D.fileJob.phase;
      try { D.fileJob.pcm = await extractPcm(state.mediaBlob, D.pcmCb); } finally { D.fileJob.phase = keep; D.fileProgress(); }
    }
    if (state.curSess !== ss) return;
    const pcm = D.fileJob.pcm, segs = spkSegments(pcm, 24000), n = segs.length, emb = new Float32Array(n * SPK_DIM);
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
  } catch (e: any) { console.error(e); spkMsg(t("spk.err", { m: e.message || String(e) })); } // any:catch 到的可能是任何值
  finally { spkBusy = false; spkBar(null); if (state.curSess === ss) renderSpk(); }
}
// 分组:长片段聚类(最多取最长的 600 段),太小的组(少于 3 段且不到 3%)并进最近的组;组按总时长排序。
// 重新分组后,和旧的组声纹很像的沿用旧名字
function spkRecluster(inherit?: boolean, keepLlm?: boolean) {
  const spk = state.spk!; // 调用方都先确认过 state.spk;函数里不会重新赋值,下面的 state.spk 都指它
  const { n, segs, emb } = spk, vec = (i: number) => emb.subarray(i * SPK_DIM, (i + 1) * SPK_DIM), dur = (i: number) => segs[2 * i + 1] - segs[2 * i];
  let long: number[] = []; for (let i = 0; i < n; i++) if (dur(i) >= 1.5) long.push(i);
  if (long.length > 600) long = long.sort((a, b) => dur(b) - dur(a)).slice(0, 600);
  if (long.length < 2) for (let i = 0; i < n; i++) if (!long.includes(i)) long.push(i);
  const lab = spkCluster(long.map(vec), SPK_DIST), groups = new Map<number, number[]>();
  long.forEach((i, k) => { const g = groups.get(lab[k]) || []; g.push(i); groups.set(lab[k], g); });
  let keep = [...groups.values()].filter((g) => g.length >= Math.max(3, 0.03 * long.length));
  if (!keep.length) keep = [[...groups.values()].sort((a, b) => b.length - a.length)[0]];
  const mean = (idx: number[]) => { const m = new Float32Array(SPK_DIM); for (const i of idx) { const v = vec(i); for (let d = 0; d < SPK_DIM; d++) m[d] += v[d]; } return spkNorm(m); };
  let cents = keep.map(mean);
  const assign = () => { spk.lab = new Int16Array(n); spk.sim = new Float32Array(n); for (let i = 0; i < n; i++) { let b = 0, bs = -2; const v = vec(i); cents.forEach((c, k) => { const s2 = spkDot(v, c); if (s2 > bs) { bs = s2; b = k; } }); spk.lab[i] = b; spk.sim[i] = bs; } };
  assign();
  const tot = cents.map((_, k) => { let s2 = 0; for (let i = 0; i < n; i++) if (spk.lab![i] === k) s2 += dur(i); return s2; });
  const order = cents.map((_, k) => k).sort((a, b) => tot[b] - tot[a]);
  cents = order.map((k) => cents[k]); assign();
  // 前后文平滑:短片段结合前后片段一起定组(MyGO 三集实测按时长准确率 +0~2 个百分点)
  { const K = cents.length, sims = new Float32Array(n * K);
    for (let i = 0; i < n; i++) { const v = vec(i); cents.forEach((c, k) => { sims[i * K + k] = spkDot(v, c); }); }
    spk.lab = spkSmooth(segs, sims, K); for (let i = 0; i < n; i++) spk.sim![i] = sims[i * K + spk.lab[i]]; }
  const lab2 = spk.lab, sim = spk.sim!;
  const oldC = spk.cents ? Array.from({ length: spk.cents.length / SPK_DIM }, (_, k) => spk.cents!.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) : [], oldN = spk.names || [];
  if (inherit !== false) { // 新旧两组互为最像、且余弦 ≥ 0.8 才沿用名字,避免名字沿着相近的组一路传下去
    const best = (v: Float32Array, arr: Float32Array[]) => { let b = -1, bs = 0.8; arr.forEach((o, k) => { const s2 = spkDot(v, o); if (s2 >= bs) { bs = s2; b = k; } }); return b; };
    spk.names = cents.map((c, k) => { const o = best(c, oldC); return o >= 0 && best(oldC[o], cents) === k ? oldN[o] || "" : ""; });
  }
  const same = spk.cents && spk.cents.length === cents.length * SPK_DIM && cents.every((c, k) => spkDot(c, spk.cents!.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) > 0.999);
  if (!keepLlm && !same) spk.llm = null; // 分组变了,之前的 LLM 判定对不上组号,作废
  spk.cents = new Float32Array(cents.length * SPK_DIM); cents.forEach((c, k) => spk.cents!.set(c, k * SPK_DIM));
  spk.groups = cents.map((_, k) => {
    let d = 0, cnt = 0, best = -1, bs = -2;
    for (let i = 0; i < n; i++) if (lab2[i] === k) { d += dur(i); cnt++; if (dur(i) >= 1.5 && sim[i] > bs) { bs = sim[i]; best = i; } }
    if (best < 0) for (let i = 0; i < n; i++) if (lab2[i] === k && (best < 0 || dur(i) > dur(best))) best = i;
    return { dur: d, n: cnt, sample: best };
  });
  spkVote();
}
// 每句字幕:和它重叠的片段按时长投票(1.5 秒以下的片段权重减半),同名的组合并计票;
// 按组的候选分布记在 l.spkV(给 LLM 判定用)。有 LLM 判定且开着时:声纹不确定的句子用 LLM 的结论;
// 声纹确定的句子只在 LLM 有明确证据(自我介绍、被点名后回答)时改判
function spkVote() {
  if (!state.spk) return;
  const spk = state.spk, groups = spk.groups!, lab = spk.lab!;
  const share = SPK_SHARE, { n, segs } = spk, color: Record<string, number> = {};
  groups.forEach((_, k) => { const nm = spkName(k); if (!(nm in color)) color[nm] = k; });
  const llm = spk.llm ? new Map(spk.llm.lines.map(([id, who, basis]) => [id, { who, basis }])) : null;
  const llmName = (who: string) => (/^G\d+$/.test(who) ? spkName(Number(who.slice(1)) - 1) : who);
  let tagged = 0, timed = 0;
  for (const l of lines) {
    if (l.ms == null) continue;
    timed++;
    const s = l.ms / 1000 - SPK_PAD, e = l.endMs! / 1000 + SPK_PAD, vote: Record<string, number> = {}, gv: Record<number, number> = {}; let sum = 0;
    for (let i = 0; i < n; i++) {
      const ov = Math.min(e, segs[2 * i + 1]) - Math.max(s, segs[2 * i]);
      if (ov <= 0) continue;
      const w = ov * (segs[2 * i + 1] - segs[2 * i] >= 1.5 ? 1 : 0.5), nm = spkName(lab[i]);
      vote[nm] = (vote[nm] || 0) + w; gv[lab[i]] = (gv[lab[i]] || 0) + w; sum += w;
    }
    l.spkV = Object.entries(gv).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, w]) => [Number(k), w / sum]); delete l.spkNear;
    // 句子的时间戳有时偏短、落在两段声音之间:取前后 SPK_NEAR 秒内最近的片段作参考,但不算声纹确定,交给 GPT 判断
    if (!sum) { let bi = -1, bg = Infinity; for (let i = 0; i < n; i++) { const g = Math.max(segs[2 * i] - e, s - segs[2 * i + 1]); if (g < bg) { bg = g; bi = i; } } if (bi >= 0 && bg <= SPK_NEAR) { l.spkV = [[lab[bi], 1]]; l.spkNear = Math.max(0, bg); } }
    const top = Object.entries(vote).sort((a, b) => b[1] - a[1])[0], sure = top && top[1] / sum >= share - 1e-9;
    delete l.spkBy;
    if (!top) delete l.spk; else if (sure) l.spk = top[0]; else l.spk = "";
    const j = llm && llm.get(l.id);
    if (j && j.who) {
      const nm = llmName(j.who);
      const unnamed = sure && /^G\d+$/.test(j.who) === false && groups.some((_, k) => spkName(k) === l.spk && spkName(k) === t("spk.n", { n: k + 1 }));
      if (nm !== l.spk && (!sure || unnamed || j.basis === "self_intro" || j.basis === "addressed")) { l.spk = nm; l.spkBy = j.basis; }
    }
    if (l.spk) { if (!(l.spk in color)) color[l.spk] = Object.keys(color).length; l.spc = color[l.spk]; tagged++; } else delete l.spc;
    paintSpk(l);
  }
  spk.tagged = tagged; spk.timed = timed;
  D.saveLines();
}
// 模板声纹库:{ 名字: { v: base64(192 维 float32), d: 累计秒数 } }。确认过组名后存进模板,之后同一模板的文件自动对照
const f32b64 = (v: ArrayLike<number>) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(v).buffer)));
const b64f32 = (s: string) => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
function spkGroupVecs() { return state.spk!.groups!.map((_, k) => state.spk!.cents!.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)); } // 各组质心
function spkSaveVoices() {
  const tp = D.getTemplate(cfg.tpl.id); if (!tp || !state.spk) return;
  const groups = state.spk.groups!;
  const lib: Record<string, Voice> = { ...(tp.voices || {}) }, acc: Record<string, { v: Float32Array; d: number }> = {}, G = spkGroupVecs();
  for (let k = 0; k < groups.length; k++) {
    const nm = spkName(k); if (nm === t("spk.n", { n: k + 1 })) continue; // 没认出名字的组不存
    const a = (acc[nm] ||= { v: new Float32Array(SPK_DIM), d: 0 }), d = groups[k].dur;
    for (let i = 0; i < SPK_DIM; i++) a.v[i] += G[k][i] * d; a.d += d;
  }
  for (const [nm, a] of Object.entries(acc)) { // 和库里同名的按时长加权合并
    const old = lib[nm];
    if (old) { const ov = b64f32(old.v); for (let i = 0; i < SPK_DIM; i++) a.v[i] += ov[i] * old.d; a.d += old.d; }
    lib[nm] = { v: f32b64(spkNorm(a.v)), d: Math.round(a.d) };
  }
  D.putTemplate({ ...tp, voices: lib }); renderSpk(); spkMsg(t("spk.saved", { names: Object.keys(acc).join("、") || "—" }));
}
// 对照规则(MyGO 四集跨集实测):余弦 ≥ 0.88、比第二像的高 0.05 以上、且互为最像 —— 不同人的误认全部排除;
// 同一声优的「本人声线」和「角色声线」可能互相匹配,所以只作为提示交给 GPT,由它按本集是角色回还是本人回定名字
const SPK_LIB_MIN = 0.88, SPK_LIB_MARGIN = 0.05;
function spkLibMatch(): ({ name: string; sim: number } | null)[] {
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
  D.applySettings();
  if (!cfg.hasKey) return spkMsg(t("spk.needKey"));
  spkJudging = true; renderSpk(); spkBar(null);
  const t0 = Date.now(), tick = () => spkMsg(t("spk.judging", { s: Math.round((Date.now() - t0) / 1000), n: lines.length })), timer = setInterval(tick, 1000); tick();
  try {
    const g = cfg.glossary, tl = lines.filter((l) => l.ms != null && (l.src || l.raw));
    const jl: JudgeLine[] = tl.map((l) => ({ id: l.id, s: l.ms! / 1000, e: l.endMs! / 1000, text: l.src || l.raw, voice: l.spkV || [], near: l.spkNear }));
    const r = await judgeSpeakers({
      lines: jl,
      groups: (() => { const lm = spkLibMatch(); return state.spk!.groups!.map((gr, k) => ({ k, name: (state.spk!.names[k] || "").trim(), dur: gr.dur, lib: lm[k] || undefined })); })(),
      description: cfg.tpl.description || "", spkNotes: cfg.tpl.spkNotes || "", people: g.people,
      share: SPK_SHARE,
    }, async (system, user, schema) => {
      const res = await fetch(cfg.apiBase + "/chat/completions", { method: "POST", headers: D.apiHeaders(), body: JSON.stringify({
        model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "speakers", strict: true, schema } } }) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json(); D.addMtCost(cfg.ctModel, data.usage);
      return JSON.parse(data.choices[0].message.content);
    });
    if (state.curSess !== ss) return;
    const names = reconcileGroupNames(jl, r, SPK_SHARE, state.spk!.groups!.length); // 组名和逐句判定对齐,重名且没句子支持的清空
    state.spk!.llm = { names, lines: [...r.lines].map(([id, v]): [number, string, Basis] => [id, v.who, v.basis]), at: Date.now() };
    spkVote(); spkSave();
  } catch (e: any) { console.error(e); clearInterval(timer); spkJudging = false; spkMsg(t("spk.err", { m: e.message || String(e) })); renderSpk(false); return; } // any:catch 到的可能是任何值
  finally { spkJudging = false; clearInterval(timer); spkBar(null); }
  if (state.curSess === ss) renderSpk();
}
// 开着说话人识别时自动跑完两步:本机声纹分析(没做过才做)→ GPT 判定(没判过或已作废才判)
let spkAutoP: Promise<void> | null = null;
export function spkAuto(ss = state.curSess): Promise<void> | null {
  if (!ss || ss !== state.curSess || !spkOn() || !D.isFileSess() || D.fileJob.active || !ss.done || spkAutoP) return spkAutoP;
  return (spkAutoP = (async () => {
    try {
      await spkLoad();
      if (!state.spk) { if (!state.mediaBlob) return spkMsg(t("spk.needMedia")); await spkAnalyze(); }
      if (state.spk && state.curSess === ss && !state.spk.llm) await spkJudge();
    } finally { spkAutoP = null; if (state.curSess === ss) { if (!$("#spkPanel").hidden) renderSpk(); D.fileProgress(); } }
  })());
}
export async function spkAfterFile(ss: typeof state.curSess): Promise<void> {
  if (state.curSess !== ss) return;
  if (await spkLoad()) { state.spk!.llm = null; spkVote(); spkSave(); } // 字幕重新生成了,旧的 GPT 判定对不上
  spkAuto(ss);
}
// 面板里的进度同步到主进度条(spkNow 记下当前这一步)
export const spkNow: { msg: string; p: number | null } = { msg: "", p: null };
export function spkRunning(): boolean { return spkBusy || spkJudging || !!spkAutoP; }
function spkMsg(m: string) { $("#spkMsg").textContent = m; spkNow.msg = m; D.fileProgress(); }
function spkBar(p: number | null) { $("#spkBar").hidden = p == null; if (p != null) $("#spkBar i").style.width = Math.round(p * 1000) / 10 + "%"; spkNow.p = p; D.fileProgress(); }
export function spkPanel(on: boolean): void { $("#spkPanel").hidden = !on; document.body.classList.toggle("spkopen", on); }
function renderSpk(msg = true) {
  const on = spkOn(), busy = spkBusy || spkJudging || !!spkAutoP;
  $("#spkIntro").textContent = t(on ? "spk.introOn" : "spk.introOff");
  $("#spkRun").textContent = t(!on ? "spk.enable" : state.spk ? "spk.rerun" : "spk.start"); $("#spkRun").disabled = busy || (on && !(state.curSess && state.curSess.done));
  const list = $("#spkList"); list.replaceChildren(); $("#spkVoices").hidden = true;
  if (!on) { if (!busy) spkMsg(""); return; }
  if (!state.spk) { if (!busy) spkMsg(t(!(state.curSess && state.curSess.done) ? "spk.wait" : state.mediaBlob ? "spk.none" : "spk.needMedia")); return; }
  const spk = state.spk, groups = spk.groups!;
  if (!busy && msg) spkMsg(t("spk.done", { k: groups.length, a: spk.tagged, b: spk.timed }) + (spk.llm ? " " + t("spk.judged", { n: lines.filter((l) => l.spkBy).length }) : ""));
  const libM = spkLibMatch(), libN = Object.keys((cfg.tpl && cfg.tpl.voices) || {});
  $("#spkVoices").hidden = false; $("#spkSaveVoices").disabled = busy || !groups.some((_, k) => spkName(k) !== t("spk.n", { n: k + 1 }));
  $("#spkLib").textContent = libN.length ? t("spk.lib", { names: libN.join("、") }) : t("spk.libNone"); $("#spkClearVoices").hidden = !libN.length;
  groups.forEach((g, k) => {
    const ai = spk.llm && spk.llm.names[k], lm = libM[k];
    const inp = el("input", { type: "text", value: spk.names[k] || "", placeholder: ai ? ai + " · AI" : t("spk.n", { n: k + 1 }) });
    inp.onchange = () => { state.spk!.names[k] = inp.value.trim(); spkVote(); spkSave(); renderSpk(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    const play = el("button", { className: "btn i-play", textContent: t("spk.play"), onclick: () => { const i = g.sample; if (i < 0) return; D.seekTo(state.spk!.segs[2 * i] * 1000); state.spkStopAt = state.spk!.segs[2 * i + 1] * 1000 + 200; } });
    list.append(el("div", { className: "spkItem" }, el("i", { className: "dot", style: "--c:" + SPK_COLORS[k % SPK_COLORS.length] }), inp, el("span", { className: "meta", textContent: t("spk.meta", { dur: fmtClock(g.dur * 1000), n: g.n }) + (lm ? " · " + t("spk.libMatch", { name: lm.name }) : "") }), play));
  });
}
// 第一次开启先确认(要下载约 40 MB 组件、GPT 判定消耗 API),确认过一次就不再问
function spkAskEnable() {
  if (store.get("spkConsent", "") === "1") return spkSetOn(true);
  $("#spkOn").checked = false; $("#spkConfirm").hidden = false;
  if ($("#settings").hidden) D.openSettings();
  $("#secSpk").scrollIntoView({ block: "start" });
}
function spkSetOn(on: boolean) {
  $("#spkOn").checked = on;
  D.sset("spkOn", on ? "1" : null); document.body.classList.toggle("nospk", !spkOn());
  for (const l of lines) paintSpk(l);
  if (!$("#spkPanel").hidden) renderSpk();
  spkAuto();
}

/** main.ts 启动时调用一次(在任何说话人相关的函数可能被调用之前):注入依赖,挂上面板和设置里的按钮 */
export function initSpeaker(deps: SpeakerDeps): void {
  D = deps;
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
    const tp = D.getTemplate(cfg.tpl.id); if (tp) { D.putTemplate({ ...tp, voices: {} }); renderSpk(); }
  };
  $("#spkSettings").onclick = () => { D.openSettings(); $("#secSpk").scrollIntoView({ block: "start" }); };
  $("#spkConfirmOk").onclick = () => { store.set("spkConsent", "1"); $("#spkConfirm").hidden = true; spkSetOn(true); };
  $("#spkConfirmNo").onclick = () => { $("#spkConfirm").hidden = true; };
  $("#spkOn").onchange = () => { if ($("#spkOn").checked) spkAskEnable(); else { $("#spkConfirm").hidden = true; spkSetOn(false); } };
}
