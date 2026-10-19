// 模板创建对话用的流式解析:Responses API 的 SSE 流、还没收完的 JSON
// 事件和最终的 response 对象都是 API 返回的原样 JSON
type Ev = any;
// 读 Responses API 的 SSE 流,返回最终的 response 对象(和非流式时 res.json() 一样)
export async function readResponseStream(res: Response, onEvent: (ev: Ev, text: string) => void): Promise<Ev> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let pending = "", text = "", final: Ev = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += dec.decode(value, { stream: true });
    let i;
    while ((i = pending.indexOf("\n\n")) >= 0) {
      const chunk = pending.slice(0, i); pending = pending.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let ev: Ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "response.output_text.delta") text += ev.delta || "";
      if (ev.type === "response.completed") final = ev.response;
      if (ev.type === "response.failed" || ev.type === "response.incomplete") throw new Error((ev.response && ev.response.error && ev.response.error.message) || ev.type);
      if (ev.type === "error") throw new Error(ev.message || (ev.error && ev.error.message) || "stream error");
      try { onEvent(ev, text); } catch (e) { console.error(e); }
    }
  }
  if (!final) throw new Error("stream ended early");
  return final;
}
// 从还没收完的 JSON 里取出某个字符串字段已到达的部分
export function partialJsonString(buf: string, key: string): string {
  const m = buf.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (!m) return "";
  let raw = m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  try { return JSON.parse('"' + raw + '"'); } catch { return ""; }
}
