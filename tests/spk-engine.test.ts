import { beforeAll, describe, expect, it, vi } from "vitest";
import { spkNorm } from "../src/spk/core";
import type { Voice } from "../src/state";

// engine.ts 引入 config.ts(顶层用到 location)
vi.stubGlobal("location", { href: "http://localhost/" });
let E: typeof import("../src/spk/engine");
beforeAll(async () => { E = await import("../src/spk/engine"); });

const D = 192;
/** 第 k 个基向量加一点别的方向 */
const vec = (k: number, mix: [number, number][] = []) => { const v = new Float32Array(D); v[k] = 1; for (const [j, w] of mix) v[j] += w; return spkNorm(v); };
const voice = (v: Float32Array, alts: Float32Array[] = []): Voice => ({ v: E.f32b64(v), d: 10, ...(alts.length ? { alts: alts.map((a) => ({ v: E.f32b64(a), d: 5, src: "live" as const })) } : {}) });

describe("spk engine library", () => {
  it("base64 往返不变", () => {
    const v = vec(3, [[7, 0.3]]);
    expect(Array.from(E.b64f32(E.f32b64(v)))).toEqual(Array.from(v));
  });
  it("三条规则:最低相似度、比第二像的高出 margin、互为最像", () => {
    const lib = { A: voice(vec(0)), B: voice(vec(1)) };
    expect(E.match(vec(0, [[5, 0.2]]), lib)?.name).toBe("A");
    expect(E.match(vec(0, [[5, 0.7]]), lib)).toBeNull(); // 余弦 0.82 < 0.88
    expect(E.match(vec(0, [[5, 0.7]]), lib, { min: 0.8 })?.name).toBe("A"); // 阈值可调
    expect(E.match(vec(0, [[1, 0.98]]), lib, { min: 0 })).toBeNull(); // 和 A、B 一样像:margin 不够
    expect(E.match(vec(0, [[5, 0.3]]), lib, { others: [vec(0, [[5, 0.1]])] })).toBeNull(); // 别的组更像 A
  });
  it("一个人取 v 和所有 alts 里最像的", () => {
    const live = vec(9), lib = { A: voice(vec(0), [live]), B: voice(vec(1)) };
    const m = E.match(vec(9, [[4, 0.1]]), lib);
    expect(m?.name).toBe("A"); expect(m!.sim).toBeGreaterThan(0.99);
    expect(E.libEntries(lib).map((e) => e.vecs.length)).toEqual([2, 1]);
    expect(E.match(vec(9), { A: voice(vec(0)), B: voice(vec(1)) })).toBeNull(); // 没有 alts 时对不上
  });
  it("matchAll 在这组声纹之内判断互为最像", () => {
    const lib = { A: voice(vec(0)), B: voice(vec(1)) };
    const r = E.matchAll([vec(0, [[5, 0.1]]), vec(1, [[6, 0.1]]), vec(0, [[5, 0.3]])], lib);
    expect(r.map((m) => m && m.name)).toEqual(["A", "B", null]);
  });
  it("空库不匹配;cluster 包装 spkCluster", () => {
    expect(E.match(vec(0), {})).toBeNull();
    const lab = E.cluster([vec(0), vec(0, [[5, 0.1]]), vec(1)], 0.5);
    expect(lab[0]).toBe(lab[1]); expect(lab[0]).not.toBe(lab[2]);
  });
});
