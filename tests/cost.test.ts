import { describe, expect, it } from "vitest";
import { asrCost, mtCost, ASR_PRICE_PER_MIN, MT_PRICE, WEB_SEARCH_PER_CALL } from "../src/cost";

describe("ASR cost", () => {
  it("charges per minute by model", () => {
    expect(asrCost(60, "gpt-transcribe")).toBeCloseTo(0.0045);
    expect(asrCost(120, "gpt-4o-transcribe")).toBeCloseTo(0.012);
    expect(asrCost(30, "gpt-live-transcribe")).toBeCloseTo(ASR_PRICE_PER_MIN["gpt-live-transcribe"] / 2);
  });
  it("falls back to 0.017/min for unknown models", () => {
    expect(asrCost(60, "nope")).toBeCloseTo(0.017);
  });
});

describe("MT cost", () => {
  it("prices Chat Completions usage with cached tokens", () => {
    const u = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } };
    expect(mtCost("gpt-6-sol", u)).toBeCloseTo((600 * 2 + 400 * 0.2 + 200 * 10) / 1e6);
  });
  it("prices Responses usage the same way and adds extra", () => {
    const u = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } };
    expect(mtCost("gpt-6.1-sol", u, 2 * WEB_SEARCH_PER_CALL)).toBeCloseTo((600 * 2 + 400 * 0.1 + 200 * 10) / 1e6 + 0.02);
    expect(mtCost("gpt-6-luna", { input_tokens: 1e6 })).toBeCloseTo(MT_PRICE["gpt-6-luna"][0]);
  });
  it("uses gpt-6-sol prices for unknown models", () => {
    const u = { prompt_tokens: 100, completion_tokens: 100 };
    expect(mtCost("mystery", u)).toBe(mtCost("gpt-6-sol", u));
  });
  it("skips missing usage and ChatGPT-subscription requests", () => {
    expect(mtCost("gpt-6-sol", undefined)).toBeNull();
    expect(mtCost("gpt-6-sol", null, 1)).toBeNull();
    expect(mtCost("gpt-6-sol", { billed_to: "chatgpt_subscription", prompt_tokens: 1000 })).toBeNull();
    expect(mtCost("gpt-6-sol", {})).toBe(0);
  });
});
