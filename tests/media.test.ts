import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProgress, splitTimed } from "../src/media";

const texts = (r: { text: string }[]) => r.map((x) => x.text);

describe("splitTimed", () => {
  it("splits Japanese / Chinese on 。！？ and keeps closing brackets with the sentence", () => {
    expect(texts(splitTimed("こんにちは。「元気？」はい！！そうです", 0, 1000, true))).toEqual(["こんにちは。", "「元気？」", "はい！！", "そうです"]);
    // 句末标点后面紧跟的是开括号,不算进上一句
    expect(texts(splitTimed("元気？「はい」", 0, 1000, true))).toEqual(["元気？", "「はい」"]);
    expect(texts(splitTimed("你好！今天天气很好。（真的。）还有", 0, 1000, true))).toEqual(["你好！", "今天天气很好。", "（真的。）", "还有"]);
    expect(texts(splitTimed("一句话没有标点", 0, 1000, true))).toEqual(["一句话没有标点"]);
  });

  it("splits English on .!? followed by space or end, keeping closing quotes/brackets", () => {
    expect(texts(splitTimed("Hello there. How are you? I'm fine!", 0, 1000, false))).toEqual(["Hello there.", "How are you?", "I'm fine!"]);
    expect(texts(splitTimed('He said "go." Then (he left.) ok', 0, 1000, false))).toEqual(['He said "go."', "Then (he left.)", "ok"]);
    expect(texts(splitTimed("Wait... what?! No", 0, 1000, false))).toEqual(["Wait...", "what?!", "No"]);
  });

  it("keeps a period inside a word or number with its sentence instead of dropping the text before it", () => {
    expect(texts(splitTimed("It costs 3.5 dollars. Fine", 0, 1000, false))).toEqual(["It costs 3.5 dollars.", "Fine"]);
    expect(texts(splitTimed("We meet at 10.30 today. See you", 0, 1000, false))).toEqual(["We meet at 10.30 today.", "See you"]);
    expect(texts(splitTimed("Visit example.com now. OK", 0, 1000, false))).toEqual(["Visit example.com now.", "OK"]);
    // 缩写后面跟空格时仍会断开(没法和句末区分),但不会丢字
    expect(texts(splitTimed("U.S. sales grew 2.5%. Great", 0, 1000, false))).toEqual(["U.S.", "sales grew 2.5%.", "Great"]);
    expect(texts(splitTimed("pi is 3.14", 0, 1000, false))).toEqual(["pi is 3.14"]);
  });

  it("drops punctuation-only parts but still counts their length for timing", () => {
    const r = splitTimed("はい。……。いいえ。", 0, 900, true);
    expect(texts(r)).toEqual(["はい。", "いいえ。"]);
    // 三段长度 3 / 3 / 4,共 10;中间那段的时间不分给别的句子
    expect(r[0]).toMatchObject({ s: 0, e: 270 });
    expect(r[1].s).toBeCloseTo(540); expect(r[1].e).toBeCloseTo(900);
    expect(splitTimed("。。。", 0, 1000, true)).toEqual([]);
    expect(splitTimed("... !", 0, 1000, false)).toEqual([]);
  });

  it("gives each sentence time proportional to its length, covering [s, e]", () => {
    const r = splitTimed("ab. cdef. ghijkl", 1000, 2200, false);
    expect(texts(r)).toEqual(["ab.", "cdef.", "ghijkl"]);
    const lens = r.map((x) => x.text.length), total = lens.reduce((a, b) => a + b, 0);
    r.forEach((x, i) => expect(x.e - x.s).toBeCloseTo(1200 * lens[i] / total));
    expect(r[0].s).toBe(1000);
    expect(r[r.length - 1].e).toBeCloseTo(2200);
    for (let i = 1; i < r.length; i++) expect(r[i].s).toBeCloseTo(r[i - 1].e);
  });

  it("trims whitespace around parts", () => {
    expect(splitTimed("  Hi.   Bye.  ", 0, 700, false)).toEqual([{ text: "Hi.", s: 0, e: 300 }, { text: "Bye.", s: 300, e: 700 }]);
  });
});

describe("fetchProgress", () => {
  afterEach(() => vi.unstubAllGlobals());

  const mockFetch = (chunks: number[][], init: ResponseInit & { length?: boolean } = {}) => {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { for (const x of chunks) c.enqueue(new Uint8Array(x)); c.close(); },
    }), { status: init.status ?? 200, headers: init.length === false ? {} : { "content-length": String(total) } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reports progress per chunk and returns the concatenated bytes", async () => {
    const f = mockFetch([[1, 2], [3], [4, 5, 6, 7]]);
    const pct: number[] = [];
    const buf = await fetchProgress("https://x/model.onnx", (p) => pct.push(p), 999);
    expect(f).toHaveBeenCalledWith("https://x/model.onnx");
    expect([...buf]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pct).toEqual([2 / 7, 3 / 7, 1]);
  });

  it("uses the size guess without content-length and caps progress at 1", async () => {
    mockFetch([[1, 2, 3], [4, 5, 6]], { length: false });
    const pct: number[] = [];
    const buf = await fetchProgress("https://x/a.wasm", (p) => pct.push(p), 4);
    expect(buf.length).toBe(6);
    expect(pct).toEqual([0.75, 1]);
  });

  it("works without a progress callback", async () => {
    mockFetch([[9]]);
    expect([...await fetchProgress("https://x/a", null, 1)]).toEqual([9]);
  });

  it("throws with the file name and status on a non-OK response", async () => {
    mockFetch([], { status: 404 });
    await expect(fetchProgress("https://x/dir/core.wasm", () => {}, 1)).rejects.toThrow("core.wasm 404");
  });
});
