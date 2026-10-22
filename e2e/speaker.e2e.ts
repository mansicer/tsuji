// 文件会话的说话人识别:flite 合成三人对话 → 文件处理(假识别按脚本给时间)→ 本机声纹分组 → 改名、存进模板声纹库
// → 同样三个声音的第二个文件:声纹库对照给出提示。GPT 判定走假接口(返回空判定),只检查它被调用、带上了声纹库提示
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, openApp } from "./fixtures";
import { ttsConversation } from "./tts";
import type { Turn, Spoken } from "./tts";

const CONV1: Turn[] = [
  { voice: "kal", text: "Good morning everyone and welcome to the weekly planning meeting." },
  { voice: "slt", text: "Thanks for having me today I brought the updated sales figures." },
  { voice: "awb", text: "Before we start I want to talk about the delayed shipment." },
  { voice: "kal", text: "Sure let us begin with the shipment and then look at sales." },
  { voice: "awb", text: "The trucks were stuck at the border for almost three days." },
  { voice: "slt", text: "That explains why the numbers dropped in the second week." },
  { voice: "kal", text: "Do we have a plan to avoid the same problem next month." },
  { voice: "awb", text: "We are going to book a second carrier as a backup option." },
  { voice: "slt", text: "Sales in the north region still grew by eight percent overall." },
  { voice: "kal", text: "That is good news and we should share it with the whole team." },
  { voice: "slt", text: "I will prepare a short summary and send it out this afternoon." },
  { voice: "awb", text: "Please include the shipping delay so nobody is surprised later." },
];
const CONV2: Turn[] = [
  { voice: "slt", text: "Hello again it is nice to see everyone back after the holiday." },
  { voice: "awb", text: "The new carrier delivered every order on time this week." },
  { voice: "kal", text: "Excellent that was exactly the result we were hoping for." },
  { voice: "slt", text: "Customers in the south also started ordering larger amounts." },
  { voice: "kal", text: "Should we hire another person for the support desk then." },
  { voice: "awb", text: "I think one more person would really help during busy hours." },
  { voice: "slt", text: "I can write the job description by the end of the week." },
  { voice: "kal", text: "Great then we will review the candidates next Tuesday." },
  { voice: "awb", text: "I will also check the budget for the extra salary costs." },
];
const NAMES: Record<string, string> = { kal: "Kal", awb: "Awb", slt: "Slt" };

/** GPT 判定接口:记下请求,返回空判定(组名、逐句都不给),结果只由声纹决定 */
async function fakeJudge(page: Page) {
  await page.evaluate(() => {
    const w = window as any, prev = window.fetch; w.__judge = [];
    window.fetch = async (url, opt) => {
      const b = opt && typeof opt.body === "string" ? JSON.parse(opt.body) : null;
      if (String(url).includes("/chat/completions") && b?.response_format?.json_schema?.name === "speakers") {
        w.__judge.push(b.messages[1].content);
        const content = JSON.stringify({ groups: [], lines: [] });
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      }
      return prev(url, opt);
    };
    w.__delay = 50;
  });
}

/** 选文件 → 打开说话人识别 → 处理,按脚本时间轴推识别结果 → 等处理完、声纹分析和 GPT 判定都跑完 */
async function processConversation(page: Page, turns: Turn[], name: string, k: number): Promise<Spoken[]> {
  const conv = ttsConversation(turns);
  await page.evaluate(() => window.__t.setPickFor({ tplId: "general" }));
  const prev = await page.evaluate(() => localStorage.getItem("jls.curSession"));
  await page.setInputFiles("#mediaFile", { name, mimeType: "audio/wav", buffer: readFileSync(conv.path) });
  await page.waitForFunction((p) => localStorage.getItem("jls.curSession") !== p, prev);
  await page.click("#spkOpen");
  // 开启(已同意过,不再弹确认);新会话会沿用上一个会话的设置,已开着就不用再点
  if (await page.evaluate(() => document.body.classList.contains("nospk"))) await page.click("#spkRun");
  await expect(page.locator("body")).not.toHaveClass(/nospk/);
  await page.click("#go");
  await page.waitForFunction((i) => window.__wss.length >= i && window.__wss[i - 1].sent.some((m: string) => m.includes("input_audio_buffer.append")), k, { timeout: 45_000 });
  await page.evaluate((tl) => {
    const ws = window.__ws;
    for (const s of tl) {
      const id = "it" + s.i;
      ws.emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: s.startMs });
      ws.emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: s.endMs });
      ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: s.text });
    }
  }, conv.timeline);
  await expect(page.locator("#go.redo")).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => window.__t.spk && window.__t.spk.llm, null, { timeout: 90_000 });
  return conv.timeline;
}

/** 每句的声纹标签 vs 脚本:每个声音取最常见的标签,统计标对的句子 */
async function score(page: Page, tl: Spoken[]) {
  const got: [string, string | null][] = await page.evaluate(() => window.__t.lines.map((l: any) => [l.raw, l.spk || null]));
  const who = new Map(tl.map((s) => [s.text, s.voice as string]));
  const byVoice: Record<string, Record<string, number>> = {};
  for (const [raw, spk] of got) if (spk) { const v = who.get(raw)!; (byVoice[v] ||= {})[spk] = (byVoice[v][spk] || 0) + 1; }
  const label: Record<string, string> = {};
  for (const [v, c] of Object.entries(byVoice)) label[v] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  const tagged = got.filter(([, s]) => s), ok = tagged.filter(([raw, s]) => label[who.get(raw)!] === s);
  return { n: got.length, tagged: tagged.length, ok: ok.length, label };
}

test("file session: voices are grouped, saved to the template and recognised in the next file", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openApp(page, () => localStorage.setItem("jls.spkConsent", "1"));
  await fakeJudge(page);

  // 第一个文件:三组,和脚本一致
  const tl1 = await processConversation(page, CONV1, "meeting1.wav", 1);
  expect(await page.evaluate(() => window.__t.spk.groups.length)).toBe(3);
  const s1 = await score(page, tl1);
  console.log("file 1:", JSON.stringify(s1));
  expect(s1.n).toBe(CONV1.length);
  expect(new Set(Object.values(s1.label)).size).toBe(3); // 三个声音各是一组
  expect(s1.tagged).toBeGreaterThanOrEqual(CONV1.length - 2);
  expect(s1.ok).toBeGreaterThanOrEqual(s1.tagged - 1);
  expect(await page.evaluate(() => (window as any).__judge.length)).toBe(1);
  expect(await page.evaluate(() => window.__t.spkEngine.engineKind())).toBe("worker"); // 声纹在 Worker 里算

  // 改名:组 k 的默认名是 l.spk 里的「Speaker k+1」/「说话人 k+1」,按脚本给真名
  const inputs = page.locator("#spkList .spkItem input");
  await expect(inputs).toHaveCount(3);
  for (const [v, lab] of Object.entries(s1.label)) {
    const k = Number(lab.replace(/\D/g, "")) - 1;
    await inputs.nth(k).fill(NAMES[v]); await inputs.nth(k).press("Enter");
  }
  await expect(page.locator("#spkSaveVoices")).toBeEnabled();
  await page.click("#spkSaveVoices");
  const voices = await page.evaluate(() => (JSON.parse(localStorage.getItem("jls.templates") || "[]").find((x: any) => x.id === "general") || {}).voices);
  expect(Object.keys(voices || {}).sort()).toEqual(["Awb", "Kal", "Slt"]);
  for (const x of Object.values(voices) as { v: string; d: number }[]) { expect(x.v).toHaveLength(1024); expect(x.d).toBeGreaterThan(5); }
  // 改过名后每句都带真名
  const named = await page.evaluate(() => window.__t.lines.filter((l: any) => ["Kal", "Awb", "Slt"].includes(l.spk)).length);
  expect(named).toBe(s1.tagged);

  // 第二个文件(同一模板、同样三个声音、不同的话):每组都对上声纹库,并作为提示交给 GPT
  const tl2 = await processConversation(page, CONV2, "meeting2.wav", 2);
  const s2 = await score(page, tl2);
  console.log("file 2:", JSON.stringify(s2));
  expect(new Set(Object.values(s2.label)).size).toBe(3);
  const metas = await page.locator("#spkList .spkItem .meta").allTextContents();
  expect(metas).toHaveLength(3);
  for (const nm of ["Kal", "Awb", "Slt"]) expect(metas.filter((m) => m.includes(nm))).toHaveLength(1);
  // 对上的名字和这一组实际的声音一致
  for (const [v, lab] of Object.entries(s2.label)) expect(metas[Number(lab.replace(/\D/g, "")) - 1]).toContain(NAMES[v]);
  const judge2 = await page.evaluate(() => (window as any).__judge[1] as string);
  const hits = judge2.match(/voice library match: (Kal|Awb|Slt) \(cosine [\d.]+\)/g);
  console.log("library:", hits);
  expect(hits).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("speaker engine falls back to the main thread when Workers fail", async ({ page }) => {
  await openApp(page, () => { (window as any).Worker = class { constructor() { throw new Error("no workers"); } }; });
  const r = await page.evaluate(async () => {
    const E = window.__t.spkEngine, x = Float32Array.from({ length: 32000 }, (_, i) => Math.sin(i / 7) * 0.3 + Math.sin(i / 3.1) * 0.2);
    await E.loadModel(); const v: Float32Array = await E.embed(x);
    return { kind: await E.engineKind(), n: v.length, norm: Math.hypot(...v) };
  });
  expect(r.kind).toBe("main"); expect(r.n).toBe(192); expect(r.norm).toBeCloseTo(1, 4);
});
