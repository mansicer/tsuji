import { describe, expect, it } from "vitest";
import { fmtClock, subtitleFile } from "../src/subtitle";

describe("fmtClock", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(65_000)).toBe("1:05");
    expect(fmtClock(3_600_000)).toBe("1:00:00");
    expect(fmtClock(-5)).toBe("0:00");
  });
});

describe("subtitleFile", () => {
  const lines = [
    { ms: 0, endMs: 2000, src: "原文", tgt: "译文" },
    { ms: 2500, endMs: 2600, src: "二", tgt: "" },     // 过短 cue 拉长到 800 ms;无译文时用原文
    { ms: null, src: "没有时间戳" },                    // 被过滤
  ];

  it("builds SRT with translation above source", () => {
    const srt = subtitleFile("srt", lines, true);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:02,000\n译文\n原文\n\n2\n00:00:02,500 --> 00:00:03,300\n二\n");
  });

  it("builds VTT with header and dot milliseconds", () => {
    const vtt = subtitleFile("vtt", lines, false);
    expect(vtt.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n译文\n")).toBe(true);
    expect(vtt).not.toContain("原文");
  });

  it("applies the speaker prefix", () => {
    const out = subtitleFile("srt", [{ ms: 0, endMs: 1000, tgt: "你好" }], false, () => "灯：");
    expect(out).toContain("灯：你好");
  });
});

describe("subtitleFile without endMs", () => {
  it("falls back to the 800 ms minimum instead of producing NaN", () => {
    expect(subtitleFile("srt", [{ ms: 1000, src: "a" }], false)).toBe("1\n00:00:01,000 --> 00:00:01,800\na\n");
  });
});
