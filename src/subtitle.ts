// 字幕时间显示与 SRT / VTT 导出(纯函数,DOM 状态由调用方传入)

/** 行内时间戳:m:ss 或 h:mm:ss */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}

export interface SubtitleLine { ms?: number | null; endMs?: number; src?: string; tgt?: string }

/**
 * 字幕文件内容:译文在上、原文在下(withSrc 为 false 只导出译文)。
 * prefix 给每行加说话人前缀;短于 800 ms 的 cue 会被拉长到 800 ms。
 */
export function subtitleFile(kind: "srt" | "vtt", lines: SubtitleLine[], withSrc: boolean, prefix: (l: SubtitleLine) => string = () => ""): string {
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s2 = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
    return [h, m, s2].map((v) => String(v).padStart(2, "0")).join(":") + (kind === "srt" ? "," : ".") + String(x).padStart(3, "0");
  };
  const cues = lines.filter((l) => l.ms != null && (l.tgt || l.src)).map((l, i) => `${i + 1}\n${ts(l.ms!)} --> ${ts(Math.max(l.endMs ?? l.ms!, l.ms! + 800))}\n${prefix(l)}${l.tgt || l.src}${withSrc && l.tgt && l.src ? "\n" + l.src : ""}\n`);
  return (kind === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n");
}
