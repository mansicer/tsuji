// 文件会话:浏览器里用 ffmpeg.wasm 提取音轨 → 假识别 → 翻译;处理完再「重新处理」要清掉上一遍的字幕和翻译记忆
import type { Page } from "@playwright/test";
import { test, expect, openApp, reload, translated, lines, idbKeys } from "./fixtures";

/** 2 秒 24 kHz 单声道 440 Hz 正弦波 WAV */
function wav(seconds = 2, rate = 24000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return buf;
}

/** 等这一遍的 WebSocket 开始送音频,识别出一句,再等整遍处理完(送完音频后静默 4 秒才收尾) */
async function processOnce(page: Page, k: number, text: string) {
  await page.waitForFunction((i) => window.__wss.length >= i && window.__wss[i - 1].sent.some((m: string) => m.includes("input_audio_buffer.append")), k, { timeout: 45_000 });
  await page.evaluate((x) => {
    const ws = window.__ws;
    ws.emit({ type: "input_audio_buffer.speech_started", item_id: x, audio_start_ms: 100 });
    ws.emit({ type: "input_audio_buffer.speech_stopped", item_id: x, audio_end_ms: 1500 });
    ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: x, transcript: x });
  }, text);
  await translated(page, k);
  await expect(page.locator("#go.redo")).toBeVisible({ timeout: 15_000 });
}

test("processing a file again replaces the previous pass", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.__t.setPickFor({ tplId: "general" }));
  await page.setInputFiles("#mediaFile", { name: "clip.wav", mimeType: "audio/wav", buffer: wav() });
  await page.waitForFunction(() => localStorage.getItem("jls.curSession") !== "sA");
  const id = await page.evaluate(() => localStorage.getItem("jls.curSession")!);

  await page.click("#go");
  await processOnce(page, 1, "一回目");
  expect(await lines(page)).toEqual([["一回目", "T:一回目"]]);
  expect(await idbKeys(page)).toContain("lines:" + id);

  await page.click("#go"); await page.click("#go"); // 重新处理要点两次确认
  expect(await lines(page)).toEqual([]);
  await processOnce(page, 2, "二回目");
  expect(await lines(page)).toEqual([["二回目", "T:二回目"]]);

  await reload(page);
  expect(await lines(page)).toEqual([["二回目", "T:二回目"]]);
  expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k) || "[]", "jls.smemo." + id))).toEqual(["note from 二回目"]);
});
