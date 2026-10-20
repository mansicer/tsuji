// 测试音频:用 ffmpeg 的 flite 滤镜按台本合成多人对话 WAV(声音 kal / awb / rms / slt),同时给出每句的起止时间(参考标注)
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

export type FliteVoice = "kal" | "awb" | "rms" | "slt";
export interface FliteLine { voice: FliteVoice; text: string; who?: string }
export interface FliteSeg { who: string; voice: FliteVoice; text: string; s: number; e: number }

const probe = (f: string): number => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

/** 合成到 out(单声道 rate Hz 16 位 WAV),句间留 gap 秒静音;返回每句的起止毫秒 */
export function fliteWav(out: string, script: FliteLine[], { rate = 24000, gap = 0.4 } = {}): FliteSeg[] {
  const args = ["-y", "-loglevel", "error"];
  // flite 的 text 参数里冒号、引号、反斜杠要避开
  for (const l of script) args.push("-f", "lavfi", "-i", `flite=text='${l.text.replace(/[':\\]/g, " ")}':voice=${l.voice}`);
  const f = script.map((_, i) => `[${i}:a]aresample=${rate},apad=pad_dur=${gap}[a${i}]`).join(";") + ";" + script.map((_, i) => `[a${i}]`).join("") + `concat=n=${script.length}:v=0:a=1[out]`;
  execFileSync("ffmpeg", [...args, "-filter_complex", f, "-map", "[out]", "-ac", "1", "-ar", String(rate), "-c:a", "pcm_s16le", out]);
  // 每句单独合成一遍量时长,算出在整段里的位置
  const segs: FliteSeg[] = []; let at = 0;
  for (const l of script) {
    const one = out + ".one.wav";
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `flite=text='${l.text.replace(/[':\\]/g, " ")}':voice=${l.voice}`, "-ar", String(rate), one]);
    const d = probe(one) * 1000;
    segs.push({ who: l.who || l.voice, voice: l.voice, text: l.text, s: Math.round(at), e: Math.round(at + d) });
    at += d + gap * 1000;
  }
  rmSync(out + ".one.wav", { force: true });
  return segs;
}
export const wavDuration = probe;
