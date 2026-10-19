import { describe, expect, it } from "vitest";
import { sep, asrPrompt, keywords, glossaryForLLM, SYSTEM, SCHEMA, type PromptCfg } from "../src/prompts";
import { MEMO_SCHEMA } from "../src/memo";
import type { GlossEntry } from "../src/glossary";

const e = (src: string, tgt = ""): GlossEntry => ({ src, reading: "", tgt, notes: "" });
const mk = (tpl: PromptCfg["tpl"], people: GlossEntry[] = [], terms: GlossEntry[] = []): PromptCfg => ({ tpl, glossary: { people, terms } });

describe("separator", () => {
  it("uses 、 for CJK prompts/names or ja/zh sources", () => {
    expect(sep(mk({ name: "ラジオ", source: "en" }))).toBe("、");
    expect(sep(mk({ name: "Radio", asrPrompt: "日本語の番組", source: "en" }))).toBe("、");
    expect(sep(mk({ name: "Radio", source: "ja" }))).toBe("、");
    expect(sep(mk({ name: "Radio", source: "zh" }))).toBe("、");
  });
  it("uses a comma otherwise", () => {
    expect(sep(mk({ name: "Radio show", source: "en" }))).toBe(", ");
    expect(sep(mk({ source: "auto" }))).toBe(", ");
  });
});

describe("asrPrompt", () => {
  it("adds punctuation, speakers and terms in the template's language", () => {
    expect(asrPrompt(mk({ name: "Radio show", source: "en" }, [e("Ann"), e("Bob")], [e("foo"), e("bar")])))
      .toBe("Radio show. Speakers: Ann, Bob. Terms: foo, bar.");
    expect(asrPrompt(mk({ asrPrompt: "ラジオの音声", source: "ja" }, [e("羊宮")], [e("用語A")])))
      .toBe("ラジオの音声。出演:羊宮。用語:用語A。");
  });
  it("stops adding terms before the length cap", () => {
    const terms = Array.from({ length: 200 }, (_, i) => e("term" + i));
    const out = asrPrompt(mk({ name: "Show", source: "en" }, [], terms), 100);
    // 预留 6 个字符给「 Terms: 」和句号,所以 head + 词表不超过 maxChars - 6(英文标签实际 9 个字符,最终结果可能略超)
    const words = out.slice("Show. Terms: ".length, -1);
    expect("Show.".length + words.length + 6).toBeLessThanOrEqual(100);
    expect(out).toMatch(/^Show\. Terms: term0, term1, .*\.$/);
    expect(out.length).toBeLessThanOrEqual(100 + 3);
    const full = asrPrompt(mk({ name: "Show", source: "en" }, [], terms));
    expect(full.length).toBeGreaterThan(800);
    expect(full.length).toBeLessThanOrEqual(900 + 3);
  });
  it("is empty without template text or glossary", () => {
    expect(asrPrompt(mk({ source: "en" }))).toBe("");
  });
});

describe("keywords", () => {
  it("dedupes people and terms by source text and limits the count", () => {
    expect(keywords({ people: [e("A"), e("B")], terms: [e("B"), e("C"), e("A")] })).toEqual(["A", "B", "C"]);
    const terms = Array.from({ length: 400 }, (_, i) => e("t" + i));
    expect(keywords({ people: [], terms }).length).toBe(300);
    expect(keywords({ people: [], terms }, 5)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });
});

describe("system prompt", () => {
  it("includes the language names and the glossary", () => {
    const cfg = mk({ name: "Show", source: "ja", target: "en", description: "bg", style: "st" }, [{ src: "A", reading: "a", tgt: "Ay", notes: "" }], [e("T")]);
    expect(glossaryForLLM(cfg)).toBe("Background:\nbg\n\nTemplate-specific translation rules (follow these, they override the defaults above):\nst\n\n"
      + "Speakers (almost all speech comes from these people; when a name is misrecognized, prefer correcting to one of these):\n- A | reading: a | translation: Ay\n\nGlossary / proper nouns:\n- T");
    const s = SYSTEM(cfg, "Japanese", "English");
    expect(s).toContain("(ASR) of Japanese speech from: Show. The audience needs English subtitles.");
    expect(s.endsWith("\n\n" + glossaryForLLM(cfg))).toBe(true);
    expect(SYSTEM(mk({ source: "auto" }), "Auto", "English")).toContain("of speech (language may vary) from: a live event.");
  });
});

describe("SCHEMA", () => {
  it("requires items and memory", () => {
    expect(SCHEMA.required).toEqual(["items", "memory"]);
    expect(SCHEMA.additionalProperties).toBe(false);
    expect(SCHEMA.properties.items.items.required).toEqual(["id", "src", "tgt"]);
    expect(SCHEMA.properties.items.items.properties).toEqual({ id: { type: "integer" }, src: { type: "string" }, tgt: { type: "string" } });
    expect(SCHEMA.properties.memory).toBe(MEMO_SCHEMA);
  });
});
