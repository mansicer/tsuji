// 实时说话人的纯计算部分:在线分组、组的延迟显示、短片段规则、定期整体重新聚类(匈牙利对应保持组号和名字)、
// 组质心对照声纹库(按声纹来源分阈值)。不碰 DOM,node 下可直接用合成向量测
import { SPK_DIM, spkCluster, spkDot, spkNorm, spkSims } from "./core";
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
  /**
   * 主要的组:已显示、时长 ≥ 全部已显示组的 majorFrac(或已由声纹库 / 用户起名、用户确认过)。它们加起来 ≥ majorCover 时,
   * 其余小组和没跟上组的短片段都按声纹归到最近的主要组(余弦 ≥ majorSim);分得太碎(主要组不够)时不归并。
   * 只说了几句的人也会被归走(不同人的余弦常常也过 0.3),要用户「只改这一句 → 另一个人」确认后才单独显示
   */
  majorFrac: 0.1, majorCover: 0.3, majorSim: 0.3,
  /** 整体重新聚类:每 reclusterMs 毫秒或每 reclusterN 个新片段一次,只取最近 keep 段 */
  reclusterMs: 30_000, reclusterN: 10, keep: 400,
  /** 积压:队首的句子结束已超过这么久(毫秒)就丢掉,不让流水线越拖越远 */
  maxLag: 30_000,
  /** 事件保留多久(毫秒) */
  eventsMs: 3_600_000,
};
export type LiveSpkCfg = typeof LIVE_SPK;

/** 一句字幕对应的一个片段 */
export interface LiveSeg {
  line: number; dur: number; vec: Float32Array; g: number | null; sim: number; member: boolean;
  /** 用户指定的组(「只改这一句」):重新聚类、归并都不改它,它的声纹算进这个组 */
  pin?: number;
}
/** 组。id < 0 = 还没显示的临时组;显示时换成正式 id(字母由 id 定) */
export interface CoreGroup {
  id: number; name: string | null; src: NameSrc | null; visible: boolean;
  sum: Float32Array; n: number; dur: number; cent: Float32Array;
  /** 刷新前存下的组(只有质心,没有片段) */
  base: { sum: Float32Array; n: number; dur: number } | null;
  /** 重新聚类时从哪个已显示的组拆出来的 */
  splitFrom?: number;
  /** 用户确认过是单独一个人(「只改这一句」指到它):算主要的组,不并到别的组 */
  ok?: boolean;
}
export interface CoreEvent { kind: "new-group" | "merge" | "split"; at: number; id: number; other?: number }
/** 存进 IndexedDB 的组(质心 base64) */
export interface SavedGroups { next: number; groups: { id: number; name: string | null; src: NameSrc | null; cent: string; dur: number; n: number; ok?: boolean }[] }

const RANK: Record<NameSrc, number> = { "gpt-guess": 0, "gpt-evidence": 1, library: 2, manual: 3 };
/** 组号 → 字母:0 → A … 25 → Z,26 → AA */
export function letterOf(id: number): string { let s = "", k = id; do { s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26) - 1; } while (k >= 0); return s; }
export const f32b64 = (v: ArrayLike<number>): string => { const b = new Uint8Array(Float32Array.from(v).buffer); let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
export const b64f32 = (s: string): Float32Array => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
const sameName = (a: string | null, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
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
  /** 模板有声纹库时为 true:新组先不报 new-group,等声纹库对照过(够 libDur 秒)还没认出来再报,免得 GPT 抢在声纹库前面 */
  deferNew = false;
  private pendingNew = new Set<number>();
  next = 0;
  /** 上次整体重新聚类之后新增的片段数 */
  fresh = 0;
  private tmp = -1;
  private byLine = new Map<number, LiveSeg>();
  /** 上次重新聚类的窗口和两两余弦 */
  private simCache: { W: LiveSeg[]; S: Float64Array } | null = null;
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
    if (from && from.visible) this.events.push({ kind: "split", at: now, id: g.id, other: from.id });
    else if (this.deferNew) this.pendingNew.add(g.id);
    else this.events.push({ kind: "new-group", at: now, id: g.id });
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
    const pg = old && old.pin != null ? this.gs.get(old.pin) : undefined; // 用户指定过的句子并进来又变长了:还归那个组
    if (pg) { s.pin = pg.id; s.member = true; this.join(pg, s); s.sim = spkDot(vec, pg.cent); this.fresh++; return s; }
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
  /** 主要的组(LIVE_SPK.majorFrac);分得太碎时为 null(不归并) */
  majors(): CoreGroup[] | null {
    const vis = this.visible(), tot = vis.reduce((a, g) => a + g.dur, 0);
    const M = vis.filter((g) => g.dur >= this.C.majorFrac * tot || g.src === "library" || g.src === "manual" || g.ok);
    return M.length && M.reduce((a, g) => a + g.dur, 0) >= this.C.majorCover * tot ? M : null;
  }
  /** 这句现在的标签:用户指定的组优先;小组、没跟上组的短片段归到最近的主要组;都不够近时 g = null。M:调用方算好的 majors() */
  label(line: number, M: CoreGroup[] | null = this.majors()): { g: number | null; conf: number } | null {
    const s = this.byLine.get(line); if (!s) return null;
    const r = (x: number) => Math.round(x * 1000) / 1000, pg = s.pin != null ? this.gs.get(s.pin) : undefined;
    if (pg) return { g: pg.id, conf: r(spkDot(s.vec, pg.cent)) };
    const g = this.group(s.g);
    if (M && !(g && M.includes(g))) {
      let best: CoreGroup | null = null, bs = this.C.majorSim;
      for (const m of M) { const x = spkDot(s.vec, m.cent); if (x >= bs) { bs = x; best = m; } }
      if (best) return { g: best.id, conf: r(bs) };
    }
    return g && g.visible ? { g: g.id, conf: r(spkDot(s.vec, g.cent)) } : { g: null, conf: r(s.sim) };
  }
  /**
   * 用户纠正这一句(「只改这一句」):to = 组号,或 "new" = 另一个人。"new" 时这句原来在一个小组里(被归到了主要组)就确认那个组,
   * 否则用这句开一个新组。被指到的组标成用户确认过(ok):算主要的组、不会被归并;这句的声纹算进去,之后的句子按它分组。
   * 返回这句现在的组号
   */
  pin(line: number, to: number | "new", now: number): number | null {
    const s = this.byLine.get(line); if (!s) return null;
    const own = s.member ? this.group(s.g) : undefined;
    let g = to === "new" ? undefined : this.gs.get(to);
    if (to === "new") {
      const M = this.majors();
      if (own && own.visible && own.id !== s.pin && M && !M.includes(own)) g = own;
    } else if (!g || !g.visible) return null;
    if (!g || g !== own) {
      if (s.member) this.detach(s);
      if (!g) g = this.newGroup();
      s.member = true; this.join(g, s);
      if (!g.visible) { const old = g.id; g.id = this.next++; g.visible = true; this.gs.delete(old); this.gs.set(g.id, g); s.g = g.id; this.events.push({ kind: "new-group", at: now, id: g.id }); }
    }
    g.ok = true; s.pin = g.id; s.sim = spkDot(s.vec, g.cent);
    return g.id;
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
    const lab = spkCluster(W.map((s) => s.vec), C.dist, this.sims(W)), cm = new Map<number, LiveSeg[]>();
    W.forEach((s, i) => { const c = cm.get(lab[i]); if (c) c.push(s); else cm.set(lab[i], [s]); });
    const cl = [...cm.values()], olds = [...new Set(W.map((s) => s.g!))].filter((id) => this.gs.has(id));
    const ov = cl.map((c) => olds.map((o) => c.reduce((a, s) => a + (s.g === o ? s.dur * (s.pin === o ? 1000 : 1) : 0), 0)));
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
      if (g.base || this.segs.some((s) => (s.member && s.g === o && !inWin.has(s)) || s.pin === o)) return; // 窗口外还有成员、有用户指定的句子:留着
      const i = ov.reduce((b, r, k) => (r[j] > ov[b][j] ? k : b), 0), t = tgt[i];
      if (g.name && g.src && (!t.name || !t.src || RANK[g.src] > RANK[t.src])) { t.name = g.name; t.src = g.src; }
      if (g.visible && !t.visible) { t.splitFrom = undefined; } // 已显示的组并进还没显示的组:显示时算 new-group
      merged.push([g, t]);
    });
    cl.forEach((c, i) => { for (const s of c) s.g = s.pin != null && this.gs.has(s.pin) ? s.pin : tgt[i].id; });
    for (const [g] of merged) this.gs.delete(g.id);
    this.refresh();
    for (const g of [...this.gs.values()]) this.reveal(g, now);
    for (const [g, t] of merged) if (g.visible && this.gs.get(t.id) === t && t.visible) this.events.push({ kind: "merge", at: now, id: t.id, other: g.id });
    for (const s of this.segs) if (!s.member) this.labelShort(s);
    for (const s of W) { const g = this.group(s.g); if (g) s.sim = spkDot(s.vec, g.cent); }
  }
  /** 窗口里两两的余弦:上次重新聚类时算过的对直接拿(通常只多了十来段),和全算一遍逐位相同。返回的是副本(spkCluster 会改写) */
  private sims(W: LiveSeg[]): Float64Array {
    const n = W.length, old = this.simCache, at = new Map(old ? old.W.map((s, i) => [s, i] as const) : []), oi = Int32Array.from(W, (s) => at.get(s) ?? -1);
    let S: Float64Array;
    if (!old || oi.filter((x) => x >= 0).length < n / 2) S = spkSims(W.map((s) => s.vec));
    else {
      const on = old.W.length, P = old.S; S = new Float64Array(n * n);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S[i * n + j] = S[j * n + i] = oi[i] >= 0 && oi[j] >= 0 ? P[oi[i] * on + oi[j]] : spkDot(W[i].vec, W[j].vec);
    }
    this.simCache = { W, S };
    return S.slice();
  }
  /** 按成员重新算各组的和、段数、时长、质心;没成员也没 base 的组删掉 */
  private refresh() {
    for (const g of this.gs.values()) {
      g.sum = g.base ? Float32Array.from(g.base.sum) : zeros(); g.n = g.base ? g.base.n : 0; g.dur = g.base ? g.base.dur : 0;
    }
    for (const s of this.segs) if (s.member) { const g = this.group(s.g); if (g) { addTo(g.sum, s.vec); g.n++; g.dur += s.dur; } }
    for (const [id, g] of [...this.gs]) { if (g.n <= 0) this.gs.delete(id); else g.cent = spkNorm(g.sum); }
  }

  /** 按优先级改名(GPT、声纹库);返回改动。别的组已经用 library / manual 占着的名字,来源更低的不能再给 */
  propose(p: NameProposal[]): NameChange[] {
    // 名字已被别的组占着:那个组是 library / manual 且来源更高,或者来源不低于这次提案(GPT 不能把同一个名字给第二个组,
    // 否则两组同名、下一轮又改回去,标签来回翻);同一批里那个组也改了名(GPT 整体纠正)不算占着
    const vis = this.visible(), moved = (id: number, nm: string) => p.some((y) => y.id === id && !sameName(y.name, nm));
    const held = (x: NameProposal) => vis.some((g) => g.id !== x.id && sameName(g.name, x.name) && g.src && RANK[x.src] <= RANK[g.src] && (RANK[g.src] >= RANK.library ? RANK[x.src] < RANK[g.src] : !moved(g.id, x.name)));
    const r = applyNames(vis.map((g) => ({ id: g.id, dur: g.dur, name: g.name, src: g.src })), p.filter((x) => !held(x)));
    for (const c of r.changes) { const g = this.gs.get(c.id)!; g.name = c.to.name; g.src = c.to.src; }
    // 来源更高的 GPT 名字拿走了别的组的同名:那个组的低来源同名清掉(声纹库的同类处理在 nameFromLibrary)
    for (const c of r.changes) for (const g of vis) if (g.id !== c.id && sameName(g.name, c.to.name) && g.src && RANK[g.src] < RANK[c.to.src] && RANK[g.src] < RANK.library && !r.changes.some((d) => d.id === g.id)) { g.name = null; g.src = null; }
    return r.changes;
  }
  /** 用户改名:直接写(manual 锁定,只有用户自己能改);name = null 清掉 */
  rename(id: number, name: string | null): boolean {
    const g = this.gs.get(id), nm = name && name.trim() || null; if (!g) return false;
    if (g.name === nm && g.src === (nm ? "manual" : null)) return false;
    g.name = nm; g.src = nm ? "manual" : null; return true;
  }
  /**
   * 声纹库给已显示、够长、还没名字或名字来源更低的组起名。同名已被别的组用 library / manual 占着的跳过;
   * 别的组只是 GPT 给的同名(gpt-evidence / gpt-guess)不算占用,声纹库起名后把它们的这个名字清掉
   */
  nameFromLibrary(lib: LiveLibEntry[], now = Date.now()): NameChange[] {
    if (!lib.length) { this.announce(now, true); return []; }
    const vis = this.visible(), taken = (nm: string, id: number) => vis.some((g) => g.id !== id && sameName(g.name, nm) && (g.src === "library" || g.src === "manual"));
    const hits = libMatch(vis.map((g) => ({ id: g.id, cent: g.cent, dur: g.dur })), lib, this.C).filter((m) => !taken(m.name, m.id));
    const ch = this.propose(hits.map((m) => ({ id: m.id, name: m.name, src: "library" as const })));
    for (const c of ch) for (const g of vis) if (g.id !== c.id && sameName(g.name, c.to.name) && g.src && RANK[g.src] < RANK.library) { g.name = null; g.src = null; }
    this.announce(now, false);
    return ch;
  }
  /** 挂起的新组:声纹库已经对照过(够 libDur 秒,或 all)还没名字就报 new-group;合并掉的、已有名字的直接丢 */
  private announce(now: number, all: boolean) {
    for (const id of this.pendingNew) {
      const g = this.gs.get(id);
      if (!g || !g.visible || g.name) { this.pendingNew.delete(id); continue; }
      if (all || g.dur >= this.C.libDur) { this.events.push({ kind: "new-group", at: now, id }); this.pendingNew.delete(id); }
    }
  }
  /** 最近一段时间的事件 */
  recent(now: number): CoreEvent[] { this.events = this.events.filter((e) => e.at > now - this.C.eventsMs); return this.events; }

  save(): SavedGroups { return { next: this.next, groups: this.visible().map((g) => ({ id: g.id, name: g.name, src: g.src, cent: f32b64(g.cent), dur: Math.round(g.dur * 10) / 10, n: g.n, ...(g.ok ? { ok: true } : {}) })) }; }
  /** 读回存下的组(刷新页面后):只有质心,当作 base;已有的组不动 */
  load(o: SavedGroups | null | undefined): void {
    if (!o || !Array.isArray(o.groups)) return;
    for (const x of o.groups) {
      if (this.gs.has(x.id)) continue;
      const cent = spkNorm(b64f32(x.cent)), n = Math.max(1, x.n || 1), sum = Float32Array.from(cent, (v) => v * n);
      this.gs.set(x.id, { id: x.id, name: x.name, src: x.src, visible: true, sum: Float32Array.from(sum), n, dur: x.dur, cent, base: { sum, n, dur: x.dur }, ...(x.ok ? { ok: true } : {}) });
    }
    this.next = Math.max(this.next, o.next || 0, ...o.groups.map((g) => g.id + 1));
  }
}
