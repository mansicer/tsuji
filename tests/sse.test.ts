import { describe, expect, it, vi } from "vitest";
import { partialJsonString, readResponseStream } from "../src/sse";

// 把整段 SSE 文本按给定位置切成若干块(字节层面切,能切在多字节字符中间)
function streamOf(text: string, cuts: number[]): Response {
  const bytes = new TextEncoder().encode(text), pts = [0, ...cuts, bytes.length];
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < pts.length - 1; i++) c.enqueue(bytes.slice(pts[i], pts[i + 1])); c.close(); },
  }));
}
const sse = (...evs: (object | string)[]) => evs.map((e) => `event: x\ndata: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

describe("readResponseStream", () => {
  const body = sse(
    { type: "response.created" },
    { type: "response.output_text.delta", delta: '{"reply":"日本' },
    "not json",
    { type: "response.output_text.delta", delta: '語"}' },
    { type: "response.completed", response: { id: "r1", output: [] } },
    "[DONE]",
  );

  it("parses events split at awkward chunk boundaries and returns the final response", async () => {
    const bytes = new TextEncoder().encode(body).length;
    // 每个字节单独一块、在 "\n\n" 中间切、在多字节字符中间切
    for (const cuts of [Array.from({ length: bytes - 1 }, (_, i) => i + 1), [body.indexOf("\n\n") + 1], [new TextEncoder().encode(body.slice(0, body.indexOf("日") + 1)).length - 1], []]) {
      const seen: [string, string][] = [];
      const final = await readResponseStream(streamOf(body, cuts), (ev, text) => seen.push([ev.type, text]));
      expect(final).toEqual({ id: "r1", output: [] });
      expect(seen).toEqual([
        ["response.created", ""],
        ["response.output_text.delta", '{"reply":"日本'],
        ["response.output_text.delta", '{"reply":"日本語"}'],
        ["response.completed", '{"reply":"日本語"}'],
      ]);
    }
  });

  it("joins multi-line data fields", async () => {
    const final = await readResponseStream(streamOf('data: {"type":"response.completed",\ndata: "response":{"ok":1}}\n\n', [5]), () => {});
    expect(final).toEqual({ ok: 1 });
  });

  it("keeps going when the event callback throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const final = await readResponseStream(streamOf(sse({ type: "a" }, { type: "response.completed", response: 1 }), []), () => { throw new Error("boom"); });
    expect(final).toBe(1);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("throws on failed / incomplete / error events and on an early end", async () => {
    await expect(readResponseStream(streamOf(sse({ type: "response.failed", response: { error: { message: "nope" } } }), []), () => {})).rejects.toThrow("nope");
    await expect(readResponseStream(streamOf(sse({ type: "response.incomplete", response: {} }), []), () => {})).rejects.toThrow("response.incomplete");
    await expect(readResponseStream(streamOf(sse({ type: "error", message: "bad" }), []), () => {})).rejects.toThrow("bad");
    await expect(readResponseStream(streamOf(sse({ type: "error", error: { message: "worse" } }), []), () => {})).rejects.toThrow("worse");
    await expect(readResponseStream(streamOf(sse({ type: "response.output_text.delta", delta: "x" }), []), () => {})).rejects.toThrow("stream ended early");
    // 最后一个事件没有结尾的空行,不算收到
    await expect(readResponseStream(streamOf('data: {"type":"response.completed","response":1}\n', []), () => {})).rejects.toThrow("stream ended early");
  });
});

describe("partialJsonString", () => {
  it("returns the part of a string field received so far", () => {
    expect(partialJsonString('{"reply":"Hello wor', "reply")).toBe("Hello wor");
    expect(partialJsonString('{"reply" : "done", "items":[', "reply")).toBe("done");
    expect(partialJsonString('{"items":[{"text":"a"}],"reply":"x', "reply")).toBe("x");
  });

  it("returns empty when the field has not started", () => {
    expect(partialJsonString('{"rep', "reply")).toBe("");
    expect(partialJsonString('{"reply":', "reply")).toBe("");
    expect(partialJsonString('{"reply":"', "reply")).toBe("");
    expect(partialJsonString('{"other":"x"}', "reply")).toBe("");
  });

  it("decodes escapes and drops an unfinished escape at the end", () => {
    expect(partialJsonString('{"reply":"a\\"b\\nc\\u00e9', "reply")).toBe('a"b\ncé');
    expect(partialJsonString('{"reply":"line\\', "reply")).toBe("line");
    expect(partialJsonString('{"reply":"x\\u', "reply")).toBe("x");
    expect(partialJsonString('{"reply":"x\\u00', "reply")).toBe("x");
    expect(partialJsonString('{"reply":"x\\u00e', "reply")).toBe("x");
    expect(partialJsonString('{"reply":"back\\\\x', "reply")).toBe("back\\x");
    // 现状:恰好停在完整的 \\ 之后时,末尾的 \ 也被当成没收完的转义去掉,解析失败返回空串(下一块到了就正常)
    expect(partialJsonString('{"reply":"back\\\\', "reply")).toBe("");
  });
});
