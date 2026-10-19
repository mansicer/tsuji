// 翻译请求还没回来时切换、清空、删除会话:结果只能落回原会话,已清空或已删除的数据不能被写回来
import { test, expect, openApp, reload, start, say, translated, requested, openSession, deleteSession, lines, idbKeys, lastRequest } from "./fixtures";

test("a late translation stays in its own session", async ({ page }) => {
  await openApp(page);
  await start(page); await say(page, "こんにちは");
  await requested(page, 1);
  await openSession(page, "B"); await start(page);
  await translated(page, 1); // A 的翻译在 B 里返回
  await say(page, "さようなら");
  await translated(page, 2);
  expect(await lines(page)).toEqual([["さようなら", "T:さようなら"]]);
  expect(await page.locator("#memoList li").allTextContents()).not.toContainEqual(expect.stringContaining("こんにちは"));
  expect(await lastRequest(page)).not.toContain("こんにちは");
  await page.click("#go"); // 停止

  await reload(page);
  await openSession(page, "A");
  expect(await lines(page)).toEqual([["旧", "旧译"], ["こんにちは", "T:こんにちは"]]);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("jls.smemo.sA") || "[]"))).toContain("note from こんにちは");
});

test("switching away and back keeps the late line in the next request's context", async ({ page }) => {
  await openApp(page);
  await start(page); await say(page, "最初の文");
  await requested(page, 1);
  await openSession(page, "B"); await openSession(page, "A");
  await translated(page, 1);
  expect(await lines(page)).toContainEqual(["最初の文", "T:最初の文"]);
  await start(page); await say(page, "次の文");
  await requested(page, 2);
  expect(await lastRequest(page)).toContain("最初の文 → T:最初の文");
});

test("deleting the current session right after a new line leaves nothing behind", async ({ page }) => {
  await openApp(page);
  await start(page); await say(page, "消える");
  await deleteSession(page, "A");
  await translated(page, 1);
  expect(await idbKeys(page)).not.toContain("lines:sA");
});

test("deleting a session while its translation is in flight doesn't rebuild it", async ({ page }) => {
  await openApp(page);
  await start(page); await say(page, "飛行中");
  await requested(page, 1);
  await openSession(page, "B"); await deleteSession(page, "A");
  await translated(page, 1);
  expect(await idbKeys(page)).not.toContain("lines:sA");
  expect(await page.evaluate(() => localStorage.getItem("jls.smemo.sA"))).toBeNull();
});

test("clear all while a translation is in flight stays cleared", async ({ page }) => {
  await openApp(page);
  await start(page); await say(page, "クリア前");
  await requested(page, 1);
  await page.evaluate(() => { const b = document.querySelector<HTMLElement>("#clearAll")!; b.click(); b.click(); });
  await translated(page, 1);
  expect(await lines(page)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("jls.smemo.sA"))).toBeNull();
  expect(await idbKeys(page)).not.toContain("lines:sA");
});
