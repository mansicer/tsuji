import { describe, it, expect } from "vitest";
import { LiveAudio, onLineAudio, lineAudio, GUESS_MARGIN } from "../src/live-audio";
import type { Line } from "../src/state";

const CH = 2400; // 100 ms @ 24 kHz
/** 一块 100 ms:amp > 0 时是 440 Hz 正弦,否则静音;val 给定时整块填这个值(用来认样本) */
function chunk(amp = 0, val?: number, n = CH): Int16Array {
  const x = new Int16Array(n);
  for (let i = 0; i < n; i++) x[i] = val != null ? val : Math.round(amp * Math.sin(2 * Math.PI * 440 * i / 24000));
  return x;
}
/** 推 n 块静音 */
const feed = (a: LiveAudio, n: number) => { for (let i = 0; i < n; i++) a.push(chunk()); };
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

  it("drops a forced commit that never got committed (VAD stopped at the same moment)", () => {
    const a = new LiveAudio(60);
    a.begin();
    feed(a, 10);
    a.event({ type: "input_audio_buffer.speech_started", item_id: "a", audio_start_ms: 100 });
    feed(a, 10);
    a.forced(); // 2000:同时 VAD 也断了句,这个 commit 撞上空缓冲,服务端报错、没有 committed
    a.event({ type: "input_audio_buffer.speech_stopped", item_id: "a", audio_end_ms: 1950 });
    a.event({ type: "input_audio_buffer.committed", item_id: "a" });
    a.event({ type: "error" });
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a" })).toEqual([100, 1950]);
    // 下一段又被强制断句:结束时间是它自己的 commit 时间,不是上面那个过期的 2000
    feed(a, 10);
    a.event({ type: "input_audio_buffer.speech_started", item_id: "b", audio_start_ms: 3000 });
    feed(a, 20);
    a.forced(); // 5000
    feed(a, 3);
    a.event({ type: "input_audio_buffer.committed", item_id: "b" });
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "b" })).toEqual([3000, 5000]);
  });

  it("expires forced commits and items that never complete", () => {
    const a = new LiveAudio(120);
    a.begin();
    feed(a, 10);
    a.forced(); // 1000,一直没有 committed(也没有 speech_stopped)
    a.event({ type: "input_audio_buffer.speech_started", item_id: "lost", audio_start_ms: 900 }); // 永远没有 completed
    feed(a, 150); // 16 秒后
    a.event({ type: "input_audio_buffer.speech_started", item_id: "c", audio_start_ms: 15000 });
    a.forced(); // 16000
    a.event({ type: "input_audio_buffer.committed", item_id: "c" });
    expect(a.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "c" })).toEqual([15000, 16000]);
    expect(Object.keys((a as unknown as { items: object }).items)).toEqual(["lost"]);
    feed(a, 460); // 61 秒后:没完成的 item 也清掉
    a.event({ type: "input_audio_buffer.speech_started", item_id: "d", audio_start_ms: 61000 });
    expect(Object.keys((a as unknown as { items: object }).items)).toEqual(["d"]);
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
  /** 按 100 ms 一块推:1 有声,0 安静 */
  const feed = (a: LiveAudio, plan: number[]) => { for (const p of plan) a.push(chunk(p ? 8000 : 30)); };
  const near = (x: number, y: number, tol = 40) => expect(Math.abs(x - y)).toBeLessThanOrEqual(tol);

  it("finds the speech between the previous line end and now", () => {
    const a = new LiveAudio(60);
    feed(a, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]); // 0.5–1.3 秒有声
    const [[s, e]] = a.guess();
    near(s, 500); near(e, 1300);
    expect(a.lastEnd).toBe(e);
    // 下一行:从上一行结束开始找;说完 200 ms 就出字也算说完了
    feed(a, [0, 0, 0, 1, 1, 1, 1, 1, 0, 0]);
    const [[s2, e2]] = a.guess();
    near(s2, 2300); near(e2, 2800);
  });

  it("falls back to [previous end, now - margin] without speech", () => {
    const a = new LiveAudio(60);
    feed(a, Array(10).fill(0));
    expect(a.guess()).toEqual([[0, 1000 - GUESS_MARGIN]]);
    feed(a, [0, 0, 0, 0, 0, 0, 0]);
    expect(a.guess()).toEqual([[400, 1700 - GUESS_MARGIN]]);
    expect(a.guess()).toEqual([[1100, 1100]]); // 同一刻再出一行
  });

  it("splits two sentences from one delta by text length instead of giving the second one nothing", () => {
    const a = new LiveAudio(60);
    // 第一句 0.5–2.5 秒,停 0.5 秒,第二句 3.0–4.0 秒,之后安静 0.5 秒才出字
    feed(a, [0, 0, 0, 0, 0, ...Array(20).fill(1), 0, 0, 0, 0, 0, ...Array(10).fill(1), 0, 0, 0, 0, 0]);
    const [l1, l2] = a.guess([20, 10]);
    near(l1[0], 500); near(l2[1], 4000);
    expect(l1[1]).toBe(l2[0]);
    near(l1[1], 2830, 60); // 500 + 3500 × 2/3,落在两句之间
    expect(l2[1] - l2[0]).toBeGreaterThan(1000);
    expect(a.lastEnd).toBe(l2[1]);
    expect(a.guess([1, 1])).toEqual([[l2[1], l2[1]], [l2[1], l2[1]]]); // 没有新音频:不倒退
  });

  it("does not take in a following speaker who started shortly before the line was emitted", () => {
    const a = new LiveAudio(60);
    // 第一句 0.5–2.0 秒,停 0.6 秒,下一个人 2.6 秒开口,3.0 秒(字幕延迟)这一行才出
    feed(a, [0, 0, 0, 0, 0, ...Array(15).fill(1), 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    const [[s, e]] = a.guess();
    near(s, 500); near(e, 2000);
    // 下一个人一直说到 4.1 秒,4.6 秒出字:从他开口算起
    feed(a, [...Array(11).fill(1), 0, 0, 0, 0, 0]);
    const [[s2, e2]] = a.guess();
    near(s2, 2600); near(e2, 4100);
  });

  it("ends at the previous pause when the next speaker is still talking at emit time", () => {
    const a = new LiveAudio(60);
    // 第一句 0.2–1.2 秒,停 0.4 秒,下一个人 1.6 秒起一直在说,2.6 秒出字
    feed(a, [0, 0, ...Array(10).fill(1), 0, 0, 0, 0, ...Array(10).fill(1)]);
    const [[s, e]] = a.guess();
    near(s, 200); near(e, 1200);
  });

  it("stops at now - margin when there is no pause at all", () => {
    const a = new LiveAudio(60);
    feed(a, [...Array(10).fill(0), ...Array(30).fill(1)]); // 1.0 秒起一直有声,4.0 秒出字
    const [[s, e]] = a.guess();
    near(s, 1000); expect(e).toBe(4000 - GUESS_MARGIN);
    // 下一行接着从这里开始
    feed(a, [1, 1, 1, 1, 0, 0, 0, 0]);
    const [[s2, e2]] = a.guess();
    near(s2, 4000 - GUESS_MARGIN); near(e2, 4400);
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
