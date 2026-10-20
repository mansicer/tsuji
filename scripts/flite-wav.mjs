// 用 ffmpeg 的 flite 合成多人对话的测试音频(24 kHz 单声道 WAV),同时返回每句话在里面的起止(参考标注)。
// 每句先去掉首尾静音,再按 gap 插入静音拼起来,所以返回的 start / end 就是有声部分。
// 用法:node scripts/flite-wav.mjs out.wav   (用内置的示例脚本,标注打印成 JSON)
// 或在测试里:import { fliteWav } from "../scripts/flite-wav.mjs"
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SR = 24000;

/** 一句话 → 24 kHz int16,去掉首尾低于 -40 dBFS 的部分 */
function say(voice, text) {
  const t = text.replace(/[':\\]/g, " ");
  const buf = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `flite=text='${t}':voice=${voice}`, "-ar", String(SR), "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const x = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), F = SR / 100, th = 32768 * 0.01;
  const loud = (i) => { let s = 0; for (let j = i; j < i + F && j < x.length; j++) s += x[j] * x[j]; return Math.sqrt(s / F) > th; };
  let a = 0, b = x.length;
  while (a < b && !loud(a)) a += F;
  while (b > a && !loud(Math.max(a, b - F))) b -= F;
  return x.slice(a, b);
}

/**
 * parts:[{ voice: "kal" | "awb" | "rms" | "slt", text, gap?: 前面的静音毫秒(默认 800) }];tail:末尾静音毫秒。
 * 写 WAV 到 out,返回 [{ voice, text, start, end }](毫秒)
 */
export function fliteWav(out, parts, tail = 1000) {
  const chunks = [], marks = []; let n = 0;
  for (const p of parts) {
    const gap = Math.round((p.gap ?? 800) * SR / 1000), pcm = say(p.voice, p.text);
    chunks.push(new Int16Array(gap), pcm);
    marks.push({ voice: p.voice, text: p.text, start: Math.round((n + gap) * 1000 / SR), end: Math.round((n + gap + pcm.length) * 1000 / SR) });
    n += gap + pcm.length;
  }
  chunks.push(new Int16Array(Math.round(tail * SR / 1000))); n += Math.round(tail * SR / 1000);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(n * 2, 40);
  let o = 44; for (const c of chunks) { Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(wav, o); o += c.byteLength; }
  writeFileSync(out, wav);
  return marks;
}

/** 示例:四个声音轮流说话 */
export const DEMO = [
  { voice: "awb", text: "Good morning everyone, thanks for joining the call today.", gap: 1000 },
  { voice: "slt", text: "Happy to be here. Shall we start with the budget?" },
  { voice: "kal", text: "Yes, the numbers came in yesterday afternoon." },
  { voice: "rms", text: "I have a few questions about the travel costs." },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || "flite.wav";
  console.log(JSON.stringify(fliteWav(out, DEMO), null, 1));
}
