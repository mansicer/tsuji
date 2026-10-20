import { describe, it, expect } from "vitest";
import { LiveAudio, onLineAudio, lineAudio } from "../src/live-audio";
import type { Line } from "../src/state";

const CH = 2400; // 100 ms @ 24 kHz
/** 一块 100 ms:amp > 0 时是 440 Hz 正弦,否则静音;val 给定时整块填这个值(用来认样本) */
function chunk(amp = 0, val?: number, n = CH): Int16Array {
  const x = new Int16Array(n);
  for (let i = 0; i < n; i++) x[i] = val != null ? val : Math.round(amp * Math.sin(2 * Math.PI * 440 * i / 24000));
  return x;
}
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / (x.length || 1));

describe("LiveAudio buffer", () => {
  it("counts the clock from samples", () => {
    const a = new LiveAudio(2);
    expect(a.now()).toBe(0);
    for (let i = 0; i < 5; i++) a.push(chunk());
    expect(a.now()).toBe(500);
    a.push(new Int16Array(240)); expect(a.now()).toBe(510);
  });

  it("evicts audio older than the buffer and slice returns null for it", () => {
    const a = new LiveAudio(1); // 1 秒缓冲
    for (let i = 0; i < 15; i++) a.push(chunk(0, i)); // 第 i 块的值都是 i
    expect(a.now()).toBe(1500);
    expect(a.oldest()).toBe(500);
    expect(a.slice(400, 600)).toBeNull();
    expect(a.slice(500, 600)).not.toBeNull();
    // 绕过环形缓冲末尾的读取也按顺序拿回原值
    const p = a.pcm(900, 1300)!;
    expect(p.length).toBe(4 * CH);
    expect([p[0], p[CH], p[2 * CH], p[3 * CH], p[4 * CH - 1]]).toEqual([9, 10, 11, 12, 12]);
  });

  it("keeps only the tail of a push bigger than the buffer", () => {
    const a = new LiveAudio(1);
    a.push(chunk(0, 1, 3000));
    const big = new Int16Array(30000); big.fill(2, 0, 10000); big.fill(3, 10000);
    a.push(big);
    expect(a.now()).toBe(33000 / 24);
    const p = a.pcm(a.oldest(), a.now())!;
    expect(p.length).toBe(24000);
    expect(p[0]).toBe(2); expect(p[p.length - 1]).toBe(3);
    expect(p.filter((v) => v === 2).length).toBe(4000);
    a.push(chunk(0, 4));
    expect(a.pcm(a.now() - 100, a.now())![0]).toBe(4);
  });

  it("slice resamples to 16 kHz with the expected length and clamps to now", () => {
    const a = new LiveAudio(5);
    for (let i = 0; i < 10; i++) a.push(chunk(i >= 5 ? 8000 : 0));
    expect(a.slice(0, 1000)!.length).toBe(16000);
    expect(a.slice(250, 350)!.length).toBe(1600);
    expect(a.slice(900, 5000)!.length).toBe(1600); // 截到 now()
    expect(a.slice(600, 600)!.length).toBe(0);
    expect(a.slice(-100, 100)!.length).toBe(1600);
    // 静音段没有能量,有声段有;边缘也和整段重采样一致
    expect(rms(a.slice(0, 450)!)).toBeLessThan(1e-4);
    expect(rms(a.slice(550, 1000)!)).toBeGreaterThan(0.1);
    const whole = a.slice(0, 1000)!, part = a.slice(300, 600)!;
    for (const k of [0, 100, part.length - 1]) expect(part[k]).toBeCloseTo(whole[4800 + k], 5);
  });
});

describe("LiveAudio connection mapping", () => {
  it("maps audio_*_ms through connAt and keeps advancing across reconnects", () => {
    const a = new LiveAudio(60);
    for (let i = 0; i < 3; i++) a.push(chunk());
    a.begin(); // 第一个连接从 300 ms 开始送
    expect(a.connAt).toBe(300);
    for (let i = 0; i < 20; i++) a.push(chunk());
    expect(a.event({ type: "input_audio_buffer.speech_started", item_id: "i1", audio_start_ms: 500 })).toBeNull();
    a.event({ type: "input_audio_buffer.speech_stopped", item_id: "i1", audio_end_ms: 1500 });
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1" })).toEqual([800, 1800]);
    // 断线 1 秒:音频照样进缓冲,时钟不停;重连后 audio_*_ms 从 0 重算
    for (let i = 0; i < 10; i++) a.push(chunk());
    const before = a.now();
    a.begin();
    expect(a.connAt).toBe(before);
    for (let i = 0; i < 20; i++) a.push(chunk());
    a.event({ type: "input_audio_buffer.speech_started", item_id: "i1", audio_start_ms: 200 }); // 新连接上 item id 可能重复
    a.event({ type: "input_audio_buffer.speech_stopped", item_id: "i1", audio_end_ms: 900 });
    const [s, e] = a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1" })!;
    expect([s, e]).toEqual([before + 200, before + 900]);
    expect(s).toBeGreaterThan(1800);
  });

  it("handles forced commits and completed without VAD events like the file pipeline", () => {
    const a = new LiveAudio(60);
    a.begin();
    for (let i = 0; i < 10; i++) a.push(chunk());
    a.event({ type: "input_audio_buffer.speech_started", item_id: "a", audio_start_ms: 100 });
    for (let i = 0; i < 10; i++) a.push(chunk());
    a.forced(); // 2000
    for (let i = 0; i < 5; i++) a.push(chunk());
    a.event({ type: "input_audio_buffer.committed", item_id: "a" });
    a.event({ type: "input_audio_buffer.speech_stopped", item_id: "b", audio_end_ms: 2400 }); // 强制断句后的下一段,没有 speech_started
    a.event({ type: "input_audio_buffer.committed", item_id: "b" });
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a" })).toEqual([100, 2000]);
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "b" })).toEqual([2000, 2400]);
    // 完全没有事件:从上一行结束到现在,至少 300 ms
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "z" })).toEqual([2400, 2700]);
  });

  it("resets the clock and state on stop", () => {
    const a = new LiveAudio(60);
    for (let i = 0; i < 10; i++) a.push(chunk(8000));
    a.begin(); a.push(chunk());
    a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "x" });
    a.stop();
    expect(a.now()).toBe(0); expect(a.connAt).toBe(0); expect(a.lastEnd).toBe(0);
    expect(a.slice(0, 100)!.length).toBe(0);
    a.push(chunk());
    expect(rms(a.slice(0, 100)!)).toBe(0); // 旧音频不会冒出来
  });
});

describe("LiveAudio.guess (streaming models)", () => {
  it("finds the speech between the previous line end and now", () => {
    const a = new LiveAudio(60);
    const plan = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]; // 0.5–1.3 秒有声
    for (const p of plan) a.push(chunk(p ? 8000 : 30));
    const [s, e] = a.guess();
    expect(Math.abs(s - 500)).toBeLessThanOrEqual(40);
    expect(Math.abs(e - 1300)).toBeLessThanOrEqual(40);
    expect(a.lastEnd).toBe(e);
    // 下一行:从上一行结束开始找
    for (const p of [0, 0, 0, 1, 1, 1, 1, 1, 0, 0]) a.push(chunk(p ? 8000 : 30));
    const [s2, e2] = a.guess();
    expect(Math.abs(s2 - 2300)).toBeLessThanOrEqual(40);
    expect(Math.abs(e2 - 2800)).toBeLessThanOrEqual(40);
  });

  it("falls back to [previous end, now] without speech", () => {
    const a = new LiveAudio(60);
    for (let i = 0; i < 10; i++) a.push(chunk());
    expect(a.guess()).toEqual([0, 1000]);
    a.push(chunk());
    expect(a.guess()).toEqual([1000, 1100]);
    expect(a.guess()).toEqual([1100, 1100]); // 同一刻出两行
  });
});

describe("onLineAudio", () => {
  it("notifies and unsubscribes", () => {
    const got: number[] = [];
    const off = onLineAudio((l) => got.push(l.id));
    lineAudio({ id: 7 } as Line);
    off();
    lineAudio({ id: 8 } as Line);
    expect(got).toEqual([7]);
  });
});
