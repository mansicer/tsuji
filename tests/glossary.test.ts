import { describe, expect, it } from "vitest";
import { parseGlossary, glossaryText } from "../src/glossary";

describe("parseGlossary", () => {
  it("separates people (@) from terms and splits fields", () => {
    const g = parseGlossary("@千早愛音 | ちはやあのん | 千早爱音 | 吉他\nCRYCHIC | | | 乐队名");
    expect(g.people).toEqual([{ src: "千早愛音", reading: "ちはやあのん", tgt: "千早爱音", notes: "吉他" }]);
    expect(g.terms).toEqual([{ src: "CRYCHIC", reading: "", tgt: "", notes: "乐队名" }]);
  });

  it("skips comments, blank lines, and rows without a source", () => {
    const g = parseGlossary("# 注释\n\n@ | 只有读音\nA | b");
    expect(g.people).toEqual([]);
    expect(g.terms).toEqual([{ src: "A", reading: "b", tgt: "", notes: "" }]);
  });

  it("handles null/empty input", () => {
    expect(parseGlossary(null)).toEqual({ people: [], terms: [] });
    expect(parseGlossary("")).toEqual({ people: [], terms: [] });
  });
});

describe("glossaryText", () => {
  it("round-trips through parseGlossary", () => {
    const text = "@千早愛音 | ちはやあのん | 千早爱音 | 吉他\n\nCRYCHIC | | | 乐队名\n春日影";
    const g = parseGlossary(text);
    expect(parseGlossary(glossaryText(g.people, g.terms))).toEqual(g);
  });

  it("trims trailing empty fields and inserts a blank line between groups", () => {
    const out = glossaryText([{ src: "A", reading: "a" }], [{ src: "B" }]);
    expect(out).toBe("@A | a\n\nB");
  });

  it("accepts creator-schema field names (text / translation)", () => {
    expect(glossaryText([], [{ text: "X", translation: "Y" }])).toBe("X |  | Y");
  });
});
