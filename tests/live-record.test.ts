import { describe, expect, it, vi } from "vitest";
import { pickMime, recExt, recKey, recPrefix, recPartOf, fmtBytes, recDur, recCount, partBlobs } from "../src/live-record";
import type { RecInfo } from "../src/state";

// config.ts 加载时会读 location(i18n 用到 VAD)
vi.mock("../src/config", () => ({ VAD: 0.2 }));

const part = (t0: number, t1: number, bytes: number, mime = "audio/webm;codecs=opus") => ({ t0, t1, mime, bytes });

describe("pickMime", () => {
  it("prefers webm/opus, falls back to mp4 (Safari), then to the browser default", () => {
    expect(pickMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMime((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(pickMime(() => false)).toBe("");
    expect(pickMime(() => { throw new Error("x"); })).toBe("");
  });
});

describe("keys", () => {
  it("sort in recording order and carry the part number", () => {
    const ks = [recKey("s1", 0, 10), recKey("s1", 1, 0), recKey("s1", 0, 2)].sort();
    expect(ks).toEqual(["rec:s1:000:000002", "rec:s1:000:000010", "rec:s1:001:000000"]);
    expect(ks.every((k) => k.startsWith(recPrefix("s1")))).toBe(true);
    expect(recPartOf(recKey("sX", 12, 3))).toBe(12);
    expect(recPartOf("spk:s1")).toBe(-1);
    expect(recPartOf("rec:s1:abc")).toBe(-1);
  });
  it("prefix of one session does not match another whose id extends it", () => {
    expect(recKey("s10", 0, 0).startsWith(recPrefix("s1"))).toBe(false);
  });
});

describe("formatting", () => {
  it("fmtBytes", () => {
    expect(fmtBytes(0)).toBe("0 KB");
    expect(fmtBytes(100)).toBe("1 KB");
    expect(fmtBytes(40 * 1024)).toBe("40 KB");
    expect(fmtBytes(1.5 * 1048576)).toBe("1.5 MB");
    expect(fmtBytes(123 * 1048576)).toBe("123 MB");
  });
  it("recExt", () => {
    expect(recExt("audio/webm;codecs=opus")).toBe("webm");
    expect(recExt("audio/mp4")).toBe("m4a");
    expect(recExt("audio/ogg")).toBe("ogg");
    expect(recExt("")).toBe("webm");
  });
  it("recDur / recCount", () => {
    const rec: RecInfo = { on: true, bytes: 30, parts: [part(1000, 4000, 10), part(5000, 4000, 0), part(10000, 12500, 20)] };
    expect(recDur(rec)).toBe(5500);
    expect(recCount(rec)).toBe(2);
    expect(recCount(undefined)).toBe(0);
  });
});

describe("partBlobs", () => {
  it("joins chunks per part in key order, with the part's MIME type, skipping empty parts and foreign keys", async () => {
    const rec: RecInfo = { on: false, bytes: 0, parts: [part(0, 1, 3), part(2, 3, 0), part(4, 5, 2, "audio/mp4")] };
    const b = (s: string) => new Blob([s]);
    const out = partBlobs(rec, [
      [recKey("s", 0, 1), b("b")], [recKey("s", 2, 0), { buf: new TextEncoder().encode("xy").buffer, type: "audio/mp4" }],
      [recKey("s", 0, 0), b("a")], [recKey("s", 0, 2), b("c")], [recKey("s", 1, 0), b("")], ["rec:s:junk", b("z")],
    ]);
    expect(out.length).toBe(2);
    expect(await out[0].text()).toBe("abc");
    expect(out[0].type).toBe("audio/webm");
    expect(await out[1].text()).toBe("xy");
    expect(out[1].type).toBe("audio/mp4");
  });
});
