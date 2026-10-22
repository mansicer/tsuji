// 实时说话人标签的评测:拿实时给出的标签(组字母或名字)对照参考标注(测试脚本或 C 的重新分析),
// 算准确率、覆盖率、改口次数(churn)、按说话人的明细、出标签的延迟。纯函数,时间单位与输入一致(一般是毫秒)

export interface EvalLine { aStart: number; aEnd: number; label: string | null; history?: { at: number; label: string | null }[] }
export interface RefSeg { start: number; end: number; speaker: string }
export interface EvalOpts {
  /** one-to-one:一个参考说话人只配一个标签(匈牙利算法,严格);many-to-one:每个标签各自取重叠最多的人(宽松,分裂的组也算对) */
  mode?: "one-to-one" | "many-to-one";
  /** 标签和参考说话人同名(忽略大小写)就直接对应,不再按重叠重新映射,这样叫错名字会算错。默认 true */
  byName?: boolean;
}
export interface EvalMap { label: string; speaker: string | null; overlap: number; lines: number; pinned: boolean }
export interface EvalSpeaker { speaker: string; lines: number; labelled: number; correct: number; accuracy: number | null; coverage: number | null; as: Record<string, number> }
export interface EvalLineResult { refs: string[]; label: string | null; mapped: string | null; ok: boolean | null; changes: number; ttfl: number | null }
export interface EvalStats { n: number; mean: number; median: number; p90: number; max: number }
export interface EvalResult {
  lines: number;
  /** 有最终标签的句 */
  labelled: number;
  /** 有标签且有参考(准确率的分母) */
  scored: number;
  correct: number;
  /** 和参考没有任何重叠的句(不计准确率) */
  unref: number;
  accuracy: number | null;
  coverage: number | null;
  /** 出过标签的句,平均每句出标签之后又改了几次 */
  churn: number | null;
  changes: number;
  churned: number;
  mapping: EvalMap[];
  speakers: EvalSpeaker[];
  /** 句子结束(aEnd)到第一次出标签的延迟,需要 history */
  ttfl: EvalStats | null;
  perLine: EvalLineResult[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** 某人的若干段和 [a, b] 的重叠总长(同一人的段先合并,重叠的段不重复计) */
function overlap(segs: RefSeg[], a: number, b: number): number {
  const iv = segs.map((s) => [Math.max(a, s.start), Math.min(b, s.end)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  let sum = 0, cs = -Infinity, ce = -Infinity;
  for (const [s, e] of iv) {
    if (s > ce) { if (ce > cs) sum += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e);
  }
  return sum + (ce > cs ? ce - cs : 0);
}

/** 匈牙利算法(最大化),w[行][列] ≥ 0;返回每行配到的列,-1 = 没配上(或权重为 0) */
export function hungarian(w: number[][]): number[] {
  const n = w.length, m = n ? w[0].length : 0, k = Math.max(n, m), res = new Array<number>(n).fill(-1);
  if (!n || !m) return res;
  const c = (i: number, j: number) => (i < n && j < m ? -w[i][j] : 0);
  const u = new Array<number>(k + 1).fill(0), v = new Array<number>(k + 1).fill(0), p = new Array<number>(k + 1).fill(0), way = new Array<number>(k + 1).fill(0);
  for (let i = 1; i <= k; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array<number>(k + 1).fill(Infinity), used = new Array<boolean>(k + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let d = Infinity, j1 = 0;
      for (let j = 1; j <= k; j++) if (!used[j]) {
        const cur = c(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < d) { d = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= k; j++) if (used[j]) { u[p[j]] += d; v[j] -= d; } else minv[j] -= d;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  for (let j = 1; j <= k; j++) if (p[j] && p[j] <= n && j <= m && w[p[j] - 1][j - 1] > 0) res[p[j] - 1] = j - 1;
  return res;
}

function stats(xs: number[]): EvalStats | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), q = (f: number) => s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, p90: q(0.9), max: s[s.length - 1] };
}

/** 一句的标签历史:改了几次(第一次出标签之后)、第一次出标签的时间 */
function history(l: EvalLine): { changes: number; first: number | null; ever: boolean } {
  const h = [...(l.history || [])].sort((a, b) => a.at - b.at), seq = h.map((x) => x.label);
  if (seq[seq.length - 1] !== l.label) seq.push(l.label); // history 没含最终标签时补上
  const f = seq.findIndex((x) => x !== null);
  if (f < 0) return { changes: 0, first: null, ever: false };
  let changes = 0;
  for (let i = f + 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes++;
  const fh = h.find((x) => x.label !== null);
  return { changes, first: fh ? fh.at : null, ever: true };
}

export function evaluate(lines: EvalLine[], ref: RefSeg[], opts: EvalOpts = {}): EvalResult {
  const mode = opts.mode || "one-to-one", byName = opts.byName !== false;
  const spk = [...new Set(ref.map((r) => r.speaker))].sort(), bySpk = new Map(spk.map((s) => [s, ref.filter((r) => r.speaker === s)]));
  // 每句和每个参考说话人的重叠;长度为 0 的句按时间点算
  const ov = lines.map((l) => spk.map((s) => {
    const segs = bySpk.get(s)!;
    return l.aEnd > l.aStart ? overlap(segs, l.aStart, l.aEnd) : segs.some((r) => r.start <= l.aStart && l.aStart <= r.end) ? 1e-9 : 0;
  }));
  const refs = ov.map((o) => {
    const mx = Math.max(0, ...o);
    return mx > 0 ? spk.filter((_, j) => o[j] > 0 && o[j] >= mx * (1 - 1e-9)) : [];
  });
  // 标签 → 参考说话人
  const labels = [...new Set(lines.map((l) => l.label).filter((x): x is string => x !== null))].sort();
  const W = labels.map((lb) => spk.map((_, j) => lines.reduce((a, l, i) => (l.label === lb ? a + ov[i][j] : a), 0)));
  const map = new Map<string, number>(), pinned = new Set<string>();
  if (byName) labels.forEach((lb) => { const j = spk.findIndex((s) => norm(s) === norm(lb)); if (j >= 0) { map.set(lb, j); pinned.add(lb); } });
  const free = labels.map((_, i) => i).filter((i) => !pinned.has(labels[i]));
  if (mode === "many-to-one") {
    for (const i of free) { const mx = Math.max(0, ...W[i]); if (mx > 0) map.set(labels[i], W[i].indexOf(mx)); }
  } else {
    const taken = new Set(map.values()), cols = spk.map((_, j) => j).filter((j) => !taken.has(j));
    hungarian(free.map((i) => cols.map((j) => W[i][j]))).forEach((c, r) => { if (c >= 0) map.set(labels[free[r]], cols[c]); });
  }
  const mapped = (lb: string | null) => (lb === null || !map.has(lb) ? null : spk[map.get(lb)!]);
  const mapping: EvalMap[] = labels.map((lb, i) => {
    const j = map.get(lb);
    return { label: lb, speaker: j === undefined ? null : spk[j], overlap: j === undefined ? 0 : W[i][j], lines: lines.filter((l) => l.label === lb).length, pinned: pinned.has(lb) };
  });
  // 逐句
  const ttfl: number[] = [];
  let changes = 0, churned = 0, ever = 0;
  const perLine: EvalLineResult[] = lines.map((l, i) => {
    const h = history(l), m = mapped(l.label), t = h.first === null ? null : h.first - l.aEnd;
    if (h.ever) { ever++; changes += h.changes; if (h.changes) churned++; }
    if (t !== null) ttfl.push(t);
    return { refs: refs[i], label: l.label, mapped: m, ok: l.label === null || !refs[i].length ? null : m !== null && refs[i].includes(m), changes: h.changes, ttfl: t };
  });
  const labelled = lines.filter((l) => l.label !== null).length, scoredL = perLine.filter((r) => r.ok !== null), correct = scoredL.filter((r) => r.ok).length;
  const speakers: EvalSpeaker[] = spk.map((s) => {
    const mine = perLine.filter((r) => r.refs[0] === s), lab = mine.filter((r) => r.label !== null), ok = lab.filter((r) => r.ok).length, as: Record<string, number> = {};
    for (const r of lab) { const k = r.mapped ?? `(${r.label})`; as[k] = (as[k] || 0) + 1; }
    return { speaker: s, lines: mine.length, labelled: lab.length, correct: ok, accuracy: lab.length ? ok / lab.length : null, coverage: mine.length ? lab.length / mine.length : null, as };
  });
  return {
    lines: lines.length, labelled, scored: scoredL.length, correct, unref: refs.filter((r) => !r.length).length,
    accuracy: scoredL.length ? correct / scoredL.length : null, coverage: lines.length ? labelled / lines.length : null,
    churn: ever ? changes / ever : null, changes, churned, mapping, speakers, ttfl: stats(ttfl), perLine,
  };
}

const pct = (x: number | null) => (x === null ? "–" : (x * 100).toFixed(1) + "%");
const sec = (ms: number) => (ms / 1000).toFixed(2) + "s";

/** 给控制台/日志看的文字报告(时间按毫秒换算成秒) */
export function formatReport(r: EvalResult): string {
  const out = [
    `lines ${r.lines} · labelled ${r.labelled} (coverage ${pct(r.coverage)}) · correct ${r.correct}/${r.scored} (accuracy ${pct(r.accuracy)})` + (r.unref ? ` · ${r.unref} without reference` : ""),
    `churn ${r.churn === null ? "–" : r.churn.toFixed(2)} changes/line (${r.changes} changes on ${r.churned} lines)`,
    r.ttfl ? `time to first label: n=${r.ttfl.n} mean ${sec(r.ttfl.mean)} median ${sec(r.ttfl.median)} p90 ${sec(r.ttfl.p90)} max ${sec(r.ttfl.max)}` : "time to first label: –",
    "mapping:" + (r.mapping.length ? "" : " –"),
    ...r.mapping.map((m) => `  ${m.label} → ${m.speaker ?? "–"}${m.pinned ? " (by name)" : ""} · ${m.lines} lines · overlap ${sec(m.overlap)}`),
    "speaker: lines labelled correct accuracy coverage",
    ...r.speakers.map((s) => `  ${s.speaker}: ${s.lines} ${s.labelled} ${s.correct} ${pct(s.accuracy)} ${pct(s.coverage)}` + (Object.keys(s.as).length ? ` · as ${Object.entries(s.as).map(([k, v]) => `${k}×${v}`).join(", ")}` : "")),
  ];
  return out.join("\n");
}
