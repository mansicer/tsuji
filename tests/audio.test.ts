import { describe, expect, it } from "vitest";
import { Agc, CHUNK, Resampler, SIG_STEPS, sigStep, toBase64 } from "../src/audio";

function fromBase64(s: string): Int16Array {
  const b = atob(s), bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

describe("toBase64", () => {
  it("round-trips PCM16 samples", () => {
    const a = Int16Array.from([0, 1, -1, 32767, -32768, 1234, -4321]);
    expect(Array.from(fromBase64(toBase64(a)))).toEqual(Array.from(a));
    expect(toBase64(new Int16Array(0))).toBe("");
  });

  it("encodes only the viewed slice of a larger buffer", () => {
    const big = Int16Array.from({ length: 10 }, (_, i) => i * 100);
    const view = big.subarray(3, 6);
    expect(Array.from(fromBase64(toBase64(view)))).toEqual([300, 400, 500]);
  });

  it("handles inputs longer than one 0x8000-byte batch", () => {
    const a = Int16Array.from({ length: 40000 }, (_, i) => (i * 37) % 65536 - 32768);
    expect(Array.from(fromBase64(toBase64(a)))).toEqual(Array.from(a));
  });
});

describe("Resampler", () => {
  it("passes 24 kHz input through unchanged (same array)", () => {
    const r = new Resampler(24000), x = new Float32Array([0.1, 0.2]);
    expect(r.resample(x)).toBe(x);
  });

  it("halves the sample count from 48 kHz, carrying position across blocks", () => {
    const r = new Resampler(48000);
    const block = (n: number, start: number) => Float32Array.from({ length: n }, (_, i) => (start + i) / 10000);
    // 128 帧一块:每块正好 64 个输出
    let total = 0, start = 0;
    for (let k = 0; k < 10; k++) { const y = r.resample(block(128, start)); start += 128; expect(y.length).toBe(64); total += y.length; }
    expect(total).toBe(640);
    // 不整齐的块:总数仍是一半
    const r2 = new Resampler(48000);
    total = 0; start = 0;
    for (const n of [100, 37, 255, 8, 600]) { total += r2.resample(block(n, start)).length; start += n; }
    expect(total).toBe(500);
  });

  it("interpolates linearly on a ramp, including across block boundaries via prevSample", () => {
    const r = new Resampler(48000);
    const ramp = Float32Array.from({ length: 1000 }, (_, i) => i);
    const out: number[] = [];
    for (const [a, b] of [[0, 101], [101, 333], [333, 1000]]) out.push(...r.resample(ramp.subarray(a, b)));
    // 48k→24k 取偶数位置样本
    expect(out).toEqual(Array.from({ length: 500 }, (_, i) => 2 * i));
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("chunks into 2400-sample PCM16 frames and keeps the remainder in carry", () => {
    const r = new Resampler(48000);
    expect(CHUNK).toBe(2400);
    expect(r.chunk(new Float32Array(1000))).toEqual([]);
    expect(r.carry.length).toBe(1000);
    const c = r.chunk(new Float32Array(1500).fill(0.5));
    expect(c.length).toBe(1);
    expect(c[0].length).toBe(2400);
    expect(c[0][999]).toBe(0);
    expect(c[0][1000]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(r.carry.length).toBe(100);
    expect(r.chunk(new Float32Array(4800)).length).toBe(2);
    expect(r.carry.length).toBe(100);
  });

  it("resample + chunk across uneven 48 kHz blocks yields floor(total/2/2400) frames", () => {
    const r = new Resampler(48000);
    let frames = 0, inSamples = 0;
    const sizes = [128, 333, 4097, 1, 999, 128, 5000, 2222, 7];
    for (const n of sizes) { frames += r.chunk(r.resample(new Float32Array(n).fill(0.1))).length; inSamples += n; }
    const outSamples = inSamples / 2; // 13915 / 2 → 6957 或 6958
    expect(frames).toBe(Math.floor(outSamples / 2400));
    expect(frames * 2400 + r.carry.length).toBeGreaterThanOrEqual(Math.floor(outSamples) - 1);
    expect(frames * 2400 + r.carry.length).toBeLessThanOrEqual(Math.ceil(outSamples));
  });

  it("clips and scales asymmetrically like the original (0x8000 negative, 0x7fff positive, truncating)", () => {
    const r = new Resampler(24000);
    const x = new Float32Array(2400); x[0] = 2; x[1] = -2; x[2] = 1; x[3] = -1; x[4] = 0.25; x[5] = -0.25;
    const [pcm] = r.chunk(x);
    expect(Array.from(pcm.subarray(0, 6))).toEqual([32767, -32768, 32767, -32768, 8191, -8192]);
  });
});

describe("Agc", () => {
  const quiet = () => new Float32Array(1024).fill(0.001);

  it("starts at level 0.01 and gain 1", () => {
    const a = new Agc();
    expect(a.agcLevel).toBe(0.01);
    expect(a.agcGain).toBe(1);
  });

  it("raises gain for quiet input in auto mode", () => {
    const a = new Agc();
    let prev = a.agcGain;
    for (let k = 0; k < 50; k++) { a.apply(quiet(), "auto", 40, 0.14); expect(a.agcGain).toBeGreaterThan(prev); prev = a.agcGain; }
    const y = a.apply(quiet(), "auto", 40, 0.14);
    expect(y[0]).toBeCloseTo(0.001 * a.agcGain, 6);
  });

  it("caps the gain at maxGain", () => {
    const a = new Agc();
    for (let k = 0; k < 5000; k++) a.apply(quiet(), "auto", 10, 0.14);
    expect(a.agcGain).toBeLessThanOrEqual(10);
    expect(a.agcGain).toBeGreaterThan(9.99);
  });

  it("clips amplified samples to [-1, 1]", () => {
    const a = new Agc(); a.agcGain = 50;
    const y = a.apply(Float32Array.from([0.5, -0.5, 0.001]), 50, 40, 0.14);
    expect(y[0]).toBe(1);
    expect(y[1]).toBe(-1);
  });

  it("passes input through untouched in fixed 1× mode", () => {
    const a = new Agc(), x = new Float32Array(256).fill(0.3);
    for (let k = 0; k < 10; k++) expect(a.apply(x, "1", 40, 0.14)).toBe(x);
    expect(a.agcGain).toBe(1);
    expect(a.agcLevel).toBe(0.01); // 固定模式不跟踪电平
  });

  it("eases toward a fixed gain and treats junk as 1", () => {
    const a = new Agc();
    a.apply(new Float32Array(4).fill(0.1), "3", 40, 0.14);
    expect(a.agcGain).toBeCloseTo(1.02, 10);
    const b = new Agc(); b.apply(new Float32Array(4), "abc", 40, 0.14);
    expect(b.agcGain).toBe(1);
  });

  it("returns empty input as-is without touching state", () => {
    const a = new Agc(), x = new Float32Array(0);
    expect(a.apply(x, "auto", 40, 0.14)).toBe(x);
    expect(a.agcGain).toBe(1);
    expect(a.agcLevel).toBe(0.01);
  });
});

describe("sigStep", () => {
  it("counts how many thresholds the level reaches", () => {
    expect(SIG_STEPS).toEqual([0.03, 0.1, 0.22, 0.4, 0.7]);
    expect(sigStep(0)).toBe(0);
    expect(sigStep(0.0299)).toBe(0);
    expect(sigStep(0.03)).toBe(1);
    expect(sigStep(0.1)).toBe(2);
    expect(sigStep(0.22)).toBe(3);
    expect(sigStep(0.399)).toBe(3);
    expect(sigStep(0.4)).toBe(4);
    expect(sigStep(0.7)).toBe(5);
    expect(sigStep(4)).toBe(5);
    expect(sigStep(NaN)).toBe(0);
  });
});
