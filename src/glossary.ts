// 词汇表:模板里一行一条的文本格式与结构化条目的互转
// 行格式:原文 | 读音 | 译文 | 备注(人物以 @ 开头,# 开头是注释,空行忽略)

export interface GlossEntry { src: string; reading: string; tgt: string; notes: string }
export interface Glossary { people: GlossEntry[]; terms: GlossEntry[] }

/** 模板创建器(GPT 结构化输出)用的字段名不同,导出时两种都认 */
export interface GlossLike { src?: string; text?: string; reading?: string; tgt?: string; translation?: string; notes?: string }

export function parseGlossary(text: string | null | undefined): Glossary {
  const people: GlossEntry[] = [], terms: GlossEntry[] = [];
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const person = line.startsWith("@");
    const [src, reading = "", tgt = "", notes = ""] = line.replace(/^@/, "").split("|").map((s) => s.trim());
    if (src) (person ? people : terms).push({ src, reading, tgt, notes });
  }
  return { people, terms };
}

export function glossaryText(people: GlossLike[], terms: GlossLike[]): string {
  const row = (e: GlossLike, at: boolean) => (at ? "@" : "") + [e.src || e.text || "", e.reading || "", e.tgt || e.translation || "", e.notes || ""].join(" | ").replace(/( \| )+$/, "");
  return [...people.map((e) => row(e, true)), ...(people.length && terms.length ? [""] : []), ...terms.map((e) => row(e, false))].join("\n");
}
