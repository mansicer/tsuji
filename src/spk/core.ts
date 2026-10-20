// 说话人识别的纯计算部分:重采样、能量切分、fbank、聚类(不碰 DOM,node 下可直接测)
export const SPK_SR = 16000, SPK_DIM = 192;
const W = 12;
// 24 kHz int16 → 16 kHz 用的两组加窗 sinc 低通核(截止 7.6 kHz),对应 1.5 步长的整数/半数相位
const SPK_RS: Float32Array[] = (() => {
  const fc = 7600 / 24000;
  return [0, 0.5].map((fr) => {
    const k = new Float32Array(2 * W); let sum = 0;
    for (let j = 0; j < 2 * W; j++) { const d = j - W + 1 - fr, x = 2 * fc * d; k[j] = 2 * fc * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos(Math.PI * d / W)); sum += k[j]; }
    for (let j = 0; j < 2 * W; j++) k[j] /= sum;
    return k;
  });
})();
/** 24 kHz int16 的 [a, b) 一段 → 16 kHz float32 */
export function spkResample(pcm: Int16Array, a: number, b: number): Float32Array {
  const n = Math.floor((b - a) * 2 / 3), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = a + i * 1.5, base = Math.floor(t), k = SPK_RS[t - base ? 1 : 0]; let s = 0;
    for (let j = 0; j < 2 * W; j++) { const m = base + j - W + 1; if (m >= 0 && m < pcm.length) s += pcm[m] * k[j]; }
    out[i] = s / 32768;
  }
  return out;
}
export type Seg = [number, number];
/** 能量切分:20 ms 一帧,高于「第 20 百分位 + rel dB」算有声;静音超过 gap 秒就切开;超过 4.5 秒的段按 3 秒一段切。返回 [[s, e], ...](秒) */
export function spkSegments(pcm: Int16Array, sr: number, gap = 0.25, rel = 10, minDur = 0.6): Seg[] {
  const F = Math.round(sr * 0.02), n = Math.floor(pcm.length / F), db = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * F; j < (i + 1) * F; j++) { const v = pcm[j] / 32768; s += v * v; } db[i] = 20 * Math.log10(Math.sqrt(s / F) + 1e-6); }
  const th = Float32Array.from(db).sort()[Math.floor(n * 0.2)] + rel, out: Seg[] = [];
  for (let i = 0; i < n;) {
    if (db[i] <= th) { i++; continue; }
    let j = i, sil = 0;
    while (j < n && sil < gap / 0.02) { sil = db[j] > th ? 0 : sil + 1; j++; }
    let s = i * 0.02; const e = (j - sil) * 0.02; i = j;
    while (e - s > 4.5) { out.push([s, s + 3]); s += 3; }
    if (e - s >= minDur) out.push([s, e]);
  }
  return out;
}
// Kaldi 兼容 fbank(和 sherpa-onnx 的 CAM++ 前处理一致):25 ms 窗 / 10 ms 移、povey 窗、预加重 0.97、80 维 mel(20–7600 Hz)、不截边,再减去整段均值
const SPK_FB = (() => {
  const N = 512, win = new Float32Array(400), mel = (f: number) => 1127 * Math.log(1 + f / 700);
  for (let i = 0; i < 400; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / 399), 0.85);
  const lo = mel(20), hi = mel(7600), dm = (hi - lo) / 81, banks: { first: number; w: Float32Array }[] = [];
  for (let b = 0; b < 80; b++) {
    const l = lo + b * dm, c = l + dm, r = c + dm, w: number[] = []; let first = -1;
    for (let i = 0; i < N / 2; i++) { const m = mel(i * SPK_SR / N); if (m > l && m < r) { if (first < 0) first = i; w.push(m <= c ? (m - l) / (c - l) : (r - m) / (r - c)); } }
    banks.push({ first, w: Float32Array.from(w) });
  }
  const rev = new Uint16Array(N), cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 1, x = i; b < N; b <<= 1, x >>= 1) r = (r << 1) | (x & 1); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  return { N, win, banks, rev, cos, sin };
})();
/** 16 kHz float32 → T×80 的 log-mel(行优先) */
export function spkFbank(x: Float32Array): { data: Float32Array; T: number } {
  const { N, win, banks, rev, cos, sin } = SPK_FB, L = 400, S = 160, T = Math.floor((x.length + S / 2) / S);
  const out = new Float32Array(T * 80), re = new Float32Array(N), im = new Float32Array(N), fr = new Float32Array(L), n = x.length;
  for (let t = 0; t < T; t++) {
    const st = t * S + S / 2 - L / 2; let mean = 0;
    for (let i = 0; i < L; i++) { let k = st + i; if (k < 0) k = -k - 1; else if (k >= n) k = 2 * n - 1 - k; fr[i] = x[Math.max(0, Math.min(n - 1, k))]; mean += fr[i]; }
    mean /= L; for (let i = 0; i < L; i++) fr[i] -= mean;
    for (let i = L - 1; i > 0; i--) fr[i] -= 0.97 * fr[i - 1];
    fr[0] -= 0.97 * fr[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < L; i++) re[rev[i]] = fr[i] * win[i];
    for (let size = 2; size <= N; size <<= 1) {
      const h = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h, wr = cos[j * step], wi = sin[j * step];
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let b = 0; b < 80; b++) {
      const { first, w } = banks[b]; let e = 0;
      for (let i = 0; i < w.length; i++) { const k = first + i; e += w[i] * (re[k] * re[k] + im[k] * im[k]); }
      out[t * 80 + b] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }
  for (let b = 0; b < 80; b++) { let m = 0; for (let t = 0; t < T; t++) m += out[t * 80 + b]; m /= T || 1; for (let t = 0; t < T; t++) out[t * 80 + b] -= m; }
  return { data: out, T };
}
type Vec = ArrayLike<number>;
/** 两两余弦(n×n 行优先,对角线为 0),和逐对 spkDot 逐位相同 */
export function spkSims(vecs: Vec[]): Float64Array {
  const n = vecs.length, S = new Float64Array(n * n), D = n ? vecs[0].length : 0, X = new Float64Array(n * D);
  for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) X[i * D + d] = vecs[i][d];
  // 一次算四对:每对仍按 d 顺序累加(和 spkDot 逐位相同),四个累加器互不依赖,快一倍多
  for (let i = 0; i < n; i++) {
    const a = i * D; let j = i + 1;
    for (; j + 3 < n; j += 4) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0; const b0 = j * D, b1 = b0 + D, b2 = b1 + D, b3 = b2 + D;
      for (let d = 0; d < D; d++) { const x = X[a + d]; s0 += x * X[b0 + d]; s1 += x * X[b1 + d]; s2 += x * X[b2 + d]; s3 += x * X[b3 + d]; }
      S[i * n + j] = S[j * n + i] = s0; S[i * n + j + 1] = S[(j + 1) * n + i] = s1; S[i * n + j + 2] = S[(j + 2) * n + i] = s2; S[i * n + j + 3] = S[(j + 3) * n + i] = s3;
    }
    for (; j < n; j++) { let s = 0; const b = j * D; for (let d = 0; d < D; d++) s += X[a + d] * X[b + d]; S[i * n + j] = S[j * n + i] = s; }
  }
  return S;
}
/**
 * 平均连接层次聚类(余弦):相似度低于 1 - dist 就停。返回每个输入的簇号。
 * 每行缓存右上三角(j > i)里最大的相似度和它的列(同值取最小的 j),每次合并只重算受影响的行:
 * 合并顺序、平局取法、数值都和逐对全扫一遍完全一样,但一般是 O(n²) 而不是 O(n³)。
 * S 可以传入已算好的 spkSims(vecs)(会被改写)
 */
export function spkCluster(vecs: Vec[], dist: number, S: Float64Array = spkSims(vecs)): Int32Array {
  const n = vecs.length, size = new Int32Array(n).fill(1), alive = new Uint8Array(n).fill(1), lab = Int32Array.from({ length: n }, (_, i) => i);
  const bv = new Float64Array(n), bc = new Int32Array(n);
  const row = (i: number) => {
    let v = -Infinity, c = -1;
    for (let j = i + 1; j < n; j++) if (alive[j] && S[i * n + j] > v) { v = S[i * n + j]; c = j; }
    bv[i] = v; bc[i] = c;
  };
  for (let i = 0; i < n; i++) row(i);
  for (;;) {
    let best = -Infinity, bi = -1;
    for (let i = 0; i < n; i++) if (alive[i] && bc[i] >= 0 && bv[i] > best) { best = bv[i]; bi = i; }
    if (bi < 0 || best < 1 - dist) break;
    const bj = bc[bi];
    for (let k = 0; k < n; k++) if (alive[k] && k !== bi && k !== bj) S[bi * n + k] = S[k * n + bi] = (size[bi] * S[bi * n + k] + size[bj] * S[bj * n + k]) / (size[bi] + size[bj]);
    size[bi] += size[bj]; alive[bj] = 0;
    for (let k = 0; k < n; k++) if (lab[k] === bj) lab[k] = bi;
    row(bi);
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi) continue;
      if (bc[k] === bi || bc[k] === bj) row(k); // 这一行的最大值变了或那一列没了:整行重算
      else if (k < bi) { const v = S[k * n + bi]; if (v > bv[k] || (v === bv[k] && bi < bc[k])) { bv[k] = v; bc[k] = bi; } }
    }
  }
  return lab;
}
export function spkNorm(v: Vec): Float32Array { let s = 0; for (let d = 0; d < v.length; d++) s += v[d] * v[d]; s = Math.sqrt(s) || 1; return Float32Array.from(v as ArrayLike<number>, (x) => x / s); }
export function spkDot(a: Vec, b: Vec): number { let s = 0; for (let d = 0; d < a.length; d++) s += a[d] * b[d]; return s; }
/**
 * 前后文平滑(Viterbi):短片段单看声纹不可靠,结合前后片段一起定。
 * segs = 按时间排好的 [s0, e0, s1, e1, ...](秒);sims = 每段与各组质心的余弦(n×K 行优先)。
 * 发射分 = 相似度 / temp × min(时长, 4 秒);换人惩罚 = pen × e^(-停顿秒数),停顿越长越容易换人。
 * temp 0.1 / pen 1.0 在 MyGO #198(声优回)、#199(角色回)官方字幕颜色标注上都最好(按时长准确率 85.7→87.7%、98.9→99.8%)。
 */
export function spkSmooth(segs: ArrayLike<number>, sims: ArrayLike<number>, K: number, temp = 0.1, pen = 1.0): Int16Array {
  const n = segs.length / 2, lab = new Int16Array(n);
  if (!n || K < 2) return lab;
  const V = new Float64Array(K), NV = new Float64Array(K), B = new Int16Array(n * K);
  const emit = (i: number, k: number) => (sims[i * K + k] / temp) * Math.min(segs[2 * i + 1] - segs[2 * i], 4);
  for (let k = 0; k < K; k++) V[k] = emit(0, k);
  for (let i = 1; i < n; i++) {
    const p = pen * Math.exp(-Math.max(0, segs[2 * i] - segs[2 * i - 1]));
    let best = 0; for (let k = 1; k < K; k++) if (V[k] > V[best]) best = k;
    for (let k = 0; k < K; k++) {
      const stay = V[k], move = V[best] - p; // 从别的组转过来:只需看最好的那个(和自己相同时就是 stay)
      if (best === k || stay >= move) { NV[k] = stay; B[i * K + k] = k; } else { NV[k] = move; B[i * K + k] = best; }
      NV[k] += emit(i, k);
    }
    let m = -Infinity; for (let k = 0; k < K; k++) if (NV[k] > m) m = NV[k];
    for (let k = 0; k < K; k++) V[k] = NV[k] - m; // 防止数值越来越大
  }
  let k = 0; for (let j = 1; j < K; j++) if (V[j] > V[k]) k = j;
  for (let i = n - 1; i >= 0; i--) { lab[i] = k; k = B[i * K + k]; }
  return lab;
}
