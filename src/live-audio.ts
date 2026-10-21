// 实时收音的音频时间线:最近 60 秒的 24 kHz PCM 环形缓冲、按采样数算的音频时钟 at(毫秒),
// 以及把 Realtime 连接上的 audio_*_ms 换算成 at、给实时字幕定起止时间。不碰 DOM,node 下可直接测
import { spkResample, spkSegments } from "./spk/core";
import type { Line } from "./state";

const SR = 24000, PAD = 12; // PAD:重采样核半宽,切片两头多取一点,边缘和整段重采样一致
/** 流式字幕比音频晚出:离现在不到 GUESS_MARGIN 才开口的有声段多半是下一句(可能是下一个人),不算进这一行 */
export const GUESS_MARGIN = 600;
/** 强制断句等 committed 的期限;没等到(服务端缓冲已空、报错)就作废 */
const FORCED_TTL = 10000, ITEM_TTL = 60000;
/**
 * 开着说话人识别时的停顿断句(VAD 模型):一句说满 minTurn 毫秒后,最近 gap 毫秒的能量都不高于
 * 「最近 hist 毫秒能量的 20% 分位 + rel dB」、也不高于「中位数 − drop dB」就强制断句(后一条防一直很响、没有起伏的声音每句都切)。
 * 背景音乐下服务端 VAD 不断句,只靠 maxTurn 一刀刀切会把几个人切进一句
 */
export const PAUSE = { minTurn: 2000, gap: 200, rel: 10, drop: 5, hist: 10_000 };

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
  /** t:建这条记录时的 at,太久没 completed 的清掉 */
  private items: Record<string, { s?: number; e?: number; t: number }> = {};
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
  private item(id: string): { s?: number; e?: number; t: number } { return (this.items[id] ||= { t: this.now() }); }
  /**
   * 跟踪 item 的起止(和文件会话 fileConnect 的逻辑一样)。completed 时返回这一句的 [s, e](at),其他事件返回 null。
   * speech_started / speech_stopped 带 item_id 和 audio_start_ms / audio_end_ms;committed、completed 只带 item_id
   */
  event(m: RtEvent): [number, number] | null {
    const id = m.item_id || "", now = this.now();
    // 一直没 completed 的 item、等不到 committed 的强制断句都清掉,免得越积越多、错配到后面的句子上
    for (const k in this.items) if (now - this.items[k].t > ITEM_TTL) delete this.items[k];
    while (this.forcedAt.length && now - this.forcedAt[0] > FORCED_TTL) this.forcedAt.shift();
    if (m.type === "input_audio_buffer.speech_started") { if (typeof m.audio_start_ms === "number") this.item(id).s = this.map(m.audio_start_ms); }
    else if (m.type === "input_audio_buffer.speech_stopped") {
      if (typeof m.audio_end_ms === "number") this.item(id).e = this.map(m.audio_end_ms);
      // VAD 自己断了句:还没等到 committed 的强制 commit 撞上了空缓冲(服务端报错、不会有 committed),作废
      this.forcedAt = [];
    } else if (m.type === "input_audio_buffer.committed") {
      // 强制断句的段没有 speech_stopped:结束时间用发 commit 时的位置;紧接着的下一段从这里开始
      const it = this.item(id);
      if (it.s == null) it.s = this.commitEnd ?? this.lastEnd;
      if (it.e == null) it.e = this.forcedAt.shift() ?? now;
      this.commitEnd = it.e;
    } else if (m.type === "conversation.item.input_audio_transcription.completed") {
      const it = this.items[id]; delete this.items[id];
      const s = it?.s ?? this.lastEnd, e = Math.max(s + 300, it?.e ?? now);
      this.lastEnd = e;
      return [Math.round(s), Math.round(e)];
    }
    return null;
  }
  /**
   * 流式模型没有 VAD 事件:同一批 delta 切出的几句(w 是各句字数)一起定时间。在「上一行结束 → 现在」里做能量切分:
   * 离现在不到 GUESS_MARGIN 才开口的段留给下一行;最后一段已经说完就到它结束,还在说就到前一个停顿,
   * 没有停顿就到「现在 − GUESS_MARGIN」。这段范围按字数比例分给各句(和文件的 splitTimed 一样)
   */
  guess(w: number[] = [1]): [number, number][] {
    const to = this.now(), from = Math.min(to, Math.max(this.lastEnd, this.oldest())), lim = Math.max(from, to - GUESS_MARGIN);
    let s = from, e = lim;
    const pcm = this.pcm(from, to);
    if (pcm && pcm.length >= SR * 0.2) {
      const segs: [number, number][] = [];
      for (const [a, b] of spkSegments(pcm, SR, 0.25, 10, 0.15)) {
        const x = from + a * 1000, y = from + b * 1000, p = segs[segs.length - 1];
        if (p && x - p[1] < 50) p[1] = y; else segs.push([x, y]); // 长段被切成几块的接回去
      }
      const keep = segs.filter((g) => g[0] < lim);
      if (keep.length) {
        const last = keep[keep.length - 1];
        s = keep[0][0];
        e = to - last[1] >= 100 ? last[1] : keep.length > 1 ? keep[keep.length - 2][1] : Math.max(s, lim);
      }
    }
    this.lastEnd = Math.max(this.lastEnd, e);
    const tot = w.reduce((a, x) => a + Math.max(0, x), 0), out: [number, number][] = [];
    let acc = 0;
    for (const x of w) {
      const a = s + (e - s) * (tot ? acc / tot : out.length / w.length);
      acc += Math.max(0, x);
      out.push([Math.round(a), Math.round(s + (e - s) * (tot ? acc / tot : (out.length + 1) / w.length))]);
    }
    return out;
  }
  /** 现在是不是在停顿里(PAUSE) */
  paused(gap = PAUSE.gap, rel = PAUSE.rel, drop = PAUSE.drop, hist = PAUSE.hist): boolean {
    const F = SR / 50, to = this.now(), g = Math.round(gap / 20);
    const pcm = this.pcm(to - Math.min(hist, to - this.oldest()), to), n = pcm ? Math.floor(pcm.length / F) : 0;
    if (!pcm || n < g * 3) return false;
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = pcm.length - (n - i) * F; for (let j = o; j < o + F; j++) { const v = pcm[j] / 32768; s += v * v; } db[i] = 10 * Math.log10(s / F + 1e-12); }
    const q = Float32Array.from(db).sort(), th = Math.min(q[Math.floor(n * 0.2)] + rel, q[Math.floor(n * 0.5)] - drop);
    for (let i = n - g; i < n; i++) if (db[i] > th) return false;
    return true;
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
