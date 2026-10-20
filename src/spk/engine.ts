// 说话人识别的核心(不碰界面):加载 CAM++、算声纹(优先在 Worker 里)、对照声纹库、聚类。文件会话和现场收音共用
import { SPK_DIM, spkCluster, spkDot } from "./core";
import type { WorkerReq, WorkerOut } from "./engine.worker";
import type { Voice } from "../state";
import { SPK_MODEL } from "../config";
import { fetchProgress } from "../media";

export { SPK_DIM };
type Vec = ArrayLike<number>;
interface Backend { kind: "worker" | "main"; embed(x: Float32Array): Promise<Float32Array>; close(): void }
let backP: Promise<Backend> | null = null, noWorker = false;

// Worker 里跑模型;模型字节由主线程下载(进度条在主线程)后复制过去,失败时还能留给主线程用
async function workerBackend(buf: Uint8Array): Promise<Backend> {
  const w = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
  const pend = new Map<number, { res: (v: Float32Array) => void; rej: (e: Error) => void }>();
  let seq = 0, dead: Error | null = null;
  const fail = (e: Error) => { dead = e; for (const p of pend.values()) p.rej(e); pend.clear(); w.terminate(); };
  w.onmessage = (ev: MessageEvent<WorkerOut>) => { const m = ev.data, p = pend.get(m.id); if (!p) return; pend.delete(m.id); if (m.err != null) p.rej(new Error(m.err)); else p.res(m.vec || new Float32Array(0)); };
  w.onerror = (ev) => { ev.preventDefault(); fail(new Error(ev.message || "speaker worker failed")); };
  w.onmessageerror = () => fail(new Error("speaker worker message error"));
  const call = (m: WorkerReq) => new Promise<Float32Array>((res, rej) => {
    if (dead) return rej(dead);
    const id = ++seq; pend.set(id, { res, rej }); w.postMessage({ ...m, id });
  });
  try { await call({ op: "load", buf }); } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); throw e; }
  return {
    kind: "worker",
    embed: (pcm) => call({ op: "embed", pcm }).catch((e) => { if (dead) { noWorker = true; backP = null; } throw e; }), // Worker 挂了:下次改在主线程
    close: () => fail(new Error("closed")),
  };
}
async function mainBackend(buf: Uint8Array): Promise<Backend> {
  const { createModel, runEmbed } = await import("./infer");
  const model = await createModel(buf);
  return { kind: "main", embed: (x) => runEmbed(model, x), close: () => { model.release().catch(() => {}); } };
}

/** 加载声纹模型(28 MB,边下边报进度 0–1)。重复调用共用一次加载;失败后可重试 */
export function loadModel(onPct?: (p: number) => void): Promise<void> {
  return (backP ||= (async () => {
    const buf = await fetchProgress(SPK_MODEL, onPct, 28281138);
    if (!noWorker) {
      try { return await workerBackend(buf); } catch (e) { console.warn("speaker worker unavailable, using main thread", e); noWorker = true; }
    }
    return mainBackend(buf);
  })().catch((e) => { backP = null; throw e; })).then(() => {});
}
/** 16 kHz 单声道 → 归一化的 192 维声纹。没加载过模型会先加载 */
export async function embed(pcm16k: Float32Array): Promise<Float32Array> {
  await loadModel();
  return (await backP!).embed(pcm16k);
}
/** 当前在哪儿跑模型(没加载时为 null) */
export async function engineKind(): Promise<"worker" | "main" | null> { return backP ? (await backP).kind : null; }
/** 测试 / 测速用:卸掉模型;main = true 时下次加载强制在主线程 */
export async function resetEngine(main = false): Promise<void> {
  const b = backP; backP = null; noWorker = main;
  if (b) (await b.catch(() => null))?.close();
}

/** 平均连接层次聚类(余弦距离 dist 以内合并),返回每个输入的簇号 */
export function cluster(vecs: Vec[], dist: number): Int32Array { return spkCluster(vecs, dist); }

// ---------- 声纹库 ----------
export const f32b64 = (v: Vec): string => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(v).buffer)));
export const b64f32 = (s: string): Float32Array => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
/** 解码后的声纹库:每人一组声纹(v 在前,alts 在后) */
export interface LibEntry { name: string; vecs: Float32Array[] }
export function libEntries(voices: Record<string, Voice> | null | undefined): LibEntry[] {
  return Object.entries(voices || {}).map(([name, x]) => ({ name, vecs: [x.v, ...(x.alts || []).map((a) => a.v)].map(b64f32) }));
}
/** 一个人的分数:和他所有声纹里最像的那个的余弦 */
export function libScore(vec: Vec, e: LibEntry): number { let s = -2; for (const v of e.vecs) s = Math.max(s, spkDot(vec, v)); return s; }

// 对照规则(MyGO 四集跨集实测):余弦 ≥ 0.88、比第二像的人高 0.05 以上、且互为最像 —— 不同人的误认全部排除
export const LIB_MIN = 0.88, LIB_MARGIN = 0.05;
export interface MatchOpts {
  /** 最低余弦,默认 LIB_MIN */ min?: number;
  /** 比第二像的人至少高多少,默认 LIB_MARGIN */ margin?: number;
  /** 同时在对照的其他声纹(例如别的组的质心):其中有谁比 vec 更像这个人就不算(互为最像) */ others?: Vec[];
}
export interface Match { name: string; sim: number; second: number }
/** 声纹对照声纹库:三条规则都满足才返回名字,否则 null */
export function match(vec: Vec, library: LibEntry[] | Record<string, Voice>, o: MatchOpts = {}): Match | null {
  const lib = Array.isArray(library) ? library : libEntries(library);
  if (!lib.length) return null;
  const sc = lib.map((e, i) => [libScore(vec, e), i]).sort((a, b) => b[0] - a[0]);
  const [s1, i1] = sc[0], s2 = sc[1] ? sc[1][0] : -1, e = lib[i1];
  const mutual = (o.others || []).every((h) => libScore(h, e) < s1);
  return s1 >= (o.min ?? LIB_MIN) && s1 - s2 >= (o.margin ?? LIB_MARGIN) && mutual ? { name: e.name, sim: s1, second: s2 } : null;
}
/** 一组声纹各自对照声纹库,互为最像在这组之内判断 */
export function matchAll(vecs: Vec[], library: LibEntry[] | Record<string, Voice>, o: Omit<MatchOpts, "others"> = {}): (Match | null)[] {
  const lib = Array.isArray(library) ? library : libEntries(library);
  return vecs.map((v, k) => match(v, lib, { ...o, others: vecs.filter((_, j) => j !== k) }));
}
