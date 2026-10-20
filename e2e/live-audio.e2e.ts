// 实时音频时间线:flite 合成的 WAV 当麦克风(Chromium 循环播放、按真实时间走),
// 假 WebSocket 按 WAV 里的说话时间发 VAD 事件,检查字幕的 aStart / aEnd 和 slice() 取回的音频
import type { Page } from "@playwright/test";
import { test, expect, openApp, reload, start } from "./fixtures";
import { ttsConversation } from "./tts";
import { tmpdir } from "node:os";
import { join } from "node:path";

// trim: "rms" 让每句的起止贴着有声部分(下面的静音检查只留 120 ms 余量)
const conv = ttsConversation([
  { voice: "awb", text: "Good morning everyone, thanks for joining.", gapMs: 1000 },
  { voice: "slt", text: "Happy to be here today.", gapMs: 1500 },
], { tailMs: 2000, trim: "rms", out: join(tmpdir(), `tsuji-live-audio-${process.pid}.wav`) });
const WAV = conv.path, marks = conv.timeline.map((t) => ({ start: t.startMs, end: t.endMs }));
const LOOP = conv.durationMs; // WAV 总长;假麦克风循环播放
test.use({ launchOptions: {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`],
} });

/** 第 i 句在 at 之后(含)的下一次出现:[起, 止](音频时钟 ms)。off = 时钟 0 落在 WAV 的哪里的修正(见 clockOffset) */
function occ(i: number, after: number, off: number): [number, number] {
  const s = marks[i].start + off, k = Math.max(0, Math.ceil((after - s) / LOOP));
  return [s + k * LOOP, marks[i].end + off + k * LOOP];
}
/**
 * 时钟 0 和 WAV 开头差多少:假麦克风从 getUserMedia 时就开始放,接上 AudioWorklet 之前的那一点收不到。
 * 用缓冲里第一句的起音(10 ms 帧)量出来,实测在 ±150 ms 内
 */
async function clockOffset(page: Page): Promise<number> {
  await waitNow(page, marks[0].start + 800);
  const onset = await page.evaluate(() => {
    const x = window.__t.liveAudio.slice(0, window.__t.liveAudio.now()) as Float32Array;
    for (let i = 0; i + 160 <= x.length; i += 160) { let s = 0; for (let j = i; j < i + 160; j++) s += x[j] * x[j]; if (Math.sqrt(s / 160) > 0.02) return i / 16; }
    return NaN;
  });
  const off = onset - marks[0].start;
  console.log("clock offset", off, "ms");
  expect(Math.abs(off)).toBeLessThan(500);
  return off;
}
const audio = (page: Page) => page.evaluate(() => ({ now: window.__t.liveAudio.now() as number, connAt: window.__t.liveAudio.connAt as number }));
const waitNow = (page: Page, at: number) => page.waitForFunction((x) => window.__t.liveAudio.now() > x, at, { timeout: 30_000 });
/** slice() 取回的 16 kHz 音频的 RMS;被挤出缓冲返回 -1 */
const rms = (page: Page, a: number, b: number) => page.evaluate(([a, b]) => {
  const x = window.__t.liveAudio.slice(a, b) as Float32Array | null;
  if (!x) return -1;
  let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length || 1));
}, [a, b]);
/** Realtime 一句话的事件:speech_started / speech_stopped(相对本连接)→ committed → completed */
const sayTimed = (page: Page, id: string, text: string, s: number, e: number) => page.evaluate(([id, text, s, e]) => {
  const w = window.__ws;
  w.emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: s });
  w.emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: e });
  w.emit({ type: "input_audio_buffer.committed", item_id: id });
  w.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
}, [id, text, s, e] as const);
const timed = (page: Page) => page.evaluate(() => window.__t.lines.filter((l: any) => l.aStart != null).map((l: any) => ({ raw: l.raw, aStart: l.aStart, aEnd: l.aEnd, ms: l.ms ?? null })));

test("live lines get audio-clock times from VAD events, and slice() returns their speech", async ({ page }) => {
  await openApp(page); await start(page);
  const off = await clockOffset(page), { connAt } = await audio(page);
  const [s0, e0] = occ(0, connAt + 200, off), [s1, e1] = occ(1, e0, off);
  await waitNow(page, e1 + 300);
  await sayTimed(page, "item_1", "おはよう", s0 - connAt, e0 - connAt);
  await sayTimed(page, "item_2", "どうも", s1 - connAt, e1 - connAt);
  const got = await timed(page);
  expect(got).toEqual([{ raw: "おはよう", aStart: s0, aEnd: e0, ms: null }, { raw: "どうも", aStart: s1, aEnd: e1, ms: null }]);
  // 时钟和 WAV 对得上:句子范围里有声,句前 / 句间是静音
  const speech = [await rms(page, s0, e0), await rms(page, s1, e1)];
  const quiet = [await rms(page, s0 - 700, s0 - 120), await rms(page, e0 + 120, s1 - 120)];
  console.log("speech rms", speech.map((v) => v.toFixed(3)), "silence rms", quiet.map((v) => v.toFixed(4)));
  for (const v of speech) expect(v).toBeGreaterThan(0.03);
  for (const v of quiet) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(0.005); }
  // 时间格式没被当成文件会话:没有 .tm
  expect(await page.locator("#log .row .tm").count()).toBe(0);
  // 存下来、刷新后还在
  await page.waitForTimeout(800);
  await page.click("#go");
  await reload(page);
  expect((await timed(page)).map((l) => [l.aStart, l.aEnd])).toEqual([[s0, e0], [s1, e1]]);
});

test("the audio clock keeps running across a WebSocket reconnect", async ({ page }) => {
  await openApp(page); await start(page);
  const off = await clockOffset(page), c1 = (await audio(page)).connAt;
  const [s0, e0] = occ(0, c1 + 200, off);
  await waitNow(page, e0 + 300);
  await sayTimed(page, "item_1", "前", s0 - c1, e0 - c1);
  // 断线:1.5 秒后重连;断开期间音频照样进缓冲
  const n0 = (await audio(page)).now;
  await page.evaluate(() => { const w = window.__ws; w.readyState = 3; w.onclose({ code: 1006, reason: "" }); });
  await page.waitForTimeout(700);
  expect((await audio(page)).now).toBeGreaterThan(n0 + 400);
  await page.waitForFunction((n) => window.__wss.length === 2 && window.__t.liveAudio.connAt > n, n0, { timeout: 10_000 });
  const c2 = (await audio(page)).connAt;
  expect(c2).toBeGreaterThan(n0 + 1000);
  const [s1, e1] = occ(1, c2 + 200, off);
  await waitNow(page, e1 + 300);
  await sayTimed(page, "item_1", "後", s1 - c2, e1 - c2); // 新连接上 item id 从头来,可能和旧的重复
  const got = await timed(page);
  expect(got.map((l) => [l.raw, l.aStart, l.aEnd])).toEqual([["前", s0, e0], ["後", s1, e1]]);
  expect(got[1].aStart).toBeGreaterThan(got[0].aEnd);
  // 重连后的时间也和音频对得上
  expect(await rms(page, s1, e1)).toBeGreaterThan(0.03);
  expect(await rms(page, s1 - 700, s1 - 120)).toBeLessThan(0.005);
});

test("streaming-model lines get times from local energy segmentation", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { document.querySelector<HTMLSelectElement>("#asrModel")!.value = "gpt-live-transcribe"; });
  await start(page);
  const off = await clockOffset(page);
  const [s0, e0] = occ(0, 0, off), [s1, e1] = occ(1, e0, off);
  await waitNow(page, e0 + 400);
  await page.evaluate(() => window.__ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "s", delta: "おはようございます。" }));
  await waitNow(page, e1 + 400);
  await page.evaluate(() => window.__ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "s", delta: "はい。" }));
  const got = await timed(page);
  console.log("streaming", JSON.stringify(got), "expected", [s0, e0, s1, e1]);
  expect(got.map((l) => l.raw)).toEqual(["おはようございます。", "はい。"]);
  const tol = 150;
  for (const [l, s, e] of [[got[0], s0, e0], [got[1], s1, e1]] as const) {
    expect(Math.abs(l.aStart - s)).toBeLessThanOrEqual(tol);
    expect(Math.abs(l.aEnd - e)).toBeLessThanOrEqual(tol);
    expect(l.ms).toBeNull();
  }
});

test("streaming: two sentences in one delta share the speech; a speaker who just started is left for the next line", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { document.querySelector<HTMLSelectElement>("#asrModel")!.value = "gpt-live-transcribe"; });
  await start(page);
  const off = await clockOffset(page);
  const delta = (d: string) => page.evaluate((d) => window.__ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "s", delta: d }), d);
  // 一个 delta 里两句:不再是第二句几乎零长度,两句按字数分「第一句开口 → 第二句说完」
  const [s0, e0] = occ(0, 0, off), [s1, e1] = occ(1, e0, off);
  await waitNow(page, e1 + 400);
  await delta("おはようございます。はい。");
  let got = await timed(page);
  console.log("one delta", JSON.stringify(got), "expected", [s0, e0, s1, e1]);
  expect(got.map((l) => l.raw)).toEqual(["おはようございます。", "はい。"]);
  expect(Math.abs(got[0].aStart - s0)).toBeLessThanOrEqual(150);
  expect(Math.abs(got[1].aEnd - e1)).toBeLessThanOrEqual(150);
  expect(got[0].aEnd).toBe(got[1].aStart);
  expect(got[1].aEnd - got[1].aStart).toBeGreaterThan(300);
  // 下一轮:第一个人说完,第二个人刚开口 ~300 ms 时字幕才出 → 这一行到第一个人说完为止
  const [s2, e2] = occ(0, e1 + 100, off), [s3, e3] = occ(1, e2, off);
  await waitNow(page, s3 + 250);
  // 行出来后可能被翻译队列和前后的短行合并,所以每次出行马上读
  const line = async (raw: string) => { await delta(raw); return (await timed(page)).find((l) => l.raw === raw)!; };
  const a = await line("おはよう。");
  // 第二个人说完再出他的那一行:从他开口算起
  await waitNow(page, e3 + 400);
  got = [a, await line("どうも。")];
  console.log("next speaker", JSON.stringify(got), "expected", [s2, e2, s3, e3]);
  expect(got.map((l) => l.raw)).toEqual(["おはよう。", "どうも。"]);
  expect(Math.abs(got[0].aStart - s2)).toBeLessThanOrEqual(150);
  expect(Math.abs(got[0].aEnd - e2)).toBeLessThanOrEqual(150);
  expect(got[0].aEnd).toBeLessThan(s3);
  expect(Math.abs(got[1].aStart - s3)).toBeLessThanOrEqual(150);
  expect(Math.abs(got[1].aEnd - e3)).toBeLessThanOrEqual(150);
});
