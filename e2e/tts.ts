// 测试用多人对话音频:ffmpeg 的 flite 合成(kal / awb / rms / slt 四种英文声音),按脚本拼成一个 24 kHz 单声道 WAV,
// 同时给出每句的起止时间(按实际有声部分算),作为说话人的参考标注。只在测试时生成,不提交 WAV
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FliteVoice = "kal" | "awb" | "rms" | "slt";
export interface Turn { voice: FliteVoice; text: string; /** 这句之前的静音(毫秒),默认 opts.gapMs */ gapMs?: number }
export interface Spoken extends Turn { i: number; /** 有声部分的起止(毫秒,从文件开头算) */ startMs: number; endMs: number }
export interface TtsOpts {
  /** 句间静音,默认 600 ms */ gapMs?: number;
  /** 采样率,默认 24000 */ rate?: number;
  /** 拼好后再过一遍的 ffmpeg -af 滤镜(例如模拟房间回声),不影响时间轴 */ af?: string;
  /** 输出路径;默认放在系统临时目录、按内容取名(同样的脚本直接复用) */ out?: string;
  /** 结尾静音(毫秒),默认 1000 */ tailMs?: number;
  /** 每句首尾静音怎么裁:peak = 10 ms 帧峰值低于 1%(默认),rms = 帧 RMS 低于 1%(裁得更紧) */ trim?: Trim;
}
export type Trim = "peak" | "rms";
export interface TtsResult { path: string; timeline: Spoken[]; durationMs: number; rate: number }

/** 单声道 16 位 PCM WAV 的样本(只认 data 块) */
export function readWav(path: string): { pcm: Int16Array; rate: number } {
  const b = readFileSync(path); let o = 12, rate = 0;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "fmt ") rate = b.readUInt32LE(o + 12);
    if (id === "data") { const len = Math.min(n, b.length - o - 8) >> 1, pcm = new Int16Array(len); for (let i = 0; i < len; i++) pcm[i] = b.readInt16LE(o + 8 + 2 * i); return { pcm, rate }; }
    o += 8 + n + (n & 1);
  }
  throw new Error("no data chunk: " + path);
}
export function writeWav(path: string, pcm: Int16Array, rate: number): void {
  const n = pcm.length, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, b);
}
/** 先写临时文件再改名:多个 worker 同时生成同一个文件时,读的一方(包括当假麦克风的 Chromium)不会读到半个 */
function atomic(path: string, write: (tmp: string) => void): void { const tmp = `${path}.${process.pid}.tmp.wav`; write(tmp); renameSync(tmp, path); }
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });

/** 合成一句,裁掉首尾静音(10 ms 一帧,峰值或 RMS 低于 1% 算静音,见 Trim) */
export function synth(voice: FliteVoice, text: string, rate = 24000, dir = cacheDir(), trim: Trim = "peak"): Int16Array {
  const key = createHash("sha1").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 16), wav = join(dir, `s-${key}.wav`);
  if (!existsSync(wav)) {
    const txt = join(dir, `s-${key}.${process.pid}.txt`); writeFileSync(txt, text);
    // textfile 避开 lavfi 对逗号、引号的转义
    atomic(wav, (t) => ff(["-f", "lavfi", "-i", `flite=textfile=${txt}:voice=${voice}`, "-ar", String(rate), "-ac", "1", "-c:a", "pcm_s16le", t]));
  }
  const { pcm } = readWav(wav), F = Math.round(rate / 100);
  const loud = trim === "rms"
    ? (f: number) => { let s = 0; for (let i = f * F; i < Math.min(pcm.length, (f + 1) * F); i++) s += pcm[i] * pcm[i]; return Math.sqrt(s / F) > 328; }
    : (f: number) => { for (let i = f * F; i < Math.min(pcm.length, (f + 1) * F); i++) if (Math.abs(pcm[i]) > 328) return true; return false; };
  const nf = Math.ceil(pcm.length / F); let a = 0, b = nf;
  while (a < nf && !loud(a)) a++;
  while (b > a && !loud(b - 1)) b--;
  return pcm.slice(a * F, Math.min(pcm.length, b * F));
}
function cacheDir() { const d = join(tmpdir(), "tsuji-tts"); mkdirSync(d, { recursive: true }); return d; }

/** 按脚本拼出对话 WAV,返回路径和每句的时间轴。开头留一个 gap,结尾留 tailMs 静音 */
export function ttsConversation(turns: Turn[], opts: TtsOpts = {}): TtsResult {
  const rate = opts.rate || 24000, gap = opts.gapMs ?? 600, tail = Math.round(((opts.tailMs ?? 1000) * rate) / 1000), trim = opts.trim || "peak", dir = cacheDir();
  const parts: Int16Array[] = [], timeline: Spoken[] = []; let n = 0;
  turns.forEach((tn, i) => {
    const sil = Math.round(((tn.gapMs ?? gap) * rate) / 1000), x = synth(tn.voice, tn.text, rate, dir, trim);
    parts.push(new Int16Array(sil), x);
    timeline.push({ ...tn, i, startMs: Math.round(((n + sil) * 1000) / rate), endMs: Math.round(((n + sil + x.length) * 1000) / rate) });
    n += sil + x.length;
  });
  parts.push(new Int16Array(tail)); n += tail;
  const pcm = new Int16Array(n); let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; }
  const key = createHash("sha1").update(JSON.stringify([turns, rate, gap, tail, trim, opts.af || ""])).digest("hex").slice(0, 16);
  const path = opts.out || join(dir, `conv-${key}.wav`);
  if (opts.af) { const raw = `${path}.${process.pid}.raw.wav`; writeWav(raw, pcm, rate); atomic(path, (t) => ff(["-i", raw, "-af", opts.af!, "-ar", String(rate), "-ac", "1", "-c:a", "pcm_s16le", t])); rmSync(raw, { force: true }); }
  else atomic(path, (t) => writeWav(t, pcm, rate));
  return { path, timeline, durationMs: Math.round((n * 1000) / rate), rate };
}

/** 轻度「房间」劣化:回声 + 低通 + 底噪(给 ttsConversation 的 af 用) */
export const ROOM_AF = "aecho=0.8:0.7:40:0.3,lowpass=f=3400,highpass=f=120";
/** 加底噪要两路混音,单独一步:把 WAV 混上 -noiseDb 的粉噪声,另存为 out */
export function addNoise(src: string, out: string, noiseDb = -38, rate = 24000): string {
  ff(["-i", src, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=1:seed=7`, "-filter_complex", `[1:a]volume=${noiseDb}dB[n];[0:a][n]amix=inputs=2:duration=first:normalize=0`, "-ar", String(rate), "-ac", "1", "-c:a", "pcm_s16le", out]);
  return out;
}

/** 示例:四个声音轮流说话 */
export const DEMO: Turn[] = [
  { voice: "awb", text: "Good morning everyone, thanks for joining the call today.", gapMs: 1000 },
  { voice: "slt", text: "Happy to be here. Shall we start with the budget?" },
  { voice: "kal", text: "Yes, the numbers came in yesterday afternoon." },
  { voice: "rms", text: "I have a few questions about the travel costs." },
];
// 命令行:node e2e/tts.ts out.wav   (用 DEMO 台本,时间轴打印成 JSON)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = ttsConversation(DEMO, { out: resolve(process.argv[2] || "tts.wav") });
  console.log(JSON.stringify(r.timeline.map(({ voice, text, startMs, endMs }) => ({ voice, text, startMs, endMs })), null, 1));
}
