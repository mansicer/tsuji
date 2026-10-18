import { describe, expect, it } from "vitest";
import { LineStore, patchTranslations, mergeLegacy, type KV } from "../src/linestore";

function memKV(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init));
  const kv: KV & { data: Map<string, unknown>; fail: boolean } = {
    data, fail: false,
    async entries(prefix) { return [...data].filter(([k]) => k.startsWith(prefix)); },
    async put(k, v) { if (kv.fail) throw new Error("QuotaExceededError"); data.set(k, v); },
    async del(k) { data.delete(k); },
  };
  return kv;
}

describe("LineStore", () => {
  it("loads only line entries and serves them synchronously", async () => {
    const kv = memKV({ "lines:s1": [{ id: 1, src: "a" }], "s1": "media blob", "spk:s1": {} });
    const st = new LineStore(kv, () => {});
    await st.load();
    expect(st.get("s1")).toEqual([{ id: 1, src: "a" }]);
    expect(st.get("s2")).toEqual([]);
    expect(st.has("s1")).toBe(true);
  });

  it("writes through to the backend and deletes on empty", async () => {
    const kv = memKV();
    const st = new LineStore(kv, () => {});
    expect(await st.set("s1", [{ id: 1 }])).toBe(true);
    expect(kv.data.get("lines:s1")).toEqual([{ id: 1 }]);
    await st.set("s1", []);
    expect(kv.data.has("lines:s1")).toBe(false);
    expect(st.has("s1")).toBe(false);
  });

  it("hands out copies, so callers can't mutate the cache", async () => {
    const st = new LineStore(memKV(), () => {});
    const arr = [{ id: 1 }];
    await st.set("s1", arr);
    arr.push({ id: 2 });
    st.get("s1").push({ id: 3 });
    expect(st.get("s1")).toEqual([{ id: 1 }]);
  });

  it("reports write failures but keeps the cache", async () => {
    const kv = memKV(); kv.fail = true;
    const errors: unknown[] = [];
    const st = new LineStore(kv, (e) => errors.push(e));
    expect(await st.set("s1", [{ id: 1 }])).toBe(false);
    expect(errors).toHaveLength(1);
    expect(st.get("s1")).toEqual([{ id: 1 }]);
  });
});

describe("patchTranslations", () => {
  it("fills in returned lines by id and leaves the rest untouched", () => {
    const saved = [{ id: 1, raw: "x", done: false }, { id: 2, raw: "y", done: false }, { id: 3, src: "z", tgt: "Z", done: true }];
    const out = patchTranslations(saved, [{ id: 2, src: " y ", tgt: " Y " }]);
    expect(out).toEqual([{ id: 1, raw: "x", done: false }, { id: 2, raw: "y", src: "y", tgt: "Y", done: true }, saved[2]]);
    expect(saved[1].done).toBe(false);
  });
});

describe("mergeLegacy", () => {
  const cur = [{ id: 1, t: 100, raw: "a" }, { id: 2, t: 200, raw: "b" }];

  it("takes legacy lines as-is when there is nothing yet", () => {
    expect(mergeLegacy([], [{ id: 1, t: 1, raw: "x" }])).toEqual([{ id: 1, t: 1, raw: "x" }]);
  });

  it("appends lines written by the old version with ids continuing after the current ones", () => {
    const legacy = [{ id: 1, t: 300, raw: "c" }, { id: 2, t: 400, raw: "d" }];
    expect(mergeLegacy(cur, legacy)).toEqual([...cur, { id: 3, t: 300, raw: "c" }, { id: 4, t: 400, raw: "d" }]);
  });

  it("skips lines that are already there", () => {
    expect(mergeLegacy(cur, [{ id: 1, t: 100, raw: "a" }])).toBe(cur);
    expect(mergeLegacy(cur, [{ id: 1, t: 100, raw: "a" }, { id: 5, t: 500, raw: "e" }]).map((l) => l.id)).toEqual([1, 2, 3]);
  });
});
