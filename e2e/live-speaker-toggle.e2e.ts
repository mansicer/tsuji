// 实时界面底部的「说话人」开关:和设置里的「识别说话人」是同一个(按会话存);第一次打开先在设置里确认
import { test, expect, openApp, openSession } from "./fixtures";

test("the footer speaker button turns speaker identification on and off", async ({ page }) => {
  const errors = await openApp(page);
  const btn = page.locator("#lspkBtn");
  await expect(btn).toBeVisible();
  await expect(btn).not.toHaveClass(/\bon\b/);
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  // 没确认过:打开设置里的确认框,还没开
  await btn.click();
  await expect(page.locator("#spkConfirm")).toBeVisible();
  await expect(btn).not.toHaveClass(/\bon\b/);
  await page.click("#spkConfirmOk");
  await expect(btn).toHaveClass(/\bon\b/);
  await expect(page.locator("#spkOn")).toBeChecked();
  await page.click("#closeSettings");
  // 确认过之后直接开关,设置里的勾跟着变
  await btn.click();
  await expect(btn).not.toHaveClass(/\bon\b/);
  await expect(page.locator("#spkOn")).not.toBeChecked();
  expect(await page.evaluate(() => window.__t.liveSpk())).toBeNull();
  await btn.click();
  await expect(btn).toHaveClass(/\bon\b/);
  await expect(page.locator("#settings")).toBeHidden();
  // 按会话存:B 默认关,回到 A 还是开着
  await openSession(page, "B");
  await expect(btn).not.toHaveClass(/\bon\b/);
  await openSession(page, "A");
  await expect(btn).toHaveClass(/\bon\b/);
  expect(errors).toEqual([]);
});
