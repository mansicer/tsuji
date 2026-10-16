// 摘要用的 token 估算和按预算切分。估算偏保守:CJK 每字约 1.1 token,其余按 3 字符 1 token

export function estTokens(s: string): number {
  const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
  return Math.ceil(cjk * 1.1 + (s.length - cjk) / 3);
}

/** 按行累计(每行多算 1 个换行 token),超过 budget 就开新的一段;单行超预算也独占一段 */
export function splitByTokens(rows: string[], budget: number): string[][] {
  const out: string[][] = []; let cur: string[] = [], n = 0;
  for (const r of rows) { const k = estTokens(r) + 1; if (cur.length && n + k > budget) { out.push(cur); cur = []; n = 0; } cur.push(r); n += k; }
  if (cur.length) out.push(cur);
  return out;
}
