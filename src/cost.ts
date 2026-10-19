// 费用估算(官方单价,美元)。只做计算;累计、持久化和显示留在 main.ts
export const ASR_PRICE_PER_MIN: Record<string, number> = { "gpt-live-transcribe": 0.017, "gpt-realtime-whisper": 0.017, "gpt-transcribe": 0.0045, "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003 };
export const MT_PRICE: Record<string, [number, number, number]> = { "gpt-6-sol": [2.0, 0.2, 10.0], "gpt-6.1-sol": [2.0, 0.1, 10.0], "gpt-6-luna": [0.1, 0.01, 0.5] }; // 输入 / 缓存输入 / 输出
export const WEB_SEARCH_PER_CALL = 0.01;

/** Chat Completions 或 Responses 返回的 usage */
export interface Usage {
  billed_to?: string;
  prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number };
}

/** 识别费用:秒数按模型单价折算,未知模型按 0.017/分钟 */
export function asrCost(seconds: number, model: string): number {
  return (seconds / 60) * (ASR_PRICE_PER_MIN[model] || 0.017);
}
// 兼容 Chat Completions(prompt_tokens)和 Responses(input_tokens)两种 usage
/** 翻译费用;没有 usage 或转发到 ChatGPT 订阅时返回 null(不计费),未知模型按 gpt-6-sol 计 */
export function mtCost(model: string, u: Usage | null | undefined, extra = 0): number | null {
  if (!u || u.billed_to === "chatgpt_subscription") return null; // 服务器转发到 ChatGPT 订阅的请求不另计费
  const [pin, pcache, pout] = MT_PRICE[model] || MT_PRICE["gpt-6-sol"];
  const input = u.prompt_tokens ?? u.input_tokens ?? 0, output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = (u.prompt_tokens_details || u.input_tokens_details || {}).cached_tokens || 0;
  return ((input - cached) * pin + cached * pcache + output * pout) / 1e6 + extra;
}
