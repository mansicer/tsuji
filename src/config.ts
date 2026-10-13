// 部署相关的配置,构建时由 .env.<mode> 决定(vite build --mode selfhost 用 .env.selfhost)
import hoooope from "./builtin/hoooope-2026.json";

/** 内置模板 */
export const BUILTIN = [hoooope];
/** 默认模型:识别 / 翻译 / 创建模板 */
export const ASR_MODEL = "gpt-live-transcribe", MT_MODEL = "gpt-6-luna", CT_MODEL = "gpt-6.1-sol";
/** server_vad 阈值默认值 */
export const VAD = 0.2;
/** 同站的 OpenAI 转发路径(服务器代填 key,自托管时在 .env.selfhost 里配);空 = 只能用户自己填 key */
export const SERVER_API: string = import.meta.env.VITE_SERVER_API || "";
/** CAM++ 声纹模型,构建前由 scripts/fetch-model.mjs 下载到 public/models/ */
export const SPK_MODEL = new URL("models/campplus.onnx", document.baseURI).href;
/** 构建时间(东京时间),设置页显示 */
export const BUILD: string = __BUILD__;
