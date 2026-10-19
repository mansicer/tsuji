// 存储底层:localStorage(键加 "jls." 前缀)、IndexedDB,以及写入失败时的提示节流。
// 提示文案在 main.ts(界面层),这里只通过 setStorageWarn 注入的回调告诉它是哪种失败
import type { KV } from "./linestore";

/** full:存储写满;off:存储被浏览器禁用 */
export type StorageWarnKind = "full" | "off";
let warn: (kind: StorageWarnKind) => void = () => {};
export function setStorageWarn(fn: (kind: StorageWarnKind) => void): void { warn = fn; }

export const store = {
  get<T>(k: string, d: T): string | T { try { const v = localStorage.getItem("jls." + k); return v === null ? d : v; } catch { return d; } },
  set(k: string, v: string | null): void { try { v === null ? localStorage.removeItem("jls." + k) : localStorage.setItem("jls." + k, v); } catch (e) { if (v !== null) storageFailed(e); } },
  json(k: string, d: any): any { try { return JSON.parse(this.get(k, "null")) ?? d; } catch { return d; } },
};
// 存储写满时提示(一分钟最多一次;字幕还在页面上,删掉旧会话腾出空间后会继续保存);
// 存储被浏览器禁用时只提示一次,删会话也没用
let storageWarnAt = 0, storageOffWarned = false;
export function isQuotaError(e: unknown): boolean {
  const x = e as { name?: string; code?: number } | null | undefined;
  return !!x && (x.name === "QuotaExceededError" || x.name === "NS_ERROR_DOM_QUOTA_REACHED" || x.code === 22 || x.code === 1014);
}
export function storageFailed(e: unknown): void {
  console.error(e);
  if (!isQuotaError(e)) { if (!storageOffWarned) { storageOffWarned = true; warn("off"); } return; }
  if (Date.now() - storageWarnAt < 60000) return;
  storageWarnAt = Date.now(); warn("full");
}

// 原文件存在浏览器 IndexedDB,刷新后还能播放、续处理
export const idb = {
  db: null as Promise<IDBDatabase> | null,
  open(): Promise<IDBDatabase> { return (this.db ||= new Promise((ok, bad) => { const r = indexedDB.open("jls", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); })); },
  async run<T>(mode: IDBTransactionMode, fn: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> { const db = await this.open(); return new Promise((ok, bad) => { const tx = db.transaction("files", mode); const rq = fn(tx.objectStore("files")); tx.oncomplete = () => ok(rq.result); tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error); }); },
  put(k: string, v: unknown) { return this.run("readwrite", (st) => st.put(v, k)); },
  get(k: string): Promise<any> { return this.run("readonly", (st) => st.get(k)); },
  del(k: string) { return this.run("readwrite", (st) => st.delete(k)); },
  async entries(prefix: string): Promise<[string, unknown][]> {
    const db = await this.open();
    return new Promise((ok, bad) => {
      const tx = db.transaction("files", "readonly"), st = tx.objectStore("files"), range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      const ks = st.getAllKeys(range), vs = st.getAll(range);
      tx.oncomplete = () => ok(ks.result.map((k, i) => [k as string, vs.result[i]])); tx.onerror = () => bad(tx.error);
    });
  },
};
// 编译期检查 idb 满足 KV(不产生运行时代码)
type AssertKV<T extends KV> = T;
export type IdbKV = AssertKV<typeof idb>;
// IndexedDB 不可用(个别隐私模式)时退回 localStorage,和以前一样
export const lsKV: KV = {
  async entries(prefix) {
    const out: [string, unknown][] = [];
    for (const k of Object.keys(localStorage)) if (k.startsWith("jls." + prefix)) { try { out.push([k.slice(4), JSON.parse(localStorage.getItem(k) as string)]); } catch {} }
    return out;
  },
  async put(k, v) { localStorage.setItem("jls." + k, JSON.stringify(v)); },
  async del(k) { localStorage.removeItem("jls." + k); },
};
// 两种存储都被禁用(例如 Safari「阻止所有 Cookie」):不持久化,页面照常能用
export const noKV: KV = {
  async entries() { return []; },
  async put() { throw new DOMException("storage unavailable", "SecurityError"); },
  async del() {},
};
