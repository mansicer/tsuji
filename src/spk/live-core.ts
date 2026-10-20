// 实时说话人的纯计算部分:在线分组、组的延迟显示、短片段规则、定期整体重新聚类(匈牙利对应保持组号和名字)、
// 组质心对照声纹库(按声纹来源分阈值)。不碰 DOM,node 下可直接用合成向量测
import { SPK_DIM, spkCluster, spkDot, spkNorm } from "./core";
import { hungarian } from "./live-eval";
import { applyNames } from "./live-schedule";
import type { NameSrc, NameProposal, NameChange } from "./live-schedule";
import type { Voice } from "../state";

/** 实时说话人流水线的常量(docs/live-speaker.md「Phase 2 decisions」) */
export const LIVE_SPK = {
  /** 聚类距离:和组质心余弦 ≥ 1 - dist 就并进去 */
  dist: 0.38,
  /** 组累计 ≥ showDur 秒或 ≥ showN 段才显示 */
  showDur: 3, showN: 2,
  /** 短于 shortDur 秒的片段不参与聚类:最近的已显示组余弦 ≥ shortSim 才跟它,否则不标 */
  shortDur: 1.0, shortSim: 0.55,
  /** 太短的片段(秒)不算声纹 */
  minDur: 0.4,
  /** 一句最多取多少秒算声纹 */
  maxSeg: 10,
  /** 声纹库:live 声纹要 ≥ libLive,文件声纹(v / file alts)要 ≥ libFile;比第二像的人高 libMargin;组累计 ≥ libDur 秒才对照 */
  libLive: 0.80, libFile: 0.70, libMargin: 0.08, libDur: 4,
  /** 整体重新聚类:每 reclusterMs 毫秒或每 reclusterN 个新片段一次,只取最近 keep 段 */
  reclusterMs: 30_000, reclusterN: 10, keep: 400,
  /** 积压:队首的句子结束已超过这么久(毫秒)就丢掉,不让流水线越拖越远 */
  maxLag: 30_000,
  /** 事件保留多久(毫秒) */
  eventsMs: 3_600_000,
};
export type LiveSpkCfg = typeof LIVE_SPK;

/** 一句字幕对应的一个片段 */
export interface LiveSeg { line: number; dur: number; vec: Float32Array; g: number | null; sim: number; member: boolean }
/** 组。id < 0 = 还没显示的临时组;显示时换成正式 id(字母由 id 定) */
export interface CoreGroup {
  id: number; name: string | null; src: NameSrc | null; visible: boolean;
  sum: Float32Array; n: number; dur: number; cent: Float32Array;
  /** 刷新前存下的组(只有质心,没有片段) */
  base: { sum: Float32Array; n: number; dur: number } | null;
  /** 重新聚类时从哪个已显示的组拆出来的 */
  splitFrom?: number;
}
export interface CoreEvent { kind: "new-group" | "merge" | "split"; at: number; id: number; other?: number }
/** 存进 IndexedDB 的组(质心 base64) */
export interface SavedGroups { next: number; groups: { id: number; name: string | null; src: NameSrc | null; cent: string; dur: number; n: number }[] }

const RANK: Record<NameSrc, number> = { "gpt-guess": 0, "gpt-evidence": 1, library: 2, manual: 3 };
/** 组号 → 字母:0 → A … 25 → Z,26 → AA */
export function letterOf(id: number): string { let s = "", k = id; do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0); return s; }
export const f32b64 = (v: ArrayLike<number>): string => { const b = new Uint8Array(Float32Array.from(v).buffer); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
export const b64f32 = (s: string): Float32Array => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
const zeros = () => new Float32Array(SPK_DIM);
function addTo(a: Float32Array, b: ArrayLike<number>, w = 1) { for (let d = 0; d < SPK_DIM; d++) a[d] += b[d] * w; }

// ---------- 声纹库 ----------
export interface LiveLibEntry { name: string; vecs: { v: Float32Array; src: "file" | "live" }[] }
/** 模板声纹库 → 带来源的声纹。d = 0 的 v 只是占位(只有现场声纹的人),不算文件声纹 */
export function liveLibEntries(voices: Record<string, Voice> | null | undefined): LiveLibEntry[] {
  return Object.entries(voices || {}).map(([name, x]) => {
    const alts = x.alts || [], vecs = alts.map((a) => ({ v: b64f32(a.v), src: a.src }));
    if (!(x.d === 0 && alts.some((a) => a.src === "live"))) vecs.unshift({ v: b64f32(x.v), src: "file" });
    return { name, vecs };
  });
}
/** 一个人的分数(和他所有声纹里最像的)以及是否有一个声纹过了它那种来源的阈值 */
function libScore(v: ArrayLike<number>, e: LiveLibEntry, C: LiveSpkCfg): { s: number; ok: boolean } {
  let s = -2, ok = false;
  for (const x of e.vecs) { const d = spkDot(v, x.v); s = Math.max(s, d); if (d >= (x.src === "live" ? C.libLive : C.libFile)) ok = true; }
  return { s, ok };
}
/**
 * 各组质心对照声纹库:最像的人过了阈值、比第二像的高 libMargin、而且别的组都没有比它更像这个人,才给名字。
 * cents 里 dur 不够 libDur 的组只参与「互为最像」,不给名字
 */
export function libMatch(cents: { id: number; cent: Float32Array; dur: number }[], lib: LiveLibEntry[], C: LiveSpkCfg = LIVE_SPK): { id: number; name: string; sim: number }[] {
  if (!lib.length) return [];
  const out: { id: number; name: string; sim: number }[] = [];
  for (const g of cents) {
    if (g.dur < C.libDur) continue;
    const sc = lib.map((e, i) => ({ ...libScore(g.cent, e, C), i })).sort((a, b) => b.s - a.s), top = sc[0], s2 = sc[1] ? sc[1].s : -1;
    if (!top.ok || top.s - s2 < C.libMargin) continue;
    if (cents.some((h) => h !== g && libScore(h.cent, lib[top.i], C).s >= top.s)) continue;
    out.push({ id: g.id, name: lib[top.i].name, sim: top.s });
  }
  return out;
}

// ---------- 在线分组 ----------
export class LiveCore {
  segs: LiveSeg[] = [];
  gs = new Map<number, CoreGroup>();
  events: CoreEvent[] = [];
  next = 0;
  /** 上次整体重新聚类之后新增的片段数 */
  fresh = 0;
  private tmp = -1;
  private byLine = new Map<number, LiveSeg>();
  constructor(readonly C: LiveSpkCfg = LIVE_SPK) {}

  /** 已显示的组,按 id */
  visible(): CoreGroup[] { return [...this.gs.values()].filter((g) => g.visible).sort((a, b) => a.id - b.id); }
  group(id: number | null | undefined): CoreGroup | undefined { return id == null ? undefined : this.gs.get(id); }
  seg(line: number): LiveSeg | undefined { return this.byLine.get(line); }

  private newGroup(): CoreGroup {
    const g: CoreGroup = { id: this.tmp--, name: null, src: null, visible: false, sum: zeros(), n: 0, dur: 0, cent: zeros(), base: null };
    this.gs.set(g.id, g); return g;
  }
  private join(g: CoreGroup, s: LiveSeg) { s.g = g.id; addTo(g.sum, s.vec); g.n++; g.dur += s.dur; g.cent = spkNorm(g.sum); }
  private detach(s: LiveSeg) {
    const g = s.member ? this.group(s.g) : undefined; s.g = null;
    if (!g) return;
    addTo(g.sum, s.vec, -1); g.n--; g.dur -= s.dur; g.cent = spkNorm(g.sum);
    if (g.n <= 0 && !g.base) this.gs.delete(g.id);
  }
  /** 够条件就显示:换正式 id,记 new-group(重新聚类拆出来的记 split) */
  private reveal(g: CoreGroup, now: number) {
    if (g.visible || !(g.dur >= this.C.showDur || g.n >= this.C.showN)) return;
    const old = g.id; g.id = this.next++; g.visible = true;
    this.gs.delete(old); this.gs.set(g.id, g);
    for (const s of this.segs) if (s.g === old) s.g = g.id;
    const from = g.splitFrom != null ? this.gs.get(g.splitFrom) : undefined;
    this.events.push(from && from.visible ? { kind: "split", at: now, id: g.id, other: from.id } : { kind: "new-group", at: now, id: g.id });
    delete g.splitFrom;
  }
  /** 最近的已显示组(余弦 ≥ min) */
  private nearest(v: Float32Array, min: number): { g: CoreGroup; s: number } | null {
    let best: { g: CoreGroup; s: number } | null = null;
    for (const g of this.gs.values()) if (g.visible) { const s = spkDot(v, g.cent); if (s >= min && (!best || s > best.s)) best = { g, s }; }
    return best;
  }
  private labelShort(s: LiveSeg) { const b = this.nearest(s.vec, this.C.shortSim); s.g = b ? b.g.id : null; s.sim = b ? b.s : 0; }

  /** 新片段(同一句再来一次 = 合并后延长了,替换原来的)。在线分组:最像的组够近就并进去,否则开新组 */
  add(line: number, dur: number, vec: Float32Array, now: number): LiveSeg {
    const old = this.byLine.get(line);
    if (old) { this.detach(old); this.segs.splice(this.segs.indexOf(old), 1); }
    const s: LiveSeg = { line, dur, vec, g: null, sim: 0, member: dur >= this.C.shortDur };
    this.segs.push(s); this.byLine.set(line, s);
    if (!s.member) { this.labelShort(s); return s; }
    let best: CoreGroup | null = null, bs = 1 - this.C.dist;
    for (const g of this.gs.values()) { const x = spkDot(vec, g.cent); if (x >= bs) { bs = x; best = g; } }
    const g = best || this.newGroup();
    this.join(g, s); s.sim = best ? bs : 1;
    this.reveal(g, now); this.fresh++;
    return s;
  }
  /** 这句已经不在了(并进上一句):去掉它的片段 */
  drop(line: number): void { const s = this.byLine.get(line); if (!s) return; this.detach(s); this.segs.splice(this.segs.indexOf(s), 1); this.byLine.delete(line); }
  /** 这句现在的标签:组没显示或短片段没跟上任何组时 g = null */
  label(line: number): { g: number | null; conf: number } | null {
    const s = this.byLine.get(line); if (!s) return null;
    const g = this.group(s.g);
    return g && g.visible ? { g: g.id, conf: Math.round(spkDot(s.vec, g.cent) * 1000) / 1000 } : { g: null, conf: Math.round(s.sim * 1000) / 1000 };
  }
  due(now: number, last: number): boolean { return this.fresh > 0 && (this.fresh >= this.C.reclusterN || now - last >= this.C.reclusterMs); }

  /**
   * 整体重新聚类最近 keep 个参与聚类的片段(平均连接)。新簇按重叠时长(已显示的组优先)用匈牙利算法对应到旧组,
   * 字母和名字不变;对不上的簇先找窗口外的旧组(质心够近),再不行开新组(从已显示的组拆出来算 split);
   * 窗口里的成员全被别的簇拿走的旧组并进拿走最多的那个(merge),名字按来源优先级留高的
   */
  recluster(now: number): void {
    this.fresh = 0;
    const C = this.C, W = this.segs.filter((s) => s.member).slice(-C.keep), inWin = new Set(W);
    if (W.length < 2) return;
    const lab = spkCluster(W.map((s) => s.vec), C.dist), cm = new Map<number, LiveSeg[]>();
    W.forEach((s, i) => { const c = cm.get(lab[i]); if (c) c.push(s); else cm.set(lab[i], [s]); });
    const cl = [...cm.values()], olds = [...new Set(W.map((s) => s.g!))].filter((id) => this.gs.has(id));
    const ov = cl.map((c) => olds.map((o) => c.reduce((a, s) => a + (s.g === o ? s.dur : 0), 0)));
    const asg = hungarian(ov.map((r) => r.map((x, j) => x * (this.gs.get(olds[j])!.visible ? 1000 : 1))));
    const tgt: CoreGroup[] = [], used = new Set<CoreGroup>(), inW = new Set(olds);
    cl.forEach((_, i) => { if (asg[i] >= 0) { tgt[i] = this.gs.get(olds[asg[i]])!; used.add(tgt[i]); } });
    cl.forEach((c, i) => {
      if (tgt[i]) return;
      const m = zeros(); for (const s of c) addTo(m, s.vec);
      const v = spkNorm(m); let best: CoreGroup | null = null, bs = 1 - C.dist;
      for (const g of this.gs.values()) if (!inW.has(g.id) && !used.has(g) && g.n > 0) { const x = spkDot(v, g.cent); if (x >= bs) { bs = x; best = g; } }
      if (best) { tgt[i] = best; used.add(best); return; }
      const g = tgt[i] = this.newGroup();
      const j = ov[i].reduce((b, x, k) => (x > ov[i][b] ? k : b), 0), from = this.gs.get(olds[j]);
      if (from && from.visible) g.splitFrom = from.id;
    });
    const merged: [CoreGroup, CoreGroup][] = [];
    olds.forEach((o, j) => {
      const g = this.gs.get(o)!;
      if (used.has(g)) return;
      if (g.base || this.segs.some((s) => s.member && s.g === o && !inWin.has(s))) return; // 窗口外还有成员:留着
      const i = ov.reduce((b, r, k) => (r[j] > ov[b][j] ? k : b), 0), t = tgt[i];
      if (g.name && g.src && (!t.name || !t.src || RANK[g.src] > RANK[t.src])) { t.name = g.name; t.src = g.src; }
      if (g.visible && !t.visible) { t.splitFrom = undefined; } // 已显示的组并进还没显示的组:显示时算 new-group
      merged.push([g, t]);
    });
    cl.forEach((c, i) => { for (const s of c) s.g = tgt[i].id; });
    for (const [g] of merged) this.gs.delete(g.id);
    this.refresh();
    for (const g of [...this.gs.values()]) this.reveal(g, now);
    for (const [g, t] of merged) if (g.visible && this.gs.get(t.id) === t && t.visible) this.events.push({ kind: "merge", at: now, id: t.id, other: g.id });
    for (const s of this.segs) if (!s.member) this.labelShort(s);
    for (const s of W) { const g = this.group(s.g); if (g) s.sim = spkDot(s.vec, g.cent); }
  }
  /** 按成员重新算各组的和、段数、时长、质心;没成员也没 base 的组删掉 */
  private refresh() {
    for (const g of this.gs.values()) {
      g.sum = g.base ? Float32Array.from(g.base.sum) : zeros(); g.n = g.base ? g.base.n : 0; g.dur = g.base ? g.base.dur : 0;
    }
    for (const s of this.segs) if (s.member) { const g = this.group(s.g); if (g) { addTo(g.sum, s.vec); g.n++; g.dur += s.dur; } }
    for (const [id, g] of [...this.gs]) { if (g.n <= 0) this.gs.delete(id); else g.cent = spkNorm(g.sum); }
  }

  /** 按优先级改名(GPT、声纹库);返回改动 */
  propose(p: NameProposal[]): NameChange[] {
    const vis = this.visible(), r = applyNames(vis.map((g) => ({ id: g.id, dur: g.dur, name: g.name, src: g.src })), p);
    for (const c of r.changes) { const g = this.gs.get(c.id)!; g.name = c.to.name; g.src = c.to.src; }
    return r.changes;
  }
  /** 用户改名:直接写(manual 锁定,只有用户自己能改);name = null 清掉 */
  rename(id: number, name: string | null): boolean {
    const g = this.gs.get(id), nm = name && name.trim() || null; if (!g) return false;
    if (g.name === nm && g.src === (nm ? "manual" : null)) return false;
    g.name = nm; g.src = nm ? "manual" : null; return true;
  }
  /** 声纹库给已显示、够长、还没名字或名字来源更低的组起名(同名已被别的组占用的跳过) */
  nameFromLibrary(lib: LiveLibEntry[]): NameChange[] {
    if (!lib.length) return [];
    const vis = this.visible(), taken = (nm: string, id: number) => vis.some((g) => g.id !== id && g.name && g.name.toLowerCase() === nm.toLowerCase());
    const hits = libMatch(vis.map((g) => ({ id: g.id, cent: g.cent, dur: g.dur })), lib, this.C).filter((m) => !taken(m.name, m.id));
    return this.propose(hits.map((m) => ({ id: m.id, name: m.name, src: "library" as const })));
  }
  /** 最近一段时间的事件 */
  recent(now: number): CoreEvent[] { this.events = this.events.filter((e) => e.at > now - this.C.eventsMs); return this.events; }

  save(): SavedGroups { return { next: this.next, groups: this.visible().map((g) => ({ id: g.id, name: g.name, src: g.src, cent: f32b64(g.cent), dur: Math.round(g.dur * 10) / 10, n: g.n })) }; }
  /** 读回存下的组(刷新页面后):只有质心,当作 base;已有的组不动 */
  load(o: SavedGroups | null | undefined): void {
    if (!o || !Array.isArray(o.groups)) return;
    for (const x of o.groups) {
      if (this.gs.has(x.id)) continue;
      const cent = spkNorm(b64f32(x.cent)), n = Math.max(1, x.n || 1), sum = Float32Array.from(cent, (v) => v * n);
      this.gs.set(x.id, { id: x.id, name: x.name, src: x.src, visible: true, sum: Float32Array.from(sum), n, dur: x.dur, cent, base: { sum, n, dur: x.dur } });
    }
    this.next = Math.max(this.next, o.next || 0, ...o.groups.map((g) => g.id + 1));
  }
}
