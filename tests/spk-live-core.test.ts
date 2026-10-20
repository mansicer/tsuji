import { describe, expect, it } from "vitest";
import { LIVE_SPK, LiveCore, letterOf, libMatch, liveLibEntries, f32b64 } from "../src/spk/live-core";
import type { LiveLibEntry } from "../src/spk/live-core";
import { spkNorm, spkDot, SPK_DIM } from "../src/spk/core";

// 合成声纹:每个说话人一个随机方向,每段加噪声(noise 0.5 时同一人两段余弦约 0.8,不同人约 0)
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const R = rng(42);
const gauss = () => { const u = Math.max(R(), 1e-12), v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const randVec = () => spkNorm(Float32Array.from({ length: SPK_DIM }, gauss));
function seg(base: Float32Array, noise = 0.5): Float32Array {
  const n = randVec(); return spkNorm(Float32Array.from(base, (x, i) => x + noise * n[i]));
}
/** a、b 之间按 w 混合(用来做「两个很像的声音」) */
const mix = (a: Float32Array, b: Float32Array, w: number) => spkNorm(Float32Array.from(a, (x, i) => (1 - w) * x + w * b[i]));
const labels = (c: LiveCore, ids: number[]) => ids.map((i) => c.label(i)?.g ?? null);

describe("letterOf", () => {
  it("A–Z, then AA", () => {
    expect([0, 1, 25, 26, 27].map(letterOf)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });
});

describe("online assignment", () => {
  it("three voices become three visible groups, lettered in order of appearance", () => {
    const sp = [randVec(), randVec(), randVec()], c = new LiveCore();
    const order = [0, 1, 2, 0, 1, 2, 0, 2, 1, 0];
    order.forEach((k, i) => c.add(i, 3.5, seg(sp[k]), 1000 + i));
    expect(c.visible().map((g) => g.id)).toEqual([0, 1, 2]);
    expect(labels(c, order.map((_, i) => i))).toEqual(order);
    expect(c.events.filter((e) => e.kind === "new-group").map((e) => e.id)).toEqual([0, 1, 2]);
    for (const g of c.visible()) expect(spkDot(g.cent, sp[g.id])).toBeGreaterThan(0.9);
  });

  it("delays a group until it has 3 s of speech or 2 segments, then labels its earlier lines", () => {
    const a = randVec(), c = new LiveCore();
    c.add(1, 1.5, seg(a), 0);
    expect(c.label(1)).toEqual({ g: null, conf: expect.any(Number) });
    expect(c.visible()).toHaveLength(0);
    c.add(2, 1.2, seg(a), 1);
    expect(labels(c, [1, 2])).toEqual([0, 0]);
    expect(c.events).toEqual([{ kind: "new-group", at: 1, id: 0 }]);
    // 一段就够 3 秒:立即显示
    const b = randVec(); c.add(3, 3.2, seg(b), 2);
    expect(c.label(3)!.g).toBe(1);
  });

  it("short segments are not clustered: nearest visible group if similar enough, else no label", () => {
    const a = randVec(), b = randVec(), c = new LiveCore();
    c.add(1, 4, seg(a, 0.3), 0);
    c.add(2, 0.6, seg(a, 0.3), 1); // 像 A
    c.add(3, 0.6, seg(b, 0.3), 2); // 谁都不像
    expect(labels(c, [1, 2, 3])).toEqual([0, 0, null]);
    expect(c.visible()[0].n).toBe(1); // 短片段不算成员
    expect(c.gs.size).toBe(1); // 也没有为它开新组
  });

  it("a line added again (merged and extended) replaces its segment", () => {
    const a = randVec(), b = randVec(), c = new LiveCore();
    c.add(1, 4, seg(a), 0); c.add(2, 4, seg(b), 1);
    c.add(2, 5, seg(a), 2);
    expect(c.label(2)!.g).toBe(0);
    expect(c.visible().find((g) => g.id === 0)!.n).toBe(2);
    expect(c.segs).toHaveLength(2);
    c.drop(2);
    expect(c.segs).toHaveLength(1); expect(c.label(2)).toBeNull();
  });
});

describe("recluster", () => {
  it("keeps ids, letters and names when nothing changed", () => {
    const sp = [randVec(), randVec(), randVec()], c = new LiveCore();
    for (let i = 0; i < 15; i++) c.add(i, 3, seg(sp[i % 3]), i);
    c.rename(1, "Bob");
    const before = labels(c, [...Array(15).keys()]);
    c.recluster(100);
    expect(labels(c, [...Array(15).keys()])).toEqual(before);
    expect(c.visible().map((g) => [g.id, g.name])).toEqual([[0, null], [1, "Bob"], [2, null]]);
    expect(c.events.filter((e) => e.kind !== "new-group")).toEqual([]);
    expect(c.fresh).toBe(0);
  });

  it("merges a voice that online assignment split in two, keeping the bigger group's id and the higher-ranked name", () => {
    const a = randVec(), cfg = { ...LIVE_SPK }, c = new LiveCore(cfg);
    // 在线分组阈值很严:同一个人被分成两组
    cfg.dist = 0.05;
    for (let i = 0; i < 6; i++) c.add(i, 3, seg(a, 0.45), i);
    expect(c.visible().length).toBeGreaterThan(1);
    const big = c.visible().reduce((m, g) => (g.n > m.n ? g : m));
    const small = c.visible().find((g) => g !== big)!;
    c.rename(small.id, "Alice"); // 名字在小的那组上
    cfg.dist = 0.38;
    c.recluster(50);
    expect(c.visible().map((g) => g.id)).toEqual([big.id]);
    expect(c.visible()[0].name).toBe("Alice");
    expect(c.visible()[0].src).toBe("manual");
    expect(labels(c, [0, 1, 2, 3, 4, 5]).every((g) => g === big.id)).toBe(true);
    expect(c.events.filter((e) => e.kind === "merge").map((e) => e.id)).toContain(big.id);
  });

  it("splits a group that holds two voices; the bigger part keeps the id", () => {
    const a = randVec(), b = randVec(), cfg = { ...LIVE_SPK }, c = new LiveCore(cfg);
    cfg.dist = 1.2; // 在线分组什么都并
    const who = [0, 0, 1, 0, 1, 0, 0, 1];
    who.forEach((k, i) => c.add(i, 3, seg(k ? b : a, 0.3), i));
    expect(c.visible()).toHaveLength(1);
    c.rename(0, "Ann");
    cfg.dist = 0.38;
    c.recluster(99);
    const g = labels(c, who.map((_, i) => i));
    expect(g.filter((x, i) => who[i] === 0).every((x) => x === 0)).toBe(true);
    expect(g.filter((x, i) => who[i] === 1).every((x) => x === 1)).toBe(true);
    expect(c.group(0)!.name).toBe("Ann"); expect(c.group(1)!.name).toBeNull();
    expect(c.events.find((e) => e.kind === "split")).toEqual({ kind: "split", at: 99, id: 1, other: 0 });
  });

  it("due(): every reclusterN new segments or reclusterMs", () => {
    const c = new LiveCore(), a = randVec();
    expect(c.due(0, 0)).toBe(false);
    for (let i = 0; i < 9; i++) c.add(i, 2, seg(a), i);
    expect(c.due(1000, 0)).toBe(false);
    expect(c.due(LIVE_SPK.reclusterMs, 0)).toBe(true);
    c.add(9, 2, seg(a), 9);
    expect(c.due(1000, 0)).toBe(true);
  });
});

describe("persistence", () => {
  it("saved groups come back with ids, names and centroids; new speech joins them and a recluster keeps them", () => {
    const sp = [randVec(), randVec()], c = new LiveCore();
    for (let i = 0; i < 6; i++) c.add(i, 3, seg(sp[i % 2]), i);
    c.rename(1, "Bo");
    const saved = JSON.parse(JSON.stringify(c.save()));
    expect(saved.groups[0].cent).toHaveLength(1024);
    const d = new LiveCore(); d.load(saved);
    expect(d.visible().map((g) => [g.id, g.name, g.n])).toEqual([[0, null, 3], [1, "Bo", 3]]);
    for (let i = 10; i < 16; i++) d.add(i, 3, seg(sp[i % 2]), i);
    expect(labels(d, [10, 11])).toEqual([0, 1]);
    d.recluster(100);
    expect(labels(d, [10, 11, 12, 13])).toEqual([0, 1, 0, 1]);
    // 新来的第三个人:id 接着往下排
    d.add(20, 4, seg(randVec()), 200);
    expect(d.label(20)!.g).toBe(2);
  });
});

describe("library", () => {
  const ent = (name: string, vecs: [Float32Array, "file" | "live"][]): LiveLibEntry => ({ name, vecs: vecs.map(([v, src]) => ({ v, src })) });
  const near = (v: Float32Array, cos: number) => { const n = randVec(), o = spkNorm(Float32Array.from(n, (x, i) => x - spkDot(n, v) * v[i])); return Float32Array.from(v, (x, i) => cos * x + Math.sqrt(1 - cos * cos) * o[i]); };

  it("per-source thresholds: live ≥ 0.80, file ≥ 0.70", () => {
    const p = randVec(), q = randVec(), g = [{ id: 0, cent: p, dur: 10 }];
    expect(libMatch(g, [ent("P", [[near(p, 0.78), "live"]]), ent("Q", [[q, "live"]])])).toEqual([]);
    expect(libMatch(g, [ent("P", [[near(p, 0.83), "live"]]), ent("Q", [[q, "live"]])]).map((m) => m.name)).toEqual(["P"]);
    expect(libMatch(g, [ent("P", [[near(p, 0.72), "file"]]), ent("Q", [[q, "file"]])]).map((m) => m.name)).toEqual(["P"]);
    expect(libMatch(g, [ent("P", [[near(p, 0.66), "file"]]), ent("Q", [[q, "file"]])])).toEqual([]);
  });
  it("needs a margin over the second person, mutual best and enough speech", () => {
    const p = randVec(), g = { id: 0, cent: p, dur: 10 };
    const twin = mix(p, randVec(), 0.25);
    expect(libMatch([g], [ent("P", [[near(p, 0.9), "file"]]), ent("T", [[near(p, 0.86), "file"]])])).toEqual([]); // margin 0.04
    expect(libMatch([g, { id: 1, cent: twin, dur: 10 }], [ent("P", [[twin, "file"]])]).map((m) => m.id)).toEqual([1]); // 组 1 更像 P
    expect(libMatch([{ ...g, dur: 3 }], [ent("P", [[p, "file"]])])).toEqual([]); // 不够 4 秒
  });
  it("names groups through the precedence rules; a manual name is never replaced", () => {
    const sp = [randVec(), randVec()], c = new LiveCore();
    for (let i = 0; i < 6; i++) c.add(i, 3, seg(sp[i % 2], 0.3), i);
    c.rename(1, "Me");
    const lib = [ent("Kal", [[sp[0], "live"]]), ent("Slt", [[sp[1], "live"]])];
    expect(c.nameFromLibrary(lib).map((x) => [x.id, x.to])).toEqual([[0, { name: "Kal", src: "library" }]]);
    expect(c.group(1)!.name).toBe("Me");
    expect(c.propose([{ id: 0, name: "Other", src: "gpt-evidence" }])).toEqual([]); // GPT 改不了 library
    expect(c.propose([{ id: 0, name: "Kal2", src: "library" }])).toHaveLength(1);
  });
  it("with a library, new-group waits until the library had a chance (libDur), and is skipped if it named the group", () => {
    const sp = [randVec(), randVec()], c = new LiveCore(), lib = [ent("Kal", [[sp[0], "live"]])];
    c.deferNew = true;
    c.add(0, 2, seg(sp[0], 0.3), 0); c.add(1, 2, seg(sp[1], 0.3), 1); c.add(2, 1.5, seg(sp[0], 0.3), 2); c.add(3, 1.5, seg(sp[1], 0.3), 3);
    expect(c.visible()).toHaveLength(2); // 都显示了(各 2 段),但还不到 4 秒:没报 new-group
    c.nameFromLibrary(lib, 10);
    expect(c.events.filter((e) => e.kind === "new-group")).toEqual([]);
    c.add(4, 1, seg(sp[0], 0.3), 4); c.add(5, 1, seg(sp[1], 0.3), 5); // 都够 4.5 秒
    c.nameFromLibrary(lib, 20);
    // 组 0 被声纹库认成 Kal,不报;组 1 认不出来,现在才报
    expect(c.group(0)!.name).toBe("Kal");
    expect(c.events.filter((e) => e.kind === "new-group")).toEqual([{ kind: "new-group", at: 20, id: 1 }]);
    c.nameFromLibrary(lib, 30);
    expect(c.events.filter((e) => e.kind === "new-group")).toHaveLength(1); // 只报一次
  });
  it("with an empty library, deferred groups are announced right away", () => {
    const c = new LiveCore(); c.deferNew = true;
    const a = randVec(); c.add(0, 3.5, seg(a), 0);
    c.nameFromLibrary([], 5);
    expect(c.events).toEqual([{ kind: "new-group", at: 5, id: 0 }]);
  });
  it("liveLibEntries: a d = 0 v is only a placeholder for live-only people", () => {
    const v = randVec(), e = liveLibEntries({ A: { v: f32b64(v), d: 0, alts: [{ v: f32b64(v), d: 5, src: "live" }] }, B: { v: f32b64(v), d: 9 } });
    expect(e.map((x) => x.vecs.map((y) => y.src))).toEqual([["live"], ["file"]]);
  });
});
