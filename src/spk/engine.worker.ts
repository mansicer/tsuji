// 在 Worker 里跑 CAM++,不卡主线程。消息:{ id, op: "load", buf } → { id };{ id, op: "embed", pcm } → { id, vec };出错 → { id, err }
import { createModel, runEmbed } from "./infer";
import type { Model } from "./infer";

export type WorkerReq = { op: "load"; buf: Uint8Array } | { op: "embed"; pcm: Float32Array };
export type WorkerIn = WorkerReq & { id: number };
export type WorkerOut = { id: number; vec?: Float32Array; err?: string };
let model: Model | null = null;
const post = (m: WorkerOut, tr: Transferable[] = []) => (self as unknown as Worker).postMessage(m, tr);
self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  try {
    if (m.op === "load") { model ||= await createModel(m.buf); post({ id: m.id }); }
    else { if (!model) throw new Error("model not loaded"); const vec = await runEmbed(model, m.pcm); post({ id: m.id, vec }, [vec.buffer]); }
  } catch (e) { post({ id: m.id, err: e instanceof Error ? e.message : String(e) }); }
};
