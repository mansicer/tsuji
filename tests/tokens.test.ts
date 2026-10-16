import { describe, expect, it } from "vitest";
import { estTokens, splitByTokens } from "../src/tokens";

describe("estTokens", () => {
  it("counts CJK at ~1.1 per char and other text at 3 chars per token", () => {
    expect(estTokens("你好世界")).toBe(Math.ceil(4 * 1.1));
    expect(estTokens("abcdef")).toBe(2);
    expect(estTokens("")).toBe(0);
  });
});

describe("splitByTokens", () => {
  it("keeps everything in one part when under budget", () => {
    expect(splitByTokens(["aaa", "bbb"], 100)).toEqual([["aaa", "bbb"]]);
  });

  it("starts a new part when the budget is exceeded", () => {
    // 每行 "aaa" 算 1 token + 1 换行 = 2;预算 4 → 每段 2 行
    expect(splitByTokens(["aaa", "aaa", "aaa", "aaa", "aaa"], 4)).toEqual([["aaa", "aaa"], ["aaa", "aaa"], ["aaa"]]);
  });

  it("gives an oversized row its own part instead of dropping it", () => {
    expect(splitByTokens(["aaa", "x".repeat(300), "aaa"], 10)).toEqual([["aaa"], ["x".repeat(300)], ["aaa"]]);
  });

  it("returns no parts for no rows", () => {
    expect(splitByTokens([], 10)).toEqual([]);
  });
});
