// 文件翻译里不碰页面和会话状态的部分:带进度下载、ffmpeg.wasm 提取音轨、按句拆分并按字数分时间
import { FFmpeg, type FFFSType } from "@ffmpeg/ffmpeg";
import ffmpegCore from "@ffmpeg/core?url";
import ffmpegWasm from "@ffmpeg/core/wasm?url";

// ffmpeg.wasm 核心(约 32 MB)随页面同源发布,首次用到时才加载,之后走浏览器缓存
let ffmpegP: Promise<FFmpeg> | null = null;
// 带进度下载(用于 32 MB 的 ffmpeg 核心和 28 MB 的声纹模型);已缓存时很快走完
export async function fetchProgress(url: string, onPct: ((p: number) => void) | null | undefined, guess: number): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()} ${res.status}`);
  const total = Number(res.headers.get("content-length")) || guess, rd = res.body!.getReader(), parts: Uint8Array[] = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onPct && onPct(Math.min(1, got / total)); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function loadFfmpeg(onPct: (p: number) => void): Promise<FFmpeg> {
  return (ffmpegP ||= (async () => {
    const ff = new FFmpeg();
    const wasm = URL.createObjectURL(new Blob([await fetchProgress(new URL(ffmpegWasm, location.href).href, onPct, 32232419)], { type: "application/wasm" }));
    try { await ff.load({ coreURL: new URL(ffmpegCore, location.href).href, wasmURL: wasm }); } finally { URL.revokeObjectURL(wasm); }
    return ff;
  })().catch((e) => { ffmpegP = null; throw e; }));
}
export interface ExtractCallbacks {
  onPhase(phase: "loading" | "extract"): void; // 进入新阶段(进度从 0 开始)
  onLoad(p: number): void; // 下载 ffmpeg 核心的进度
  onExtract(p: number): void; // 提取音轨的进度
}
// 提取成 24 kHz 单声道 16 位 PCM
export async function extractPcm(blob: Blob, cb: ExtractCallbacks): Promise<Int16Array> {
  cb.onPhase("loading");
  const ff = await loadFfmpeg((p) => cb.onLoad(p));
  cb.onPhase("extract");
  const onP = ({ progress }: { progress: number }) => cb.onExtract(Math.max(0, Math.min(1, progress || 0)));
  ff.on("progress", onP);
  try {
    await ff.createDir("/in").catch(() => {});
    await ff.mount("WORKERFS" as FFFSType, { blobs: [{ name: "input", data: blob }] }, "/in");
    const rc = await ff.exec(["-i", "/in/input", "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "/out.pcm"]);
    if (rc !== 0) throw new Error("ffmpeg " + rc);
    const d = await ff.readFile("/out.pcm") as Uint8Array; await ff.deleteFile("/out.pcm").catch(() => {});
    return new Int16Array(d.buffer, d.byteOffset, d.byteLength >> 1);
  } finally { ff.off("progress", onP); await ff.unmount("/in").catch(() => {}); }
}
// 一段里有几句就拆开,时间按字数比例分;只有标点的句子丢掉(它占的时间也不分给别的句子)
export function splitTimed(text: string, s: number, e: number, cjkSource: boolean): { text: string; s: number; e: number }[] {
  const re = cjkSource ? /[^。！？]+[。！？]+[」』）)]*|[^。！？]+$/g : /\S[\s\S]*?(?:[.!?]+["')\]]*(?=\s|$)|$)/g;
  const parts = (text.match(re) || [text]).map((x) => x.trim()).filter(Boolean);
  const total = parts.reduce((a, x) => a + x.length, 0) || 1; let at = s;
  const out: { text: string; s: number; e: number }[] = [];
  for (const ptxt of parts) {
    const d = (e - s) * ptxt.length / total;
    if (/[^\s。、！？!?,.，「」『』()（）…]/.test(ptxt)) out.push({ text: ptxt, s: at, e: at + d });
    at += d;
  }
  return out;
}
