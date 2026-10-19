// 字幕存储:从 localStorage 迁到 IndexedDB、和旧版数据合并、写满时提示、存储全被禁用时照常可用
import { test, expect, openApp, reload, start, say, translated, lines, idbKeys } from "./fixtures";

test("subtitles saved by the old version move to IndexedDB", async ({ page }) => {
  await openApp(page);
  expect(await lines(page)).toEqual([["旧", "旧译"]]);
  expect(await idbKeys(page)).toContain("lines:sA");
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("lines")))).toEqual([]);
});

test("lines the old version wrote after migration are appended", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem("jls.slines.sA", JSON.stringify([{ id: 1, raw: "旧版", src: "旧版", tgt: "旧版译", t: Date.now(), done: true }])));
  await reload(page);
  expect(await page.evaluate(() => window.__t.lines.map((l: any) => [l.id, l.raw]))).toEqual([[1, "旧"], [2, "旧版"]]);
  expect(await page.evaluate(() => localStorage.getItem("jls.slines.sA"))).toBeNull();
});

test("a full IndexedDB shows a warning and keeps the line on screen", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException("full", "QuotaExceededError"); }; });
  await start(page); await say(page, "テスト");
  await translated(page, 1);
  await expect(page.locator("#partial")).toContainText("storage is full");
  expect((await lines(page)).some(([raw]: string[]) => raw.includes("テスト"))).toBe(true);
});

test("the app still starts with localStorage and IndexedDB both disabled", async ({ page }) => {
  const errors = await openApp(page, () => {
    const deny = () => { throw new DOMException("denied", "SecurityError"); };
    Object.defineProperty(window, "localStorage", { get: deny, configurable: true });
    // 预置数据靠 sessionStorage 判断是否已写过;这里让它直接跳过
    Object.defineProperty(window, "sessionStorage", { value: { getItem: () => "1", setItem() {} }, configurable: true });
    Object.defineProperty(window, "indexedDB", { get: deny, configurable: true });
  });
  expect(errors).toEqual([]);
  await expect(page.locator("#sessList")).toBeAttached();
});
