// 实时说话人识别(真的 CAM++):flite 合成三人对话当麦克风,假 WebSocket 按脚本时间发 VAD 事件和识别结果,
// 用 live-eval.ts 对照脚本算准确率 / 覆盖率;再手动起名、刷新后还在、存进模板声纹库,
// 第二个会话(同样三个声音、不同的话)直接由声纹库认出名字,不调用 GPT
import type { Browser, Page } from "@playwright/test";
import { test, expect, openApp, idbKeys, deleteSession } from "./fixtures";
import { ttsConversation, readWav } from "./tts";
import type { Turn, Spoken } from "./tts";
import { evaluate, formatReport } from "../src/spk/live-eval";
import type { EvalLine, RefSeg } from "../src/spk/live-eval";

const CONV1: Turn[] = [
  { voice: "kal", text: "Good morning everyone and welcome to the weekly planning meeting.", gapMs: 1500 },
  { voice: "slt", text: "Thanks for having me today I brought the updated sales figures." },
  { voice: "awb", text: "Before we start I want to talk about the delayed shipment." },
  { voice: "kal", text: "Sure let us begin with the shipment and then look at sales." },
  { voice: "awb", text: "The trucks were stuck at the border for almost three days." },
  { voice: "slt", text: "That explains why the numbers dropped in the second week." },
  { voice: "kal", text: "Do we have a plan to avoid the same problem next month." },
  { voice: "awb", text: "We are going to book a second carrier as a backup option." },
  { voice: "slt", text: "Sales in the north region still grew by eight percent overall." },
  { voice: "kal", text: "That is good news and we should share it with the whole team." },
  { voice: "slt", text: "I will prepare a short summary and send it out this afternoon." },
  { voice: "awb", text: "Please include the shipping delay so nobody is surprised later." },
  { voice: "kal", text: "Agreed, and let us also mention the new warehouse in the report." },
  { voice: "awb", text: "The warehouse opens on the fifth and the staff are already trained." },
  { voice: "slt", text: "Marketing wants to announce it together with the spring campaign." },
  { voice: "kal", text: "Then we need the final budget numbers before the end of the month." },
  { voice: "slt", text: "Finance promised them by Thursday so that should not be a problem." },
  { voice: "awb", text: "I will follow up with them tomorrow morning just to be sure." },
  { voice: "kal", text: "Thank you all, that was a productive meeting, see you next week." },
];
const CONV2: Turn[] = [
  { voice: "slt", text: "Hello again it is nice to see everyone back after the holiday." },
  { voice: "awb", text: "The new carrier delivered every order on time this week." },
  { voice: "kal", text: "Excellent that was exactly the result we were hoping for." },
  { voice: "slt", text: "Customers in the south also started ordering larger amounts." },
  { voice: "kal", text: "Should we hire another person for the support desk then." },
  { voice: "awb", text: "I think one more person would really help during busy hours." },
  { voice: "slt", text: "I can write the job description by the end of the week." },
  { voice: "kal", text: "Great then we will review the candidates next Tuesday." },
  { voice: "awb", text: "I will also check the budget for the extra salary costs." },
];
const NAMES: Record<string, string> = { kal: "Kal", awb: "Awb", slt: "Slt" };

// 一个 WAV 里先是第二段对话、再是第一段(第二个会话从文件开头放,不用等);假麦克风循环播放
const conv = ttsConversation([...CONV2, ...CONV1]);
const TL2 = conv.timeline.slice(0, CONV2.length), TL1 = conv.timeline.slice(CONV2.length), LOOP = conv.durationMs;
test.use({ launchOptions: {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${conv.path}`],
} });

// ---------- 音频对齐 ----------
const FR = 20; // 帧长 ms
/** WAV 的有声 / 静音包络(20 ms 一帧) */
const wavEnv = (() => {
  const { pcm, rate } = readWav(conv.path), F = (rate * FR) / 1000, n = Math.floor(pcm.length / F), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * F; j < (i + 1) * F; j++) s += (pcm[j] / 32768) ** 2; out[i] = Math.sqrt(s / F) > 0.01 ? 1 : 0; }
  return out;
})();
const waitNow = (page: Page, at: number, timeout = 200_000) => page.waitForFunction((x) => window.__t.liveAudio.now() > x, at, { timeout, polling: 100 });
/**
 * 假麦克风放到 WAV 的哪里了:取缓冲里最近(最多)12 秒的有声包络,和 WAV 的包络做循环相关,
 * 返回「WAV 开头」对应的音频时钟(mod LOOP)。开头几秒的包络可能对上好几处:差不多好的里面取最接近 prior 的
 * (Chromium 打开麦克风时从文件开头放,时钟 0 ≈ WAV 0)。near:只在 prior 前后这么多毫秒里找(跟踪漂移用)
 * 实测假麦克风和采样时钟之间有约 0.1–0.4% 的漂移(一百秒差几百毫秒),所以每句推之前都重新对一次
 */
async function phase(page: Page, at: number, prior: number | null, near = Infinity, quiet = false): Promise<number> {
  await waitNow(page, at);
  const { from, env } = await page.evaluate((fr) => {
    const A = window.__t.liveAudio, to = A.now(), from = Math.max(A.oldest(), to - 12_000), x = A.slice(from, to) as Float32Array, F = 16 * fr, env: number[] = [];
    for (let i = 0; i + F <= x.length; i += F) { let s = 0; for (let j = i; j < i + F; j++) s += x[j] * x[j]; env.push(Math.sqrt(s / F) > 0.01 ? 1 : 0); }
    return { from, env };
  }, FR);
  const n = wavEnv.length, sc: number[] = [];
  for (let L = 0; L < n; L++) { let s = 0; for (let j = 0; j < env.length; j++) if (env[j] === wavEnv[(L + j) % n]) s++; sc.push(s); }
  const ph = (L: number) => (((from - L * FR) % LOOP) + LOOP) % LOOP, dist = (p: number) => Math.min(p, LOOP - p);
  const ok = (L: number) => prior == null || dist(ph(L) - prior) <= near;
  const best = Math.max(...sc.filter((_, L) => ok(L)));
  const cand = sc.map((s, L) => [s, L]).filter(([s, L]) => s >= best - 2 && ok(L)).map(([, L]) => ph(L)).sort((a, b) => (prior == null ? 0 : dist(a - prior) - dist(b - prior)));
  if (!quiet) console.log(`phase ${cand[0].toFixed(0)} ms: match ${(best / env.length * 100).toFixed(1)}% of ${env.length} frames, ${cand.length} candidates`);
  expect(best / env.length).toBeGreaterThan(0.9);
  if (prior == null) return cand[0];
  const d = (((cand[0] - prior) % LOOP) + LOOP * 1.5) % LOOP - LOOP / 2; // 不跨圈:取离 prior 最近的那个等价值
  return prior + d;
}
const now = (page: Page) => page.evaluate(() => window.__t.liveAudio.now() as number);
/** 按脚本在音频真正放到时推识别结果(VAD 事件带 audio_*_ms),返回参考标注(音频时钟) */
async function play(page: Page, tl: Spoken[], ph: number, tag: string): Promise<RefSeg[]> {
  const ph0 = ph;
  const connAt: number = await page.evaluate(() => window.__t.liveAudio.connAt);
  let after = Math.max(connAt + 100, await page.evaluate(() => window.__t.liveAudio.now() as number));
  const ref: RefSeg[] = [];
  for (const s of tl) {
    const k = Math.ceil((after - (ph + s.startMs)) / LOOP);
    await waitNow(page, ph + s.endMs + k * LOOP + 300);
    if (await now(page) > 12_500) ph = await phase(page, await now(page), ph, 600, true); // 跟踪漂移
    const st = ph + s.startMs + k * LOOP, en = st + s.endMs - s.startMs;
    await page.evaluate(([id, text, a, b]) => {
      const w = window.__ws;
      w.emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: a });
      w.emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: b });
      w.emit({ type: "input_audio_buffer.committed", item_id: id });
      w.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
    }, [`${tag}${s.i}`, s.text, st - connAt, en - connAt] as const);
    ref.push({ start: Math.round(st), end: Math.round(en), speaker: NAMES[s.voice] });
    after = en;
  }
  console.log(`phase drift over the run: ${(ph - ph0).toFixed(0)} ms`);
  return ref;
}
/** 这些句子的标签(名字或字母)和历史 */
const evalLines = (page: Page, texts: string[]) => page.evaluate((tx) => window.__t.lines.filter((l: any) => tx.includes(l.raw)).map((l: any) => ({
  aStart: l.aStart, aEnd: l.aEnd, label: l.lspk && l.lspk.g != null ? l.lspk.name || String.fromCharCode(65 + l.lspk.g) : null,
  history: window.__t.lspk.hist.get(l.id) || [], text: l.raw,
})), texts) as Promise<(EvalLine & { text: string })[]>;
const drained = (page: Page) => page.waitForFunction(() => window.__t.lspk.queue === 0 && !window.__t.lspk.busy, null, { timeout: 60_000 });
const groups = (page: Page) => page.evaluate(() => window.__t.lspk.core.visible().map((g: any) => ({ id: g.id, name: g.name, src: g.src, dur: Math.round(g.dur), n: g.n })));
const chipOf = (page: Page, text: string) => page.locator("#log .row", { has: page.locator(".src", { hasText: text }) }).locator(".lwho");

let page: Page, errors: string[], ref1: RefSeg[] = [];
/** 第一段对话里每个声音最后落在哪个组(组号) */
const voiceGroup: Record<string, number> = {};

test.describe.serial("live speaker identification", () => {
  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    errors = await openApp(page, () => localStorage.setItem("jls.spkConsent", "1"));
  });
  test.afterAll(async () => { await page.close(); });

  test("three flite voices are grouped live, one group per speaker", async () => {
    test.setTimeout(300_000);
    // 实时会话的设置里也有说话人开关;同意过就直接开
    await page.click("#openSettings");
    await expect(page.locator("#secSpk")).toBeVisible();
    await expect(page.locator("#lspkHint")).toBeVisible();
    await page.check("#spkOn");
    await page.click("#closeSettings");
    await expect(page.locator("body")).not.toHaveClass(/nospk/);
    await page.click("#go");
    await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1);
    await page.waitForFunction(() => window.__t.lspk.ready, null, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__t.liveSpk() !== null)).toBe(true);
    const ph = await phase(page, 3000, 0);
    ref1 = await play(page, TL1, ph, "a");
    await drained(page);
    const L = await evalLines(page, CONV1.map((x) => x.text));
    expect(L).toHaveLength(CONV1.length);
    const r = evaluate(L, ref1);
    console.log("live run 1 (all lines):\n" + formatReport(r));
    const t0 = ref1[0].start, late = L.filter((l) => l.aStart - t0 >= 20_000), rl = evaluate(late, ref1);
    console.log(`after the first 20 s: ${late.length} lines, coverage ${(rl.coverage! * 100).toFixed(1)}%, accuracy ${(rl.accuracy! * 100).toFixed(1)}%`);
    const perf = await page.evaluate(() => ({ ...window.__t.lspk.perf }));
    console.log(`embed backlog: ${perf.n} lines embedded while listening, aEnd → label lag max ${(perf.lagMax / 1000).toFixed(2)} s, mean ${(perf.lagSum / perf.n / 1000).toFixed(2)} s; queue max ${perf.qMax}; dropped ${perf.dropped}, skipped ${perf.skipped}; embed time ${(perf.embedMs / perf.n).toFixed(0)} ms/line`);
    expect(r.accuracy!).toBeGreaterThanOrEqual(0.9);
    expect(rl.coverage!).toBeGreaterThanOrEqual(0.7);
    // 每个人最后都只在一个组里,三个人三个组
    for (const s of r.speakers) expect(Object.keys(s.as)).toHaveLength(1);
    const gs = await groups(page);
    console.log("groups:", JSON.stringify(gs));
    expect(gs).toHaveLength(3);
    for (const s of TL1) {
      const g = await page.evaluate((t) => window.__t.lines.find((l: any) => l.raw === t)?.lspk?.g ?? null, s.text);
      if (g != null) voiceGroup[s.voice] = g;
    }
    expect(new Set(Object.values(voiceGroup)).size).toBe(3);
    // 接口(给 live-judge.ts)
    const api = await page.evaluate(() => { const a = window.__t.liveSpk(); return { groups: a.groups().map((g: any) => g.letter), lines: a.linesSince(0).length, unc: a.uncertain(), ev: a.events().map((e: any) => e.kind) }; });
    expect(api.groups).toEqual(["A", "B", "C"]);
    expect(api.lines).toBe(CONV1.length);
    expect(api.ev.filter((k: string) => k === "new-group")).toHaveLength(3);
    // 标签就在字幕行上
    await expect(chipOf(page, CONV1[0].text)).toHaveText(String.fromCharCode(65 + voiceGroup.kal));
    await page.click("#go"); // 停止
    await expect(page.locator("#go")).not.toHaveClass(/stop/);
  });

  test("naming a group by tapping its tag, and the names survive a reload", async () => {
    for (const v of ["kal", "slt", "awb"]) {
      const text = TL1.find((s) => s.voice === v)!.text;
      await chipOf(page, text).click();
      await expect(page.locator("#lspkPick")).toBeVisible();
      await page.click("#lspkPick .names .btn:last-child"); // 「其他…」
      await page.fill("#lspkPick input", NAMES[v]);
      await page.press("#lspkPick input", "Enter");
      await expect(page.locator("#lspkPick")).toHaveCount(0);
      await expect(chipOf(page, text)).toHaveText(NAMES[v]);
    }
    const check = async () => {
      const L = await evalLines(page, CONV1.map((x) => x.text));
      const r = evaluate(L, ref1);
      expect(r.mapping.every((m) => m.pinned)).toBe(true); // 名字和脚本的说话人一致
      expect(r.accuracy!).toBeGreaterThanOrEqual(0.9);
      expect((await groups(page)).map((g) => [g.name, g.src])).toEqual(expect.arrayContaining([["Kal", "manual"], ["Slt", "manual"], ["Awb", "manual"]]));
    };
    await check();
    // 导出带名字
    expect(await page.evaluate(() => window.__t.transcriptText())).toContain("Kal: T:" + CONV1[0].text);
    await page.waitForTimeout(1000); // 防抖保存
    await page.reload();
    await page.waitForFunction(() => window.__t);
    await page.waitForFunction(() => window.__t.lspk.core.visible().length === 3);
    await check();
    for (const v of ["kal", "slt", "awb"]) await expect(chipOf(page, TL1.find((s) => s.voice === v)!.text)).toHaveText(NAMES[v]);
    // 改名后清除:回到字母,再改回来
    const kal = TL1[0].text;
    // 点击区域比标签本身大(手机上好点):标签上方 6 px 也点得到
    await chipOf(page, kal).evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = (await chipOf(page, kal).boundingBox())!;
    expect(box.height).toBeLessThan(24);
    expect(await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.closest(".lwho") ? "lwho" : e?.outerHTML.slice(0, 80); }, [box.x + 3, box.y - 6])).toBe("lwho");
    await chipOf(page, kal).click();
    await page.click("#lspkClearName");
    await expect(chipOf(page, kal)).toHaveText(String.fromCharCode(65 + voiceGroup.kal));
    await chipOf(page, kal).click();
    await page.click("#lspkPick .names .btn:last-child");
    await page.fill("#lspkPick input", "Kal"); await page.press("#lspkPick input", "Enter");
    await expect(chipOf(page, kal)).toHaveText("Kal");
  });

  test("saved voices let the next session name the groups from the library, without GPT", async () => {
    test.setTimeout(400_000);
    // 停止后:存进声纹库(手动起名的默认勾选)
    await expect(page.locator("#lspkSave")).toBeVisible();
    await page.click("#lspkSave");
    const boxes = page.locator("#lspkSaveBox input[type=checkbox]");
    await expect(boxes).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(boxes.nth(i)).toBeChecked();
    await page.click("#lspkSaveDo");
    const voices = await page.evaluate(() => (JSON.parse(localStorage.getItem("jls.templates") || "[]").find((x: any) => x.id === "general") || {}).voices);
    expect(Object.keys(voices).sort()).toEqual(["Awb", "Kal", "Slt"]);
    for (const x of Object.values(voices) as any[]) { expect(x.d).toBe(0); expect(x.alts).toHaveLength(1); expect(x.alts[0].src).toBe("live"); expect(x.alts[0].d).toBeGreaterThan(5); }

    // 同一模板开新会话(设置沿用:说话人识别开着)
    await page.click("#toTpl");
    await page.click("#tplList .card.current .btn.primary");
    await expect(page.locator("#log .row")).toHaveCount(0);
    expect(await page.evaluate(() => window.__t.lspk.core.visible().length)).toBe(0);
    const reqs0 = await page.evaluate(() => window.__reqs.length);
    await page.click("#go");
    await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1 && window.__t.lspk.ready);
    const ph = await phase(page, 3000, 0);
    const ref2 = await play(page, TL2, ph, "b");
    await drained(page);
    const L = await evalLines(page, CONV2.map((x) => x.text));
    const r = evaluate(L, ref2);
    console.log("live run 2 (known voices):\n" + formatReport(r));
    const gs = await groups(page);
    console.log("groups:", JSON.stringify(gs));
    // 每组都由声纹库起了名,名字和脚本的说话人一致
    expect(gs.map((g) => g.src)).toEqual(["library", "library", "library"]);
    expect(gs.map((g) => g.name).sort()).toEqual(["Awb", "Kal", "Slt"]);
    expect(r.mapping.every((m) => m.pinned)).toBe(true);
    expect(r.accuracy!).toBeGreaterThanOrEqual(0.9);
    // 没有任何 GPT 判定请求(只有翻译)
    const reqs = await page.evaluate((n) => window.__reqs.slice(n), reqs0);
    expect(reqs.every((u: string) => u.includes("New ASR segments"))).toBe(true);
    await page.click("#go");
    // 组存在 lspk:<会话 id>;清空记录、删除会话时一起删掉
    const sid2 = await page.evaluate(() => localStorage.getItem("jls.curSession"));
    await page.waitForTimeout(1000);
    expect(await idbKeys(page)).toEqual(expect.arrayContaining(["lspk:sA", "lspk:" + sid2]));
    await page.click("#openSettings");
    await page.click("#clearAll"); await page.click("#clearAll");
    await page.click("#closeSettings");
    await expect(page.locator("#log .lwho")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await idbKeys(page)).not.toContain("lspk:" + sid2);
    await deleteSession(page, "A");
    await page.waitForTimeout(300);
    expect((await idbKeys(page)).filter((k) => k.startsWith("lspk:"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("with an empty library, the GPT judge names the groups while listening", async () => {
    test.setTimeout(300_000);
    // 清空模板声纹库,开新会话
    await page.evaluate(() => {
      const tps = JSON.parse(localStorage.getItem("jls.templates") || "[]");
      for (const tp of tps) delete tp.voices;
      localStorage.setItem("jls.templates", JSON.stringify(tps));
    });
    await page.click("#toTpl");
    await page.click("#tplList .card.current .btn.primary");
    // 假的 GPT 判定:按请求里每组的句子(文本 → 脚本里的声音)多数决,带「自我介绍」证据回名字;翻译请求照旧走原来的假接口
    await page.evaluate(([who, names]) => {
      const prev = window.fetch; (window as any).__judge = [];
      window.fetch = async (url, opt) => {
        const body = opt && typeof opt.body === "string" ? JSON.parse(opt.body) : null;
        if (!body || body.response_format?.json_schema?.name !== "live_speakers") return prev(url, opt);
        const user: string = body.messages[1].content, votes: Record<string, Record<string, number>> = {};
        for (const m of user.matchAll(/^\[([A-Z]+)(?::[^\]]*)?\] (.+)$/gm)) { const v = who[m[2].trim()]; if (v) ((votes[m[1]] ||= {})[v] = (votes[m[1]][v] || 0) + 1); }
        const groups = Object.entries(votes).map(([id, c]) => ({ id, name: names[Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]], evidence: "intro" }));
        (window as any).__judge.push({ user, groups });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ groups }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      };
    }, [Object.fromEntries(CONV2.map((x) => [x.text, x.voice])), NAMES] as const);
    await page.click("#go");
    await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1 && window.__t.lspk.ready);
    const ph = await phase(page, 3000, 0);
    const ref = await play(page, TL2, ph, "c");
    await drained(page);
    // 判定循环每 2 秒看一次;新组出现就会叫,最多等它跑完一轮
    await page.waitForFunction(() => window.__t.lspk.core.visible().length === 3 && window.__t.lspk.core.visible().every((g: any) => g.name), null, { timeout: 60_000 });
    const gs = await groups(page);
    console.log("groups named by the judge:", JSON.stringify(gs));
    expect(gs.map((g) => g.src)).toEqual(["gpt-evidence", "gpt-evidence", "gpt-evidence"]);
    const L = await evalLines(page, CONV2.map((x) => x.text));
    const r = evaluate(L, ref);
    console.log("live run 3 (GPT names):\n" + formatReport(r));
    expect(r.mapping.every((m) => m.pinned)).toBe(true);
    expect(r.accuracy!).toBeGreaterThanOrEqual(0.9);
    const calls = await page.evaluate(() => (window as any).__judge.length);
    console.log(`judge calls: ${calls}`);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);
    // 名字的来源 GPT 低于手动:手动改了以后,下一轮 GPT 也改不回去
    const kal = TL2.find((x) => x.voice === "kal")!.text;
    await chipOf(page, kal).click();
    await page.click("#lspkPick .names .btn:last-child");
    await page.fill("#lspkPick input", "Host"); await page.press("#lspkPick input", "Enter");
    expect(await page.evaluate(() => window.__t.liveSpk()!.propose([{ id: window.__t.lines.find((l: any) => l.lspk?.name === "Host").lspk.g, name: "Kal", src: "gpt-evidence" }]).changed)).toBe(false);
    await expect(chipOf(page, kal)).toHaveText("Host");
    await page.click("#go");
    expect(errors).toEqual([]);
  });

  test("deleting the only session while listening leaves no lspk: key behind", async () => {
    test.setTimeout(120_000);
    // 只留当前会话
    await page.click("#toHome");
    const others = page.locator("#sessList .card:not(.current) .i-trash");
    while (await others.count()) { await others.first().click(); await others.first().click(); }
    await expect(page.locator("#sessList .card")).toHaveCount(1);
    await page.click("#sessList .card.current .btn.primary");
    await page.click("#go");
    await page.waitForFunction(() => window.__ws && window.__ws.readyState === 1 && window.__t.lspk.ready);
    const connAt: number = await page.evaluate(() => window.__t.liveAudio.connAt);
    await waitNow(page, connAt + 11_000);
    // 推几句,第一句的组算出来(防抖保存已排上)、后面的还在排队时就删会话
    await page.evaluate((c) => {
      const w = window.__ws, t = window.__t.liveAudio.now() - c;
      for (let i = 0; i < 6; i++) {
        const id = "d" + i, a = t - 10_000 + i * 1600;
        w.emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: a });
        w.emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: a + 1400 });
        w.emit({ type: "input_audio_buffer.committed", item_id: id });
        w.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: "probe " + i });
      }
    }, connAt);
    await page.waitForFunction(() => window.__t.lines.some((l: any) => l.raw.startsWith("probe") && l.lspk), null, { timeout: 30_000 });
    console.log("at delete:", JSON.stringify(await page.evaluate(() => ({ queue: window.__t.lspk.queue, busy: window.__t.lspk.busy }))));
    await page.click("#toHome");
    const del = page.locator("#sessList .card.current .i-trash");
    await del.click(); await del.click();
    await expect(page.locator("#sessList .card")).toHaveCount(0);
    expect(await page.evaluate(() => window.__t.lspk.core.visible().length)).toBe(0);
    await page.waitForTimeout(2000);
    expect((await idbKeys(page)).filter((k) => k.startsWith("lspk:"))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
