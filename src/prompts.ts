// ---------- 提示词 ----------
// 识别提示、关键词、翻译系统提示和输出 schema。都是纯函数:模板和词汇表由调用方传入
import type { Glossary, GlossEntry } from "./glossary";
import { MEMO_SCHEMA } from "./memo";

/** 提示词用到的模板字段 */
export interface PromptTpl { name?: string; source?: string; target?: string; description?: string; style?: string; asrPrompt?: string }
/** 提示词用到的配置:当前模板和解析好的词汇表 */
export interface PromptCfg { tpl: PromptTpl; glossary: Glossary }

// 和 main.ts / i18n.ts 里的 CJK 相同,复制一份免得依赖界面语言模块
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

export function sep(cfg: PromptCfg): string { return CJK.test(cfg.tpl.asrPrompt || cfg.tpl.name || "") || ["ja", "zh"].includes(cfg.tpl.source || "") ? "、" : ", "; }
export function asrPrompt(cfg: PromptCfg, maxChars = 900): string {
  const { people, terms } = cfg.glossary, s = sep(cfg);
  let head = (cfg.tpl.asrPrompt || cfg.tpl.name || "").trim();
  if (head && !/[。.!?！？]$/.test(head)) head += s === "、" ? "。" : ".";
  if (people.length) head += (s === "、" ? "出演:" : " Speakers: ") + people.map((e) => e.src).join(s) + (s === "、" ? "。" : ".");
  let words = "";
  for (const x of terms) {
    const next = words ? words + s + x.src : x.src;
    if (head.length + next.length + 6 > maxChars) break;
    words = next;
  }
  return head + (words ? (s === "、" ? "用語:" : " Terms: ") + words + (s === "、" ? "。" : ".") : "");
}
export function keywords(glossary: Glossary, limit = 300): string[] { return [...new Set([...glossary.people, ...glossary.terms].map((e) => e.src))].slice(0, limit); }
export function glossaryForLLM(cfg: PromptCfg): string {
  const fmt = (e: GlossEntry) => "- " + [e.src, e.reading && "reading: " + e.reading, e.tgt && "translation: " + e.tgt, e.notes && "notes: " + e.notes].filter(Boolean).join(" | ");
  const { people, terms } = cfg.glossary;
  return [
    cfg.tpl.description && "Background:\n" + cfg.tpl.description,
    cfg.tpl.style && "Template-specific translation rules (follow these, they override the defaults above):\n" + cfg.tpl.style,
    people.length && "Speakers (almost all speech comes from these people; when a name is misrecognized, prefer correcting to one of these):\n" + people.map(fmt).join("\n"),
    terms.length && "Glossary / proper nouns:\n" + terms.map(fmt).join("\n"),
  ].filter(Boolean).join("\n\n");
}
/** srcLang / tgtLang:源语言和目标语言的英文名(main.ts 里 srcName(source, "en") / tgtName(target, "en")) */
export const SYSTEM = (cfg: PromptCfg, srcLang: string, tgtLang: string): string => {
  const src = cfg.tpl.source === "auto" ? "speech (language may vary)" : srcLang + " speech", tgt = tgtLang;
  return `You are a live subtitle translator. The input is real-time speech recognition (ASR) of ${src} from: ${cfg.tpl.name || "a live event"}. The audience needs ${tgt} subtitles.

How to work:
1. Fix the source text first: ASR often mishears names, titles and jargon as similar-sounding words and drops punctuation. If something sounds close to a glossary entry and the context fits, change it to the glossary spelling; if unsure, keep it. Never invent content. Laughter and filler can be trimmed. Put the corrected source text in "src".
2. Translate into ${tgt} in "tgt": natural spoken style, concise, readable at a glance as a subtitle; keep the speaker's tone (teasing, surprise, etc.). Use the glossary translations for names and terms strictly; names with no translation stay in the original.
3. One output item per input item, same id. Return empty "src" and "tgt" only when the input is pure noise, applause or music with no recognizable words. Far-field ASR is often fragmentary: if any meaning can be recovered, translate it, marking uncertain parts with "(?)".
4. If a segment is already in ${tgt}, still return it in "tgt" (cleaned up).
5. "Recent context" is only for understanding references and topics; do not translate it again.
6. "Running notes" are facts you recorded earlier for translating later lines. Use them. In "memory", you may add notes that will help translate later lines and are not already covered by the glossary or notes: who is present or speaking, the current segment/topic, nicknames and how people address each other, what an ambiguous word or name refers to here, recurring jokes, how you resolved a mishearing. One short sentence each, written in English. Add nothing for ordinary lines (usually "add" is empty). Put in "drop" the numbers of notes that became outdated or turned out wrong.

${glossaryForLLM(cfg)}`;
};
export const SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "src", "tgt"],
    properties: { id: { type: "integer" }, src: { type: "string" }, tgt: { type: "string" } } } }, memory: MEMO_SCHEMA },
};
SCHEMA.required.push("memory");
