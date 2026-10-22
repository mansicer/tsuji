// CAM++ 推理本身(onnxruntime-web):engine.worker.ts 在 Worker 里用,Worker 不可用时 engine.ts 在主线程按需加载
import * as ort from "onnxruntime-web/wasm";
import { spkFbank, spkNorm } from "./core";

export type Model = ort.InferenceSession;
// wasm 文件由 Vite 按 onnxruntime-web 里的 new URL(..., import.meta.url) 同源打包,主线程和 Worker 都不用设 wasmPaths
export function createModel(buf: Uint8Array): Promise<Model> {
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
}
/** 16 kHz float32 → 归一化的 192 维声纹 */
export async function runEmbed(model: Model, x: Float32Array): Promise<Float32Array> {
  const { data, T } = spkFbank(x);
  const r = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", data, [1, T, 80]) });
  return spkNorm(r[model.outputNames[0]].data as Float32Array);
}
