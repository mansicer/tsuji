// 模板创建页:草稿编辑、和 GPT 对话(假的 Responses 流)、附件、刷新恢复、保存 / 保存并开始 / 从设置编辑 / 放弃
import { test, expect, openApp, reload } from "./fixtures";

function fakeResponses() {
  const real = window.fetch;
  (window as any).__resp = [];
  window.fetch = async (url: any, opt: any) => {
    if (!String(url).includes("/responses")) return real(url, opt);
    (window as any).__resp.push(JSON.parse(String(opt.body)));
    const out = { reply: "Found it https://example.com/x", template: { name: "GPT名", source: "ja", target: "zh-Hans", description: "D", style: "S", asrPrompt: "A", spkNotes: "N",
      speakers: [{ text: "山田", reading: "やまだ", translation: "山田", notes: "host" }], terms: [{ text: "語", reading: "ご", translation: "词", notes: "" }, { text: "語2", reading: "", translation: "词2", notes: "" }] } };
    const json = JSON.stringify(out);
    const evs = [
      { type: "response.output_item.added", item: { type: "web_search_call" } },
      { type: "response.output_item.done", item: { type: "web_search_call", action: { query: "q" } } },
      { type: "response.output_text.delta", delta: json },
      { type: "response.completed", response: { output: [{ type: "web_search_call" }, { type: "message", content: [{ text: json }] }], usage: { input_tokens: 10, output_tokens: 10 } } },
    ];
    const body = evs.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("");
    await new Promise((r) => setTimeout(r, 300));
    return new Response(body, { status: 200 });
  };
}

test.use({ viewport: { width: 390, height: 800 } });
test("building a template by chat, then saving, editing and discarding it", async ({ page }) => {
  await page.addInitScript(fakeResponses);
  const errors = await openApp(page);
  await page.click("#toTpl");
  await page.click("#newTpl");
  await expect(page.locator("#viewCreate")).toBeVisible();
  await expect(page.locator("#chatLog .msg.note")).toHaveCount(1);
  await page.click("#tabDraft");
  await expect(page.locator("#panes")).toHaveAttribute("data-tab", "draft");
  await page.click("#dSave"); // 没名字:不保存
  await expect(page.locator("#viewCreate")).toBeVisible();
  await page.fill("#dName", "手写");
  await page.click("#gToggle");
  await expect(page.locator("#dGlossText")).toBeVisible();
  await page.fill("#dGlossText", "佐藤 | さとう | 佐藤 | x\n");
  await page.click("#gToggle");
  await expect(page.locator("#gTableBox")).toBeVisible();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("jls.creator")))!).draft.name).toBe("手写");
  await page.click("#tabChat");
  await page.setInputFiles("#attachFile", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.locator("#attachList .fileChip")).toHaveCount(1);
  await page.fill("#chatInput", "做一个模板");
  await page.press("#chatInput", "Control+Enter");
  await expect(page.locator("#thinking")).toBeVisible();
  await expect(page.locator("#chatLog .msg.ai a")).toHaveAttribute("href", "https://example.com/x");
  await expect(page.locator("#chatSend")).toBeEnabled();
  await expect(page.locator("#attachList .fileChip")).toHaveCount(0);
  const req = await page.evaluate(() => (window as any).__resp[0]);
  expect(req.stream).toBe(true);
  expect(req.input.at(-1).content[1].text).toContain("hello");
  expect(req.input.at(-1).content[0].text).toContain("手写");
  await expect(page.locator("#dName")).toHaveValue("GPT名");
  await expect(page.locator("#tabDraft")).toContainText("3");
  await reload(page);
  await expect(page.locator("#viewCreate")).toBeVisible();
  await expect(page.locator("#chatLog .msg.ai")).toHaveCount(1);
  await page.click("#tabDraft");
  await page.click("#dSave");
  await expect(page.locator("#viewTpl")).toBeVisible();
  const card = page.locator(".card", { hasText: "GPT名" });
  await expect(card).toHaveCount(1);
  await card.locator("button.i-edit").click();
  await expect(page.locator("#title")).toHaveText("Edit template");
  await page.click("#tabDraft");
  await page.fill("#dDesc", "改过");
  await page.click("#dSaveStart");
  await expect(page.locator("#viewLive")).toBeVisible();
  const tpls = await page.evaluate(() => JSON.parse(localStorage.getItem("jls.templates")!));
  expect(tpls.filter((x: any) => x.name === "GPT名")).toHaveLength(1);
  expect(tpls.find((x: any) => x.name === "GPT名").description).toBe("改过");
  await page.click("#openSettings");
  await page.click("#editCurTpl");
  await expect(page.locator("#viewCreate")).toBeVisible();
  await page.click("#tabDraft");
  await expect(page.locator("#dName")).toHaveValue("GPT名");
  await page.click("#dDiscard"); await page.click("#dDiscard");
  await expect(page.locator("#viewTpl")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("jls.creator"))).toBeNull();
  expect(errors).toEqual([]);
});
