// 实时收音的音频时间线:最近 60 秒的 24 kHz PCM 环形缓冲、按采样数算的音频时钟 at(毫秒),
// 以及把 Realtime 连接上的 audio_*_ms 换算成 at、给实时字幕定起止时间。不碰 DOM,node 下可直接测
import { spkResample, spkSegments } from "./spk/core";
import type { Line } from "./state";

const SR = 24000, PAD = 12; // PAD:重采样核半宽,切片两头多取一点,边缘和整段重采样一致

/** Realtime 服务端事件里用到的字段 */
export interface RtEvent { type: string; item_id?: string; audio_start_ms?: number; audio_end_ms?: number }

export class LiveAudio {
  private buf: Int16Array;
  /** 累计收到的采样数(at = total / 24) */
  private total = 0;
  /** 当前连接开始送音频时的 at;服务端的 audio_*_ms 从这里算起 */
  connAt = 0;
  /** 上一行实时字幕的结束 at */
  lastEnd = 0;
  private items: Record<string, { s?: number; e?: number }> = {};
  private forcedAt: number[] = [];
  private commitEnd: number | null = null;
  constructor(readonly sec = 60) { this.buf = new Int16Array(SR * sec); }

  /** onSamples 每块都调,不管 WebSocket 连没连上 */
  push(pcm: Int16Array): void {
    const cap = this.buf.length;
    if (pcm.length > cap) { this.total += pcm.length - cap; pcm = pcm.subarray(pcm.length - cap); } // 只留最后 cap 个
    const w = this.total % cap, n1 = Math.min(pcm.length, cap - w);
    this.buf.set(pcm.subarray(0, n1), w);
    if (n1 < pcm.length) this.buf.set(pcm.subarray(n1), 0);
    this.total += pcm.length;
  }
  now(): number { return this.total / (SR / 1000); }
  /** 缓冲里最早还在的 at */
  oldest(): number { return Math.max(0, this.total - this.buf.length) / (SR / 1000); }

  /** [fromAt, toAt) 的原始 24 kHz 采样,前后各多取 pad 个(取不到就少取);已经被挤出缓冲返回 null */
  private raw(fromAt: number, toAt: number, pad = 0): { pcm: Int16Array; a: number; b: number } | null {
    const lo = Math.max(0, this.total - this.buf.length);
    const a = Math.max(0, Math.round(fromAt * SR / 1000)), b = Math.min(this.total, Math.round(toAt * SR / 1000));
    if (a < lo) return null;
    if (b <= a) return { pcm: new Int16Array(0), a: 0, b: 0 };
    const x0 = Math.max(lo, a - pad), x1 = Math.min(this.total, b + pad), cap = this.buf.length, out = new Int16Array(x1 - x0);
    const r = x0 % cap, n1 = Math.min(out.length, cap - r);
    out.set(this.buf.subarray(r, r + n1));
    if (n1 < out.length) out.set(this.buf.subarray(0, out.length - n1), n1);
    return { pcm: out, a: a - x0, b: b - x0 };
  }
  /** [fromAt, toAt) 的 24 kHz int16;被挤出缓冲返回 null */
  pcm(fromAt: number, toAt: number): Int16Array | null {
    const r = this.raw(fromAt, toAt);
    return r && r.pcm.subarray(r.a, r.b);
  }
  /** [fromAt, toAt) 的 16 kHz float32(给声纹用);被挤出缓冲返回 null。toAt 超过 now() 时截到 now() */
  slice(fromAt: number, toAt: number): Float32Array | null {
    const r = this.raw(fromAt, toAt, PAD);
    return r && spkResample(r.pcm, r.a, r.b);
  }

  /** 新连接送出第一块音频前调:记下 connAt,上一条连接没收尾的 item 作废 */
  begin(): void { this.connAt = this.now(); this.items = {}; this.forcedAt = []; this.commitEnd = null; }
  /** 连接上的 audio_*_ms → at */
  map(ms: number): number { return this.connAt + ms; }
  /** 发强制断句的 commit 时调(这种段没有 speech_stopped) */
  forced(): void { this.forcedAt.push(this.now()); }
  /**
   * 跟踪 item 的起止(和文件会话 fileConnect 的逻辑一样)。completed 时返回这一句的 [s, e](at),其他事件返回 null。
   * speech_started / speech_stopped 带 item_id 和 audio_start_ms / audio_end_ms;committed、completed 只带 item_id
   */
  event(m: RtEvent): [number, number] | null {
    const id = m.item_id || "";
    if (m.type === "input_audio_buffer.speech_started") { if (typeof m.audio_start_ms === "number") (this.items[id] ||= {}).s = this.map(m.audio_start_ms); }
    else if (m.type === "input_audio_buffer.speech_stopped") { if (typeof m.audio_end_ms === "number") (this.items[id] ||= {}).e = this.map(m.audio_end_ms); }
    else if (m.type === "input_audio_buffer.committed") {
      // 强制断句的段没有 speech_stopped:结束时间用发 commit 时的位置;紧接着的下一段从这里开始
      const it = (this.items[id] ||= {});
      if (it.s == null) it.s = this.commitEnd ?? this.lastEnd;
      if (it.e == null) it.e = this.forcedAt.shift() ?? this.now();
      this.commitEnd = it.e;
    } else if (m.type === "conversation.item.input_audio_transcription.completed") {
      const it = this.items[id] || {}; delete this.items[id];
      const s = it.s ?? this.lastEnd, e = Math.max(s + 300, it.e ?? this.now());
      this.lastEnd = e;
      return [Math.round(s), Math.round(e)];
    }
    return null;
  }
  /**
   * 流式模型没有 VAD 事件:在「上一行结束 → 现在」这段里做能量切分,有声部分的首尾就是这一行的起止;
   * 找不到有声段就用 [上一行结束, 现在]
   */
  guess(): [number, number] {
    const to = this.now(), from = Math.min(to, Math.max(this.lastEnd, this.oldest()));
    let s = from, e = to;
    const pcm = this.pcm(from, to);
    if (pcm && pcm.length >= SR * 0.2) {
      const segs = spkSegments(pcm, SR, 0.25, 10, 0.15);
      if (segs.length) { s = from + segs[0][0] * 1000; e = from + segs[segs.length - 1][1] * 1000; }
    }
    this.lastEnd = Math.max(this.lastEnd, e);
    return [Math.round(s), Math.round(e)];
  }
  /** 停止收音:时钟归零、清空缓冲 */
  stop(): void { this.total = 0; this.connAt = 0; this.lastEnd = 0; this.items = {}; this.forcedAt = []; this.commitEnd = null; }
}

/** 页面上唯一的实时音频时间线 */
export const liveAudio = new LiveAudio();

// 实时字幕拿到 aStart / aEnd 时通知(实时说话人识别用);合并短句延长了上一行的 aEnd 时也会对上一行再通知一次
const lineAudioCbs: ((line: Line) => void)[] = [];
export function onLineAudio(cb: (line: Line) => void): () => void {
  lineAudioCbs.push(cb);
  return () => { const i = lineAudioCbs.indexOf(cb); if (i >= 0) lineAudioCbs.splice(i, 1); };
}
export function lineAudio(line: Line): void { for (const cb of lineAudioCbs) { try { cb(line); } catch (e) { console.error(e); } } }
