import { describe, expect, it } from "vitest";
import { applyMemo, memoPrompt, MEMO_MAX, MEMO_LEN } from "../src/memo";

describe("translation memory", () => {
  it("drops by 1-based number before adding, skipping blanks and duplicates", () => {
    const out = applyMemo(["a", "b", "c"], { drop: [2], add: [" d  e ", "", "a"] });
    expect(out).toEqual(["a", "c", "d e"]);
  });
  it("ignores missing ops and out-of-range numbers", () => {
    expect(applyMemo(["a"], null)).toEqual(["a"]);
    expect(applyMemo(["a"], { drop: [0, 5] })).toEqual(["a"]);
  });
  it("caps length and count, keeping the newest", () => {
    const many = Array.from({ length: MEMO_MAX + 5 }, (_, i) => "n" + i);
    const out = applyMemo([], { add: many });
    expect(out.length).toBe(MEMO_MAX);
    expect(out[0]).toBe("n5");
    expect(applyMemo([], { add: ["x".repeat(MEMO_LEN + 50)] })[0].length).toBe(MEMO_LEN);
  });
  it("numbers notes in the prompt", () => {
    expect(memoPrompt([])).toBe("(none yet)");
    expect(memoPrompt(["a", "b"])).toBe("[1] a\n[2] b");
  });
});
