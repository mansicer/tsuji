// 实时会话录音(live-record.ts):假麦克风(flite 合成的 WAV)→ MediaRecorder 分块存 IndexedDB → 转成文件会话 → ffmpeg.wasm 提取 PCM;删实时会话连录音一起删
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, start, translated, idbKeys, deleteSession, openSession } from "./fixtures";
import { ttsConversation } from "./tts";

// 这里只要有人声,不看时间轴;按 pid 取名,各 worker 的假麦克风文件互不干扰
const WAV = ttsConversation([
  { voice: "awb", text: "Good evening everyone, and welcome to the show." },
  { voice: "slt", text: "Thank you. It is great to be here tonight." },
  { voice: "kal", text: "Let us start with the first question." },
], { gapMs: 400, out: join(tmpdir(), `tsuji-record-e2e-${process.pid}.wav`) }).path;
// 只有这个文件用假麦克风文件,不影响其他测试
test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + WAV] } });

const sess = (page: Page, id: string) => page.evaluate((i) => JSON.parse(localStorage.getItem("jls.sessions")!).find((s: any) => s.id === i), id);
/** IndexedDB 里某前缀的键和每个值的字节数 */
const idbSizes = (page: Page, prefix: string) =>
  page.evaluate((p) => new Promise<[string, number][]>((r) => {
    const q = indexedDB.open("jls", 1);
    q.onsuccess = () => {
      const st = q.result.transaction("files").objectStore("files"), range = IDBKeyRange.bound(p, p + "￿");
      const ks = st.getAllKeys(range), vs = st.getAll(range);
      vs.onsuccess = () => r((ks.result as string[]).map((k, i) => { const v = vs.result[i]; return [k, v instanceof Blob ? v.size : v && v.buf ? v.buf.byteLength : 0]; }));
    };
  }), prefix);

test("record a live session, convert it to a file session and analyse it", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openApp(page);
  await expect(page.locator("#recBtn")).toBeVisible();
  await expect(page.locator("#recBtn")).not.toHaveClass(/\bon\b/); // 默认关

  // 开启要确认;取消就不开
  await page.click("#recBtn");
  await expect(page.locator("#recConfirm")).toBeVisible();
  await page.click("#recNo");
  await expect(page.locator("#recConfirm")).toBeHidden();
  expect((await sess(page, "sA")).rec).toBeUndefined();
  await page.click("#recBtn"); await page.click("#recOk");
  await expect(page.locator("#recBtn")).toHaveClass(/\bon\b/);
  expect((await sess(page, "sA")).rec.on).toBe(true);
  expect((await sess(page, "sB")).rec).toBeUndefined(); // 只对本会话

  // 第一段:收音中约 10 秒存一块(标签页被杀也只丢几秒)
  await start(page);
  await expect(page.locator("#recBtn.live")).toBeVisible();
  const t0 = Date.now();
  await expect.poll(async () => (await idbSizes(page, "rec:sA:")).length, { timeout: 20_000, intervals: [500] }).toBeGreaterThan(0);
  console.log(`first chunk stored ${((Date.now() - t0) / 1000).toFixed(1)} s after start, while still recording`);
  await expect(page.locator("#recBtn.live")).toBeVisible();
  await page.click("#go");
  await expect(page.locator("#recBar")).toBeVisible();
  await expect(page.locator("#recBtn.live")).toHaveCount(0);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts[0].bytes > 0);
  const first = await idbSizes(page, "rec:sA:");
  expect(first.length).toBeGreaterThanOrEqual(2); // 10 秒一块 + 停止时的最后一块
  expect(first.every(([k, n]) => k.startsWith("rec:sA:000:") && n > 0)).toBe(true);

  // 第二段:再收 3 秒
  await start(page);
  await expect(page.locator("#recBtn.live")).toBeVisible();
  await expect(page.locator("#recBar")).toBeHidden();
  await page.waitForTimeout(3000);
  await page.click("#go");
  await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem("jls.sessions")!)[0]; return s.rec.parts.length === 2 && s.rec.parts[1].bytes > 0; });
  const all = await idbSizes(page, "rec:sA:");
  expect(all.some(([k]) => k.startsWith("rec:sA:001:"))).toBe(true);
  const live = await sess(page, "sA"), total = all.reduce((a, [, n]) => a + n, 0);
  expect(live.rec.bytes).toBe(total);
  const recMs = live.rec.parts.reduce((a: number, p: any) => a + p.t1 - p.t0, 0);
  console.log(`recorded ${live.rec.parts.length} parts, ${all.length} chunks, ${total} bytes, ${(recMs / 1000).toFixed(1)} s, ${live.rec.parts[0].mime}, ${Math.round(total * 8 / recMs)} kbps`);
  await expect(page.locator("#recInfo")).toContainText("2");
  await page.click("#toHome");
  await expect(page.locator("#sessList .card:has(h3:text-is('A')) .when")).toContainText("KB");
  await page.click("#sessList .card:has(h3:text-is('A')) .btn.primary");

  // 转成文件会话:两段用 ffmpeg.wasm 接成一个 webm
  await page.click("#recConvert");
  await page.waitForFunction(() => localStorage.getItem("jls.curSession") !== "sA", null, { timeout: 60_000 });
  const fid = await page.evaluate(() => localStorage.getItem("jls.curSession")!);
  const fs = await sess(page, fid);
  expect(fs).toMatchObject({ kind: "file", fromLive: "sA", tplId: "general", source: "ja", target: "zh-Hans", file: { stored: true, type: "audio/webm" } });
  expect((await sess(page, "sA")).recSession).toBe(fid);
  expect(await idbKeys(page)).toContain(fid);
  // 录到的是假麦克风里的语音,不是静音
  const rms = await page.evaluate(async (k) => {
    const f = await new Promise<Blob>((r) => { const q = indexedDB.open("jls", 1); q.onsuccess = () => { const g = q.result.transaction("files").objectStore("files").get(k); g.onsuccess = () => r(g.result); }; });
    const x = (await new OfflineAudioContext(1, 1, 24000).decodeAudioData(await f.arrayBuffer())).getChannelData(0);
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / x.length);
  }, fid);
  console.log(`converted audio RMS ${rms.toFixed(4)}`);
  expect(rms).toBeGreaterThan(0.01);
  await expect(page.locator("body.filemode")).toHaveCount(1);
  await expect(page.locator("#recBtn")).toBeHidden();

  // 开始处理:ffmpeg.wasm 提取的 PCM 时长和录音时长相近
  const nws = await page.evaluate(() => window.__wss.length);
  await page.click("#go");
  await page.waitForFunction((k) => window.__wss.length > k && window.__ws.sent.some((m: string) => m.includes("input_audio_buffer.append")), nws, { timeout: 45_000 });
  const dur = (await sess(page, fid)).file.duration;
  console.log(`extracted ${(dur / 1000).toFixed(2)} s of PCM from ${(recMs / 1000).toFixed(2)} s recorded`);
  expect(Math.abs(dur - recMs)).toBeLessThan(1500);
  await page.evaluate(() => {
    const ws = window.__ws;
    ws.emit({ type: "input_audio_buffer.speech_started", item_id: "x", audio_start_ms: 100 });
    ws.emit({ type: "input_audio_buffer.speech_stopped", item_id: "x", audio_end_ms: 1500 });
    ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "x", transcript: "こんばんは" });
  });
  await translated(page, 1);
  expect(await page.evaluate(() => window.__t.lines.map((l: any) => [l.raw, l.tgt, l.ms]))).toEqual([["こんばんは", "T:こんばんは", 100]]);

  // 删实时会话:录音块一起删掉,转出来的文件会话不受影响
  await deleteSession(page, "A");
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem("jls.sessions")!).some((s: any) => s.id === "sA"));
  await expect.poll(() => idbSizes(page, "rec:sA:")).toEqual([]);
  expect(await idbKeys(page)).toContain(fid);
  expect(errors).toEqual([]);
});

test("a single recorded part is used as is", async ({ page }) => {
  await openApp(page);
  await page.click("#recBtn"); await page.click("#recOk");
  await start(page);
  await page.waitForTimeout(2500);
  await page.click("#go");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts[0].bytes > 0);
  const n = (await sess(page, "sA")).rec.bytes;
  await page.click("#recConvert");
  await page.waitForFunction(() => localStorage.getItem("jls.curSession") !== "sA");
  const fs = await sess(page, await page.evaluate(() => localStorage.getItem("jls.curSession")!));
  expect(fs.file).toMatchObject({ type: "audio/webm", size: n, stored: true });
  expect(fs.name).toMatch(/^A · (录音|recording)$/);
});

test("converting again opens the existing file session; after it is deleted it converts anew", async ({ page }) => {
  const errors = await openApp(page);
  await page.click("#recBtn"); await page.click("#recOk");
  await start(page);
  await page.waitForTimeout(2500);
  await page.click("#go");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts[0].bytes > 0);
  await expect(page.locator("#recConvert")).toHaveText(/转成文件会话|Convert/);
  await page.click("#recConvert");
  await page.waitForFunction(() => localStorage.getItem("jls.curSession") !== "sA");
  const fid = await page.evaluate(() => localStorage.getItem("jls.curSession")!);
  const count = () => page.evaluate(() => JSON.parse(localStorage.getItem("jls.sessions")!).length);
  const n = await count();

  // 回到实时会话再点:直接切到已有的文件会话,不建新的,recSession 不变
  await openSession(page, "A");
  await expect(page.locator("#recBar")).toBeVisible();
  await expect(page.locator("#recConvert")).toHaveText(/打开转好的文件会话|Open the converted file session/);
  await page.click("#recConvert");
  await page.waitForFunction((f) => localStorage.getItem("jls.curSession") === f, fid);
  await expect(page.locator("body.filemode")).toHaveCount(1);
  expect(await count()).toBe(n);
  expect((await sess(page, "sA")).recSession).toBe(fid);

  // 删掉文件会话:实时会话的 recSession 跟着清掉,按钮回到「转换」,再点建一个新的
  await page.click("#toHome");
  const trash = page.locator("#sessList .card").filter({ has: page.locator("h3", { hasText: /^A · (录音|recording)/ }) }).locator(".i-trash");
  await trash.click(); await trash.click(); // 点两次确认
  await page.waitForFunction((f) => !JSON.parse(localStorage.getItem("jls.sessions")!).some((s: any) => s.id === f), fid);
  expect((await sess(page, "sA")).recSession).toBeUndefined();
  await page.click(`#sessList .card:has(h3:text-is('A')) .btn.primary`);
  await expect(page.locator("#recConvert")).toHaveText(/转成文件会话|Convert/);
  await page.click("#recConvert");
  await page.waitForFunction((f) => { const c = localStorage.getItem("jls.curSession"); return c !== "sA" && c !== f; }, fid);
  const fid2 = await page.evaluate(() => localStorage.getItem("jls.curSession")!);
  expect((await sess(page, "sA")).recSession).toBe(fid2);
  expect(await sess(page, fid2)).toMatchObject({ kind: "file", fromLive: "sA" });
  expect(await count()).toBe(n);
  expect(errors).toEqual([]);
});

test("turning recording off mid-session ends the part; another session is not recorded", async ({ page }) => {
  await openApp(page);
  await page.click("#recBtn"); await page.click("#recOk");
  await start(page);
  await page.waitForTimeout(1500);
  await page.click("#recBtn"); // 收音中关掉
  await expect(page.locator("#recBtn")).not.toHaveClass(/\bon\b/);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts[0].bytes > 0);
  await page.waitForTimeout(1500);
  const a = await idbSizes(page, "rec:sA:");
  expect(a.length).toBe(1);
  await page.click("#go");
  await page.click("#toHome");
  await page.click(`#sessList .card:has(h3:text-is('B')) .btn.primary`);
  await expect(page.locator("#recBtn")).not.toHaveClass(/\bon\b/);
  await start(page);
  await page.waitForTimeout(1500);
  await page.click("#go");
  expect(await idbSizes(page, "rec:sB:")).toEqual([]);
  expect(await idbSizes(page, "rec:sA:")).toEqual(a);
});

test("restarting the mic starts a new part on the new stream", async ({ page }) => {
  await openApp(page);
  await page.click("#recBtn"); await page.click("#recOk");
  await start(page);
  await page.waitForTimeout(1500);
  await page.dispatchEvent("#micDev", "change"); // 换麦克风:restartMic 换了流
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts.length === 2);
  await expect(page.locator("#recBtn.live")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.click("#go");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jls.sessions")!)[0].rec.parts.every((p: any) => p.bytes > 0));
  const keys = (await idbSizes(page, "rec:sA:")).map(([k]) => k.split(":")[2]);
  expect([...new Set(keys)]).toEqual(["000", "001"]);
  const [a, b] = (await sess(page, "sA")).rec.parts;
  expect(b.t0).toBeGreaterThanOrEqual(a.t1 - 50);
});

test("storage full: recording stops with a message, listening goes on", async ({ page }) => {
  await openApp(page, () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v: unknown, k?: IDBValidKey) {
      if (typeof k === "string" && k.startsWith("rec:")) throw new DOMException("full", "QuotaExceededError");
      return put.call(this, v, k);
    };
  });
  await page.click("#recBtn"); await page.click("#recOk");
  await start(page);
  await expect(page.locator("#recBtn")).not.toHaveClass(/\bon\b/, { timeout: 20_000 }); // 第一块(约 10 秒)存不下
  await expect(page.locator("#partial")).toContainText(/录音已停止|recording stopped/);
  expect((await sess(page, "sA")).rec.on).toBe(false);
  expect(await page.evaluate(() => window.__ws.readyState)).toBe(1);
  await expect(page.locator("#go.stop")).toBeVisible();
  expect(await idbSizes(page, "rec:sA:")).toEqual([]);
});
