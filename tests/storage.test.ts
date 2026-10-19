import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Storage = typeof import("../src/storage");

/** 节流状态在模块里,每个用例重新加载一份 */
async function fresh(): Promise<Storage> { vi.resetModules(); return import("../src/storage"); }

function memLS(fail: unknown = null) {
  const data = new Map<string, string>();
  const ls = {
    data,
    getItem(k: string) { if (fail) throw fail; return data.has(k) ? data.get(k)! : null; },
    setItem(k: string, v: string) { if (fail) throw fail; data.set(k, String(v)); },
    removeItem(k: string) { if (fail) throw fail; data.delete(k); },
  };
  // Object.keys(localStorage) 列出的是已存的键
  return new Proxy(ls, {
    ownKeys: () => [...data.keys()],
    getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && data.has(k) ? { value: data.get(k), enumerable: true, configurable: true } : undefined),
  });
}

const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("isQuotaError", () => {
  it("recognises every browser's quota error form", async () => {
    const { isQuotaError } = await fresh();
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ code: 1014 })).toBe(true);
    expect(isQuotaError(new DOMException("x", "QuotaExceededError"))).toBe(true);
  });
  it("rejects other errors and empty values", async () => {
    const { isQuotaError } = await fresh();
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError(new DOMException("x", "SecurityError"))).toBe(false);
    expect(isQuotaError({ code: 18 })).toBe(false);
  });
});

describe("storageFailed", () => {
  it("warns about a full store at most once a minute", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const { storageFailed, setStorageWarn } = await fresh();
    const warn = vi.fn(); setStorageWarn(warn);
    storageFailed(quota);
    expect(warn).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenLastCalledWith("full");
    vi.advanceTimersByTime(59_999); storageFailed(quota);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); storageFailed(quota);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it("warns about disabled storage only once", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const { storageFailed, setStorageWarn } = await fresh();
    const warn = vi.fn(); setStorageWarn(warn);
    const off = new DOMException("denied", "SecurityError");
    storageFailed(off); vi.advanceTimersByTime(3_600_000); storageFailed(off);
    expect(warn.mock.calls).toEqual([["off"]]);
    // 两种提示互不影响
    storageFailed(quota);
    expect(warn.mock.calls).toEqual([["off"], ["full"]]);
    expect(console.error).toHaveBeenCalledTimes(3);
  });
});

describe("store", () => {
  it("reads, writes and removes prefixed keys", async () => {
    const ls = memLS(); vi.stubGlobal("localStorage", ls);
    const { store } = await fresh();
    store.set("a", "1"); store.set("o", JSON.stringify({ x: 1 }));
    expect(ls.data.get("jls.a")).toBe("1");
    expect(store.get("a", "d")).toBe("1");
    expect(store.get("missing", "d")).toBe("d");
    expect(store.json("o", null)).toEqual({ x: 1 });
    expect(store.json("missing", [])).toEqual([]);
    store.set("a", null);
    expect(ls.data.has("jls.a")).toBe(false);
  });
  it("falls back to defaults and reports failed writes when localStorage throws", async () => {
    vi.stubGlobal("localStorage", memLS(quota));
    const { store, setStorageWarn } = await fresh();
    const warn = vi.fn(); setStorageWarn(warn);
    expect(store.get("a", "d")).toBe("d");
    expect(store.json("a", [1])).toEqual([1]);
    store.set("a", null);
    expect(warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    store.set("a", "1");
    expect(warn.mock.calls).toEqual([["full"]]);
  });
});

describe("lsKV", () => {
  it("lists, puts and deletes JSON entries under a prefix", async () => {
    const ls = memLS(); vi.stubGlobal("localStorage", ls);
    const { lsKV } = await fresh();
    await lsKV.put("lines:s1", [{ id: 1 }]);
    await lsKV.put("lines:s2", { a: 2 });
    await lsKV.put("other", 3);
    ls.data.set("jls.lines:bad", "{not json");
    expect(ls.data.get("jls.lines:s1")).toBe('[{"id":1}]');
    expect(await lsKV.entries("lines:")).toEqual([["lines:s1", [{ id: 1 }]], ["lines:s2", { a: 2 }]]);
    await lsKV.del("lines:s1");
    expect(ls.data.has("jls.lines:s1")).toBe(false);
    expect(await lsKV.entries("lines:")).toEqual([["lines:s2", { a: 2 }]]);
  });
});

describe("noKV", () => {
  it("holds nothing and rejects writes", async () => {
    const { noKV } = await fresh();
    expect(await noKV.entries("lines:")).toEqual([]);
    await expect(noKV.put("k", 1)).rejects.toMatchObject({ name: "SecurityError" });
    await expect(noKV.del("k")).resolves.toBeUndefined();
  });
});
