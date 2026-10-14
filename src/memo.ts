// 翻译记忆:翻译模型在每批输出里可选地增删「对后续翻译有用的信息」(谁在场、当前话题、昵称、
// 某个词这次指什么等),下一批翻译时作为上下文带上。按会话保存。

/** 最多保留的条数和每条长度;超出时丢掉最早的 */
export const MEMO_MAX = 30, MEMO_LEN = 160;

/** 翻译输出里的记忆字段:add 新增的笔记,drop 要删除的现有笔记编号(从 1 起,对应提示词里的 [n]) */
export interface MemoOps { add: string[]; drop: number[] }

export const MEMO_SCHEMA = {
  type: "object", additionalProperties: false, required: ["add", "drop"],
  properties: { add: { type: "array", items: { type: "string" } }, drop: { type: "array", items: { type: "integer" } } },
};

/** 先删再加;去掉空白和重复,截断过长的,超过上限丢最早的 */
export function applyMemo(notes: string[], ops: Partial<MemoOps> | null | undefined): string[] {
  if (!ops) return notes;
  const drop = new Set((ops.drop || []).map((n) => n - 1));
  const out = notes.filter((_, i) => !drop.has(i));
  for (const raw of ops.add || []) {
    const s = String(raw).replace(/\s+/g, " ").trim().slice(0, MEMO_LEN);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(-MEMO_MAX);
}

/** 提示词里的记忆段落 */
export function memoPrompt(notes: string[]): string {
  return notes.length ? notes.map((s, i) => `[${i + 1}] ${s}`).join("\n") : "(none yet)";
}
