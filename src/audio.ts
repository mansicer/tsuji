// 麦克风 → 24 kHz PCM16 的纯计算部分:重采样、分块、数字增益、信号格

export const CHUNK = 2400; // 100 ms @ 24 kHz

export function toBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength); // 可能是大数组的切片
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** 每次开麦克风建一个:线性重采样到 24 kHz,再切成 100 ms 的 PCM16 块,不满一块的留到下次 */
export class Resampler {
  carry = new Float32Array(0); resamplePos = 0; prevSample = 0;
  constructor(readonly inRate: number) {}
  // 线性重采样到 24 kHz(AudioContext 拿不到 24 kHz 时才用到)
  resample(input: Float32Array): Float32Array {
    let x = input;
    if (this.inRate !== 24000) {
      const ratio = this.inRate / 24000, out: number[] = [];
      // resamplePos 可能落在 [-1, 0):用上一块的最后一个样本插值(原先读 input[-1] 得到 NaN)
      while (this.resamplePos < input.length - 1) {
        const i = Math.floor(this.resamplePos), f = this.resamplePos - i;
        out.push((i < 0 ? this.prevSample : input[i]) * (1 - f) + input[i + 1] * f);
        this.resamplePos += ratio;
      }
      this.resamplePos -= input.length;
      this.prevSample = input[input.length - 1];
      x = Float32Array.from(out);
    }
    return x;
  }
  /** 接上次剩下的样本,切出所有完整的 CHUNK 块 */
  chunk(x: Float32Array): Int16Array[] {
    const merged = new Float32Array(this.carry.length + x.length);
    merged.set(this.carry); merged.set(x, this.carry.length);
    const chunks: Int16Array[] = [];
    let off = 0;
    while (merged.length - off >= CHUNK) {
      const pcm = new Int16Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) { const v = Math.max(-1, Math.min(1, merged[off + i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      off += CHUNK;
      chunks.push(pcm);
    }
    this.carry = merged.slice(off);
    return chunks;
  }
}

// 数字增益:离声源远、收音小声时放大。自动模式跟踪语音电平,放大到目标电平(最多 maxGain 倍)
export class Agc {
  agcLevel = 0.01; agcGain = 1;
  /** gain 是 "auto" 或固定倍数;设置可能在运行中改,所以每次都传当前值 */
  apply(x: Float32Array, gain: string | number, maxGain: number, agcTarget: number): Float32Array {
    if (!x.length) return x;
    let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length) + 1e-9;
    let want;
    if (gain === "auto") {
      // 有声时较快跟上,安静时慢慢回落,免得把底噪放大到满格
      this.agcLevel = rms > this.agcLevel * 0.5 ? this.agcLevel * 0.997 + rms * 0.003 : this.agcLevel * 0.9995 + rms * 0.0005;
      want = Math.min(maxGain, Math.max(1, agcTarget / this.agcLevel));
    } else want = Number(gain) || 1;
    this.agcGain = this.agcGain * 0.99 + want * 0.01;
    if (this.agcGain === 1) return x;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = Math.max(-1, Math.min(1, x[i] * this.agcGain));
    return y;
  }
}

// 信号格:放大后的音量分 5 格
export const SIG_STEPS = [0.03, 0.1, 0.22, 0.4, 0.7];
export function sigStep(v: number): number { return SIG_STEPS.filter((x) => v >= x).length; }
