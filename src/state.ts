// 跨功能共享的可变状态。
// 模块顶层的 let 搬到别的模块后,导入方就不能再给它赋值了;所以几个功能(会话、翻译、说话人识别、模板创建和 main.ts)
// 都要读写的变量集中放在 state 对象里,统一写成 state.xxx。只有一个功能用的 let 留在那个功能里。
// cfg 和 lines 只改内容、不重新赋值,几乎每个功能都用,也从这里导出。
import type { Glossary } from "./glossary";
import type { Basis } from "./spk/judge";
import type { NameSrc } from "./spk/live-schedule";
import { LineStore } from "./linestore";
import { noKV, storageFailed } from "./storage";

/** 声纹库里的一个人:v = base64(192 维 float32),d = 累计秒数;alts = 同一个人的其他声纹(例如现场收音),对照时取最像的一个 */
export interface Voice { v: string; d: number; alts?: VoiceAlt[] }
export interface VoiceAlt { v: string; d: number; src: "file" | "live" }

/** 模板(内置模板带 builtin / modified 标记) */
export interface Template {
  id: string; name: string; source: string; target: string;
  description: string; style: string; asrPrompt: string; spkNotes?: string; glossary: string;
  voices?: Record<string, Voice>;
  builtin?: boolean; modified?: boolean; updatedAt?: number;
}

/** 文件会话的原文件信息 */
export interface SessionFile { name: string; size: number; type: string; duration: number; stored?: boolean }

/** 会话:字幕存在 IndexedDB 的 lines:<id>;settings 只存和默认值不同的项 */
export interface Session {
  id: string; name: string; tplId: string; source: string; target: string;
  settings: Record<string, string>;
  createdAt: number; updatedAt: number; count: number;
  /** 文件会话才有 kind / file / progress / done;实时会话没有 kind */
  kind?: "file"; file?: SessionFile; progress?: number; done?: boolean;
  /** 实时会话的录音(见 live-record.ts);recSession = 由录音转成的文件会话 */
  rec?: RecInfo; recSession?: string;
  /** 文件会话:由哪个实时会话的录音转来 */
  fromLive?: string;
}

/** 录音的一段:每次开始收音(含重开麦克风)一段。t0 / t1 = 墙钟起止毫秒;at = 开始时的会话音频时钟(有 live-audio.ts 时才有) */
export interface RecPart { t0: number; t1: number; at?: number; mime: string; bytes: number }
/** 录音:on = 本会话开了录音(只对本会话);bytes = 总大小。块存 IndexedDB 的 rec:<会话 id>:<段号>:<块号> */
export interface RecInfo { on: boolean; bytes: number; parts: RecPart[] }

/** 页面上的一行字幕(存储格式见 linestore.ts 的 SavedLine 和 main.ts 的 saveLines) */
export interface Line {
  id: number; raw: string; src: string; tgt: string; t: Date; el: HTMLElement; done: boolean;
  failed?: boolean;
  /** 合并进来的最后一条的时间 */
  tEnd?: Date;
  /** 文件会话:在媒体里的起止毫秒 */
  ms?: number; endMs?: number;
  /** 实时会话:音频时钟上的起止毫秒(见 live-audio.ts)。不是 ms / endMs:那两个是文件的媒体时间,管跳转、叠加字幕和 SRT */
  aStart?: number; aEnd?: number;
  /** 说话人:spk 名字("" = 不确定),spc 颜色序号,spkBy GPT 判定依据,spkV 声纹候选 [组号, 占比],spkNear 最近片段的距离(秒) */
  spk?: string; spc?: number; spkBy?: Basis; spkV?: [number, number][]; spkNear?: number;
  /** 实时说话人(spk/live.ts):g = 组号(null = 不确定),name / src = 组名和来源,conf = 和组质心的余弦 */
  lspk?: LiveLabel;
}
export interface LiveLabel { g: number | null; name: string | null; src: NameSrc | null; conf: number }

/** 当前生效的设置(applySettings / refreshTemplate 填充;启动时先填好再用) */
export interface Cfg {
  tpl: Template; glossary: Glossary;
  apiKey: string; apiBase: string; useServer: boolean; hasKey: boolean;
  asrModel: string; mtModel: string; ctModel: string; mtEffort: string;
  gain: string; maxGain: number; agcTarget: number; vad: number; prefix: number; nr: string;
  micId: string; mic: { autoGainControl: boolean; noiseSuppression: boolean; echoCancellation: boolean };
  maxTurn: number; silence: number;
}

/** 说话人识别的结果(存 IndexedDB「spk:<会话 id>」;lab / sim / groups / tagged / timed 是重新分组、投票时算出来的) */
export interface SpkState {
  sid: string; segs: Float32Array; emb: Float32Array; n: number;
  cents: Float32Array | null; names: string[];
  llm?: { names: string[]; lines: [number, string, Basis][]; at: number } | null;
  lab?: Int16Array; sim?: Float32Array;
  groups?: { dur: number; n: number; sample: number }[];
  tagged?: number; timed?: number;
}

export type View = "home" | "tpl" | "live" | "create";

export const cfg = {} as Cfg;
export const lines: Line[] = [];

export const state = {
  /** 全部会话;启动时 main.ts 从 store 读入 */
  sessions: [] as Session[],
  curSess: null as Session | null,
  /** 没有会话时的会话级设置,作为新会话的初始值;启动时 main.ts 从 store 读入 */
  sessDefaults: {} as Record<string, string>,
  /** 实时收音中 */
  running: false,
  /** 下一行字幕的 id 从这里加一 */
  nextId: 0,
  /** 当前会话的翻译记忆(见 memo.ts) */
  memo: [] as string[],
  /** 有一批翻译请求在途 */
  translating: false,
  view: "home" as View,
  /** 文件会话的原文件 */
  mediaBlob: null as File | null,
  /** 实时转写的 WebSocket */
  ws: null as WebSocket | null,
  /** 字幕存储;启动时 loadLineStore 换成 IndexedDB 或 localStorage 的,之前先用不持久化的 */
  lineStore: new LineStore(noKV, storageFailed),
  /** 当前会话的说话人识别结果 */
  spk: null as SpkState | null,
  /** 试听一组的样本时,播放到这里(毫秒)自动暂停 */
  spkStopAt: null as number | null,
};
