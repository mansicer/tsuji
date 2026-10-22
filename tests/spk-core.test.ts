import { describe, expect, it } from "vitest";
import { spkCluster, spkDot, spkFbank, spkNorm, spkResample, spkSegments, spkSmooth } from "../src/spk/core";

const tone = (sr: number, sec: number, hz: number, amp: number) => Int16Array.from({ length: Math.round(sr * sec) }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / sr)));
const cat = (...xs: Int16Array[]) => { const o = new Int16Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };

describe("spk core", () => {
  it("24 kHz → 16 kHz 保持幅度、长度 2/3", () => {
    const x = tone(24000, 1, 440, 16000), y = spkResample(x, 0, x.length);
    expect(y.length).toBe(16000);
    const peak = Math.max(...y.subarray(1000, 15000).map(Math.abs));
    expect(peak).toBeGreaterThan(0.47); expect(peak).toBeLessThan(0.51);
  });
  it("静音隔开的两段声音切成两段,超过 4.5 秒的段先切出 3 秒", () => {
    const sil = (s: number) => tone(24000, s, 0, 0);
    const segs = spkSegments(cat(sil(1), tone(24000, 1, 300, 8000), sil(1), tone(24000, 7, 300, 8000), sil(1)), 24000);
    expect(segs.length).toBe(3);
    expect(segs[0][0]).toBeCloseTo(1, 1); expect(segs[0][1]).toBeCloseTo(2, 1);
    expect(segs[1][1] - segs[1][0]).toBeCloseTo(3, 5); expect(segs[2][1] - segs[2][0]).toBeCloseTo(4, 1);
  });
  it("fbank 帧数:10 ms 一帧,不截边", () => {
    const x = spkResample(tone(24000, 1, 1000, 8000), 0, 24000), { data, T } = spkFbank(x);
    expect(T).toBe(100); expect(data.length).toBe(T * 80);
  });
  it("聚类把两组方向分开", () => {
    const a = [[1, 0.1, 0], [1, 0, 0.1], [0.9, 0.1, 0.1]], b = [[0, 1, 0.1], [0.1, 1, 0], [0, 0.9, 0.2]];
    const lab = spkCluster([...a, ...b].map(spkNorm), 0.5);
    expect(new Set(lab.slice(0, 3)).size).toBe(1); expect(new Set(lab.slice(3)).size).toBe(1); expect(lab[0]).not.toBe(lab[3]);
  });
  it("聚类(行缓存版)和逐对全扫的原始写法结果逐位相同:随机数据、平局、各种阈值", () => {
    let seed = 1; const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const g = () => { const u = Math.max(R(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); };
    const rv = (d: number) => spkNorm(Float32Array.from({ length: d }, g));
    for (const [n, k, noise, d] of [[0, 1, 0, 8], [1, 1, 0, 8], [2, 2, 0.5, 8], [40, 3, 0.5, 192], [150, 4, 0.6, 192], [300, 6, 0.9, 192], [60, 60, 0, 16]] as const) {
      const sp = Array.from({ length: k }, () => rv(d)), vecs = Array.from({ length: n }, () => { const b = sp[Math.floor(R() * k)], z = rv(d); return spkNorm(Float32Array.from(b, (x, i) => x + noise * z[i])); });
      // 平局:复制几个完全相同的向量
      if (n > 10) for (let i = 0; i < 5; i++) vecs[Math.floor(R() * n)] = vecs[Math.floor(R() * n)];
      for (const dist of [0.1, 0.38, 0.6, 1.2, 2.5]) expect(Array.from(spkCluster(vecs, dist))).toEqual(Array.from(naiveCluster(vecs, dist)));
    }
  });
  it("平滑:夹在同一人长段之间、声纹略偏向别人的短段,归回这个人;长停顿后的换人保留", () => {
    // 段:A 长 | 短段(略像 B) | A 长 | 停顿 3 秒 | B 长
    const segs = [0, 4, 4.1, 4.6, 4.7, 9, 12, 16];
    const sims = [0.8, 0.2, 0.45, 0.55, 0.8, 0.2, 0.2, 0.8];
    expect(Array.from(spkSmooth(segs, sims, 2))).toEqual([0, 0, 0, 1]);
  });
});

/** 原来的写法(O(n³) 逐对全扫),只用来对照 */
function naiveCluster(vecs: ArrayLike<number>[], dist: number): Int32Array {
  const n = vecs.length, S = new Float64Array(n * n), size = new Int32Array(n).fill(1), alive = new Uint8Array(n).fill(1), lab = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S[i * n + j] = S[j * n + i] = spkDot(vecs[i], vecs[j]);
  for (;;) {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && S[i * n + j] > best) { best = S[i * n + j]; bi = i; bj = j; }
    if (bi < 0 || best < 1 - dist) break;
    for (let k = 0; k < n; k++) if (alive[k] && k !== bi && k !== bj) S[bi * n + k] = S[k * n + bi] = (size[bi] * S[bi * n + k] + size[bj] * S[bj * n + k]) / (size[bi] + size[bj]);
    size[bi] += size[bj]; alive[bj] = 0;
    for (let k = 0; k < n; k++) if (lab[k] === bj) lab[k] = bi;
  }
  return lab;
}
