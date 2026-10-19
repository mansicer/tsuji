// 端到端测试的公共部分:预置两个会话、假的 Realtime WebSocket、假的翻译接口,以及常用操作
import type { Page } from "@playwright/test";

export { test, expect } from "@playwright/test";

declare global {
  interface Window { __t: any; __ws: any; __wss: any[]; __reqs: string[]; __done: number; __delay: number }
}

/** 会话 A(当前,有一句旧版存在 localStorage 的字幕)和会话 B。只在第一次加载时写入,刷新后保留页面自己存的数据 */
function seed() {
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  const now = Date.now();
  const sess = (id: string, name: string, dt: number) => ({ id, name, tplId: "general", source: "ja", target: "zh-Hans", settings: { asrModel: "gpt-transcribe" }, createdAt: now - dt, updatedAt: now - dt, count: 0 });
  localStorage.setItem("jls.apiKey", "sk-test");
  localStorage.setItem("jls.sessMigrated", "1");
  localStorage.setItem("jls.sessions", JSON.stringify([sess("sA", "A", 0), sess("sB", "B", 1000)]));
  localStorage.setItem("jls.curSession", "sA");
  localStorage.setItem("jls.view", "live");
  localStorage.setItem("jls.slines.sA", JSON.stringify([{ id: 1, raw: "旧", src: "旧", tgt: "旧译", t: now - 60000, done: true }]));
}

/** 假 WebSocket(测试里用 emit 推识别结果);假 /chat/completions:延迟 __delay 毫秒,译文为 "T:" + 原文,并记一条翻译记忆 */
function fakes() {
  window.__wss = []; window.__reqs = []; window.__done = 0; window.__delay = 1500;
  class FakeWS {
    readyState = 0; sent: string[] = []; onopen: any; onmessage: any; onclose: any;
    constructor() { window.__ws = this; window.__wss.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 50); }
    send(m: string) { this.sent.push(m); }
    close() { this.readyState = 3; }
    emit(m: unknown) { this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
  }
  (window as any).WebSocket = FakeWS;
  const real = window.fetch;
  window.fetch = async (url, opt) => {
    if (!String(url).includes("/chat/completions")) return real(url, opt);
    const user = JSON.parse(String(opt!.body)).messages[1].content as string;
    window.__reqs.push(user);
    const segs = JSON.parse(user.slice(user.lastIndexOf("New ASR segments:\n") + 18));
    await new Promise((r) => setTimeout(r, window.__delay));
    const content = JSON.stringify({ items: segs.map((s: any) => ({ id: s.id, src: s.asr, tgt: "T:" + s.asr })), memory: { add: ["note from " + segs[0].asr], drop: [] } });
    window.__done++;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
}

/** 打开页面并等应用启动。before 在预置数据之前注入(用来禁用存储等) */
export async function openApp(page: Page, before?: () => void) {
  if (before) await page.addInitScript(before);
  await page.addInitScript(seed);
  await page.addInitScript(fakes);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await page.waitForFunction(() => window.__t, null, { timeout: 10_000 });
  return errors;
}

export async function reload(page: Page) {
  await page.reload();
  await page.waitForFunction(() => window.__t);
}

/** 开始收音并等假 WebSocket 连上 */
export async function start(page: Page) {
  await page.click("#go");
  await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1);
}

/** 识别出一句(Realtime 的 completed 事件) */
export const say = (page: Page, text: string) =>
  page.evaluate((x) => window.__ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: x, transcript: x }), text);

/** 等第 n 个翻译请求返回,再多等一会儿让防抖保存跑完 */
export async function translated(page: Page, n: number) {
  await page.waitForFunction((k) => window.__done >= k, n);
  await page.waitForTimeout(800);
}

/** 等翻译请求已经发出(结果还没回来) */
export const requested = (page: Page, n: number) => page.waitForFunction((k) => window.__reqs.length >= k, n);

export async function openSession(page: Page, name: string) {
  await page.click("#toHome");
  await page.click(`#sessList .card:has(h3:text-is('${name}')) .btn.primary`);
}

/** 删除会话(按钮点两次确认) */
export async function deleteSession(page: Page, name: string) {
  await page.click("#toHome");
  const b = `#sessList .card:has(h3:text-is('${name}')) .i-trash`;
  await page.click(b);
  await page.click(b);
}

export const lines = (page: Page) => page.evaluate(() => window.__t.lines.map((l: any) => [l.raw, l.tgt]));

/** IndexedDB 里 jls/files 的所有键 */
export const idbKeys = (page: Page) =>
  page.evaluate(() => new Promise<string[]>((r) => {
    const q = indexedDB.open("jls", 1);
    q.onsuccess = () => { const g = q.result.transaction("files").objectStore("files").getAllKeys(); g.onsuccess = () => r(g.result as string[]); };
  }));

export const lastRequest = (page: Page) => page.evaluate(() => window.__reqs[window.__reqs.length - 1]);
