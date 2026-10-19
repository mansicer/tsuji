import { afterEach, describe, expect, it, vi } from "vitest";
import { I18N, getUiLang, setUiLang, t, srcName, tgtName, CJK } from "../src/i18n";

// config.ts 加载时会读 location,测试里只需要 VAD
vi.mock("../src/config", () => ({ VAD: 0.2 }));

afterEach(() => setUiLang("zh"));

describe("t", () => {
  it("substitutes variables, blanking missing ones", () => {
    setUiLang("en");
    expect(t("set.ver", { v: "1.2" })).toBe("Version 1.2");
    expect(t("rec.memo", { n: 3 })).toBe("Translation memory · 3");
    expect(t("set.ver")).toBe("Version ");
    setUiLang("zh");
    expect(t("sess.meta", { tpl: "A", src: "日语", tgt: "中文" })).toBe("A · 日语 → 中文");
  });

  it("falls back to zh, then to the key itself", () => {
    I18N.zh["test.onlyZh"] = "仅中文 {x}";
    try {
      setUiLang("en");
      expect(t("test.onlyZh", { x: 1 })).toBe("仅中文 1");
      setUiLang("fr"); // 未知界面语言整体退回中文
      expect(t("app")).toBe(I18N.zh.app);
      expect(t("no.such.key")).toBe("no.such.key");
    } finally { delete I18N.zh["test.onlyZh"]; }
  });

  it("getUiLang reflects setUiLang", () => {
    setUiLang("en");
    expect(getUiLang()).toBe("en");
    expect(t("app")).toBe("Live Translate");
  });
});

describe("dictionaries", () => {
  it("every en key exists in zh", () => {
    expect(Object.keys(I18N.en).filter((k) => !(k in I18N.zh))).toEqual([]);
  });
  it("every zh key exists in en", () => {
    expect(Object.keys(I18N.zh).filter((k) => !(k in I18N.en))).toEqual([]);
  });
});

describe("language names", () => {
  it("srcName follows uiLang, takes an explicit language, falls back to auto", () => {
    setUiLang("en");
    expect(srcName("ja")).toBe("Japanese");
    expect(srcName("ja", "zh")).toBe("日语");
    expect(srcName("xx")).toBe("Auto-detect");
    expect(srcName("xx", "zh")).toBe("自动检测");
  });
  it("tgtName follows uiLang, takes an explicit language, falls back to Simplified Chinese", () => {
    setUiLang("zh");
    expect(tgtName("zh-Hant")).toBe("繁體中文");
    expect(tgtName("en", "en")).toBe("English");
    expect(tgtName("xx")).toBe("简体中文");
    expect(tgtName("xx", "en")).toBe("Simplified Chinese");
  });
});

describe("CJK", () => {
  it("matches kana, hanzi and hangul but not Latin", () => {
    expect(["あ", "カ", "漢", "한"].every((s) => CJK.test(s))).toBe(true);
    expect(CJK.test("abc")).toBe(false);
  });
});
