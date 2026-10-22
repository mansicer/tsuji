import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyNames, JUDGE_SCHED as C, type NameSrc, type SchedEvent } from "../src/spk/live-schedule";
import { liveJudgeCalls, liveJudgePrompt, parseLiveJudge, startLiveJudge, stopLiveJudge, LIVE_JUDGE, type JudgeApiGroup, type JudgeApiLine, type LiveJudgeApi, type LiveJudgeCfg } from "../src/spk/live-judge";

const T0 = 1_000_000;
const grp = (id: number, dur: number, name: string | null = null, src: NameSrc | null = null): JudgeApiGroup => ({ id, letter: String.fromCharCode(65 + id), name, src, dur });

// 假的 LiveSpkApi:句子按时间自动生成(每 5 秒一句,轮流归 A/B),事件、不确定句可手动加
function fakeApi(groups: JudgeApiGroup[]) {
  const st = {
    groups, events: [] as SchedEvent[], talking: true, autoCue: false, extra: [] as JudgeApiLine[],
    proposals: [] as { id: number; name: string; src: NameSrc }[][], frozenAt: Infinity,
  };
  const lines = (): JudgeApiLine[] => {
    const end = Math.min(Date.now(), st.frozenAt), out: JudgeApiLine[] = [];
    for (let t = T0, i = 0; t <= end; t += 5000, i++) out.push({ id: i, text: `line ${i}`, g: groups.length ? groups[i % groups.length].id : null, aStart: t - T0 });
    return out.concat(st.extra);
  };
  const api: LiveJudgeApi = {
    groups: () => st.groups,
    linesSince: (at) => lines().filter((l) => l.aStart >= at),
    events: () => (st.autoCue ? [...st.events, { kind: "cue", at: Date.now() }] : st.events),
    propose: (p) => { st.proposals.push(p); const r = applyNames(st.groups, p); st.groups = r.groups; return { changed: r.changed }; },
  };
  return { api, st, freeze: () => { st.frozenAt = Date.now(); } };
}

type Reply = { groups: { id: string; name: string | null; evidence: string }[] } | "http500" | "badjson" | "hang";
function fakeFetch(reply: (n: number) => Reply) {
  const bodies: any[] = [], at: number[] = [];
  let release: (() => void) | null = null;
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const n = bodies.length; bodies.push(JSON.parse(init.body)); at.push(Date.now() - T0);
    const r = reply(n);
    if (r === "hang") await new Promise<void>((res) => { release = res; });
    if (r === "http500") return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
    const content = r === "badjson" ? "{not json" : JSON.stringify(r === "hang" ? { groups: [] } : r);
    return { ok: true, status: 200, text: async () => content, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 500, completion_tokens: 50 } }) };
  });
  return { fn, bodies, at, release: () => release?.() };
}
const none = (): Reply => ({ groups: [] });

const cfg = (people: { src: string; reading?: string; tgt?: string }[] = []): LiveJudgeCfg => ({
  ctModel: "gpt-6.1-sol", apiBase: "https://api.test/v1", tpl: { description: "A radio show.", spkNotes: "Alice hosts." },
  glossary: { people: people.map((p) => ({ src: p.src, reading: p.reading || "", tgt: p.tgt || "", notes: "" })) },
});
let cost: ReturnType<typeof vi.fn<(model: string, u: unknown) => void>>;
function start(api: LiveJudgeApi, f: ReturnType<typeof fakeFetch>, c = cfg()) {
  cost = vi.fn<(model: string, u: unknown) => void>();
  startLiveJudge({ api: () => api, cfg: () => c, apiHeaders: () => ({ "Content-Type": "application/json" }), addMtCost: cost, fetch: f.fn as unknown as typeof fetch });
}
const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const user = (b: any): string => b.messages[1].content;
const sys = (b: any): string => b.messages[0].content;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { stopLiveJudge(); vi.useRealTimers(); });

describe("live judge loop", () => {
  it("冷启动:组还不够 20 秒不叫;够了立即叫,之后没改动 60 秒一次、有改动 30 秒一次", async () => {
    const { api, st } = fakeApi([grp(0, 10)]);
    const f = fakeFetch((n) => (n === 1 ? { groups: [{ id: "A", name: "Alice", evidence: "context" }] } : none()));
    start(api, f, cfg([{ src: "Alice" }]));
    await adv(30_000);
    expect(f.fn).not.toHaveBeenCalled();
    st.groups = [grp(0, 25), grp(1, 21)];
    await adv(2_000);
    expect(f.at).toEqual([32_000]);
    await adv(59_000);
    expect(f.at.length).toBe(1);
    await adv(1_000); // 没改动 → 60 s
    expect(f.at).toEqual([32_000, 92_000]);
    await adv(30_000); // 这次改了 A,B 还没名字 → 30 s
    expect(f.at).toEqual([32_000, 92_000, 122_000]);
    expect(st.groups[0]).toMatchObject({ name: "Alice", src: "gpt-guess" });
    expect(cost).toHaveBeenCalledWith("gpt-6.1-sol", { prompt_tokens: 500, completion_tokens: 50 });
  });

  it("新组出现:不等退避,马上叫(距上次至少 minGap)", async () => {
    const { api, st } = fakeApi([grp(0, 30)]);
    const f = fakeFetch(none);
    start(api, f);
    await adv(0);
    expect(f.at).toEqual([0]);
    await adv(20_000);
    st.groups = [grp(0, 40), grp(1, 3)]; st.events.push({ kind: "new-group", at: Date.now() });
    await adv(LIVE_JUDGE.poll);
    expect(f.at.length).toBe(2);
    expect(f.at[1] - 20_000).toBeLessThanOrEqual(LIVE_JUDGE.poll); // 一个轮询周期内(冷启动本来要等 60 s)
    // 线索在 minGap 之内:等够 10 秒
    await adv(1_000); st.events.push({ kind: "cue", at: Date.now() });
    await adv(f.at[1] + C.minGap - 1 - (Date.now() - T0));
    expect(f.at.length).toBe(2);
    await adv(1);
    expect(f.at).toEqual([0, f.at[1], f.at[1] + C.minGap]);
  });

  it("连续没改动就退避 1 → 2 → 5 分钟;合并后回到快速并重新数", async () => {
    const { api, st } = fakeApi([grp(0, 30, "Alice", "gpt-evidence")]);
    const f = fakeFetch(none);
    start(api, f);
    st.events.push({ kind: "cue", at: T0 }); // 第一次需要个触发
    await adv(0);
    await adv(60_000 + 60_000 + 120_000 + 300_000);
    expect(f.at).toEqual([0, 60_000, 120_000, 240_000, 540_000]);
    await adv(40_000);
    st.events.push({ kind: "merge", at: Date.now() });
    await adv(LIVE_JUDGE.poll);
    expect(f.at.length).toBe(6);
    const m = f.at[5];
    expect(m - 580_000).toBeLessThanOrEqual(LIVE_JUDGE.poll); // 距上次已超过 30 s → 一个轮询周期内就叫
    await adv(m + 60_000 - (Date.now() - T0));
    expect(f.at.slice(-1)).toEqual([m + 60_000]); // 重置后重新从 1 分钟数
    expect(liveJudgeCalls().every((c) => !c.changed)).toBe(true);
  });

  it("没有新字幕就不叫", async () => {
    const { api, freeze } = fakeApi([grp(0, 30)]);
    const f = fakeFetch(none);
    start(api, f);
    await adv(0);
    expect(f.at.length).toBe(1);
    freeze();
    await adv(600_000);
    expect(f.at.length).toBe(1);
  });

  it("每小时上限", async () => {
    const { api, st } = fakeApi([grp(0, 30)]);
    st.autoCue = true; // 一直有线索 → 每 minGap 叫一次
    const f = fakeFetch(none);
    start(api, f);
    await adv(3_000_000);
    expect(f.at.length).toBe(C.hourCap);
    expect(f.at[C.hourCap - 1]).toBe((C.hourCap - 1) * C.minGap);
    await adv(C.hour - 3_000_000);
    expect(f.at.length).toBe(C.hourCap + 1);
    expect(f.at[C.hourCap]).toBe(C.hour); // 等最早那次滑出一小时窗口
  });

  it("同时只有一个请求", async () => {
    const { api, st } = fakeApi([grp(0, 30)]);
    st.autoCue = true;
    const f = fakeFetch((n) => (n === 0 ? "hang" : none()));
    start(api, f);
    await adv(120_000);
    expect(f.fn).toHaveBeenCalledTimes(1);
    f.release();
    await adv(5_000);
    expect(f.fn).toHaveBeenCalledTimes(2);
    expect(f.at[1]).toBe(120_000);
  });

  it("出错退避 30 → 60 → 120 秒,成功后恢复;不往外抛", async () => {
    const { api, st } = fakeApi([grp(0, 30)]);
    st.autoCue = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch((n) => (n < 2 ? "http500" : n === 2 ? "badjson" : none()));
    start(api, f);
    await adv(220_000);
    expect(f.at).toEqual([0, 30_000, 90_000, 210_000, 220_000]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(liveJudgeCalls().map((c) => c.at - T0)).toEqual([210_000, 220_000]); // 失败的不算调用
    // 失败那几次的句子没丢,成功那次一起发
    expect(user(f.bodies[3])).toContain("[A] line 0\n");
    expect(user(f.bodies[4])).not.toContain("[A] line 0\n");
    warn.mockRestore();
  });

  it("请求只带上次调用之后的新句,外加最近几句旧句作上下文", async () => {
    const { api, st } = fakeApi([grp(0, 30), grp(1, 25)]);
    const f = fakeFetch(none);
    start(api, f);
    await adv(0);
    expect(user(f.bodies[0])).toContain("[A] line 0");
    await adv(20_000);
    st.events.push({ kind: "cue", at: Date.now() });
    await adv(1);
    const u = user(f.bodies[1]), nw = u.slice(u.indexOf("New lines:"));
    expect(u).toContain("Earlier lines (context only, already judged):\n[A] line 0\n\nNew lines:");
    expect(nw).not.toMatch(/line 0\b/);
    expect(nw).toContain("[B] line 1\n[A] line 2\n[B] line 3\n[A] line 4");
    expect(user(f.bodies[0])).not.toContain("Earlier lines");
    expect(u).toContain("- A: 30 s of speech, unnamed");
    expect(f.bodies[1]).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: LIVE_JUDGE.effort, response_format: { type: "json_schema" } });
  });

  it("evidence 映射来源:intro/called → gpt-evidence,context → gpt-guess,none/null 不提", async () => {
    const { api, st } = fakeApi([grp(0, 30), grp(1, 30), grp(2, 30), grp(3, 30)]);
    const f = fakeFetch(() => ({ groups: [
      { id: "A", name: "Alice", evidence: "intro" }, { id: "B", name: "Bob", evidence: "called" },
      { id: "C", name: "Carol", evidence: "context" }, { id: "D", name: null, evidence: "none" },
    ] }));
    start(api, f, cfg([{ src: "Alice" }, { src: "Bob" }, { src: "Carol" }, { src: "Dan" }]));
    await adv(0);
    expect(st.proposals[0]).toEqual([{ id: 0, name: "Alice", src: "gpt-evidence" }, { id: 1, name: "Bob", src: "gpt-evidence" }, { id: 2, name: "Carol", src: "gpt-guess" }]);
    expect(liveJudgeCalls()).toEqual([{ at: T0, changed: true }]);
  });

  it("锁定的组永远不提改名", async () => {
    const { api, st } = fakeApi([grp(0, 30, "Alice", "manual"), grp(1, 30)]);
    const f = fakeFetch(() => ({ groups: [{ id: "A", name: "Bob", evidence: "intro" }, { id: "B", name: "Bob", evidence: "intro" }] }));
    start(api, f, cfg([{ src: "Alice" }, { src: "Bob" }]));
    await adv(0);
    expect(user(f.bodies[0])).toContain("- A: 30 s of speech, name: Alice (named by user), locked");
    expect(user(f.bodies[0])).toContain("[A: Alice] line 0");
    expect(sys(f.bodies[0])).toContain("Never rename a group marked \"locked\"");
    expect(st.proposals[0]).toEqual([{ id: 1, name: "Bob", src: "gpt-evidence" }]);
    expect(st.groups[0]).toMatchObject({ name: "Alice", src: "manual" });
  });

  it("停止后丢弃进行中的结果,不再调度", async () => {
    const { api, st } = fakeApi([grp(0, 30)]);
    const f = fakeFetch(() => "hang");
    start(api, f);
    await adv(0);
    stopLiveJudge();
    f.release();
    await adv(600_000);
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(st.proposals).toEqual([]);
  });
});

// 句子手动给的假 API:测「[?] 发出去的句子有了组再补发」和「线索等组」
function manualApi(groups: JudgeApiGroup[]) {
  const st = { groups, events: [] as SchedEvent[], lines: [] as JudgeApiLine[] };
  const api: LiveJudgeApi = {
    groups: () => st.groups,
    linesSince: (at) => st.lines.filter((l) => l.aStart >= at).map((l) => ({ ...l })),
    events: () => st.events,
    propose: (p) => { const r = applyNames(st.groups, p); st.groups = r.groups; return { changed: r.changed }; },
  };
  const add = (text: string, g: number | null, aStart: number) => { const l = { id: st.lines.length, text, g, aStart }; st.lines.push(l); return l; };
  return { api, st, add, now: () => Date.now() - T0 };
}
const newLines = (b: any) => { const u = user(b); return u.slice(u.indexOf("New lines:")); };
const ctxOf = (b: any) => { const u = user(b), i = u.indexOf("Earlier lines"); return i < 0 ? "" : u.slice(i, u.indexOf("New lines:")); };

describe("自我介绍不丢", () => {
  it("线索那句一直没有组:等满 cueWait 以 [?] 发出;之后有了组再作为新句补发一次", async () => {
    const { api, st, add, now } = manualApi([grp(0, 30)]);
    const f = fakeFetch(none);
    add("Welcome to the show.", 0, 0);
    start(api, f);
    await adv(0);
    expect(f.at).toEqual([0]);
    await adv(5_000);
    const hi = add("Hi, I'm Alice.", null, 5_000); st.events.push({ kind: "cue", at: Date.now() });
    await adv(5_000); // minGap 到了,但线索那句还没组 → 等
    expect(f.at).toEqual([0]);
    await adv(9_999);
    expect(f.at).toEqual([0]);
    await adv(1); // 线索之后 15 秒:不再等
    expect(f.at).toEqual([0, 5_000 + LIVE_JUDGE.cueWait]);
    expect(newLines(f.bodies[1])).toContain("[?] Hi, I'm Alice.");
    expect(ctxOf(f.bodies[1])).toContain("[A] Welcome to the show.");
    // 还是没组:不算新字幕,不叫
    await adv(60_000);
    expect(f.at.length).toBe(2);
    // 新组出现,那句归了 B → 作为新句补发
    st.groups = [grp(0, 40), grp(1, 4)]; hi.g = 1; st.events.push({ kind: "new-group", at: Date.now() });
    await adv(LIVE_JUDGE.poll);
    expect(f.at.length).toBe(3);
    expect(newLines(f.bodies[2])).toContain("[B] Hi, I'm Alice.");
    expect(newLines(f.bodies[2])).not.toContain("Welcome");
    // 补发过一次就不再发
    st.events.push({ kind: "merge", at: Date.now() }); add("So, Alice, how are you?", 0, 20_000);
    await adv(C.fast + LIVE_JUDGE.poll);
    expect(f.at.length).toBe(4);
    expect(newLines(f.bodies[3])).not.toContain("Hi, I'm Alice");
    expect(ctxOf(f.bodies[3])).toContain("[B] Hi, I'm Alice.");
    expect(now()).toBeGreaterThan(0);
  });

  it("线索触发的调用等线索那句有了组再发", async () => {
    const { api, st, add } = manualApi([grp(0, 30)]);
    const f = fakeFetch(none);
    add("Welcome to the show.", 0, 0);
    start(api, f);
    await adv(5_000);
    const hi = add("Hi, I'm Alice.", null, 5_000); st.events.push({ kind: "cue", at: Date.now() });
    await adv(7_000);
    expect(f.at).toEqual([0]); // minGap 已过(10 s),但还没组
    hi.g = 0;
    await adv(LIVE_JUDGE.poll);
    expect(f.at.length).toBe(2);
    expect(f.at[1]).toBeGreaterThan(12_000); expect(f.at[1]).toBeLessThanOrEqual(12_000 + LIVE_JUDGE.poll); // 有组之后一个轮询周期内
    expect(newLines(f.bodies[1])).toContain("[A] Hi, I'm Alice.");
    expect(user(f.bodies[1])).not.toContain("[?]");
  });

  it("[?] 句超过 pendWin(音频时钟)才有组:不再补发", async () => {
    const { api, st, add } = manualApi([grp(0, 30)]);
    const f = fakeFetch(none);
    add("Welcome to the show.", 0, 0);
    const q = add("Mm-hmm.", null, 2_000);
    start(api, f);
    await adv(0);
    expect(newLines(f.bodies[0])).toContain("[?] Mm-hmm.");
    await adv(1_000);
    add("Later line.", 0, 2_000 + LIVE_JUDGE.pendWin); q.g = 0; st.events.push({ kind: "cue", at: Date.now() });
    await adv(C.minGap);
    expect(f.at.length).toBe(2);
    expect(newLines(f.bodies[1])).toContain("[A] Later line.");
    expect(newLines(f.bodies[1])).not.toContain("Mm-hmm");
  });

  it("上下文最多 ctxLines 句", async () => {
    const { api, st, add } = manualApi([grp(0, 30)]);
    const f = fakeFetch(none);
    for (let i = 0; i < 12; i++) add(`old ${i}`, 0, i * 1000);
    start(api, f);
    await adv(1_000);
    add("new one", 0, 20_000); st.events.push({ kind: "cue", at: Date.now() });
    await adv(C.minGap);
    const ctx = ctxOf(f.bodies[1]);
    expect(ctx.match(/^\[A\] old/gm)!.length).toBe(LIVE_JUDGE.ctxLines);
    expect(ctx).toContain("[A] old 11");
    expect(ctx).not.toContain("old 6\n");
  });
  it("热闹对话里不确定句一直有(比例不变)仍会退避;比例突然升高才回到快速", async () => {
    const { api, st, add, now } = manualApi([grp(0, 30, "Alice", "gpt-evidence"), grp(1, 30, "Bob", "gpt-guess")]);
    const f = fakeFetch(none);
    let i = 0, bad = 5; // 每 bad 句里有一句没组
    const talk = async (ms: number) => { for (const end = now() + ms; now() < end;) { add(`l${i}`, i % bad === 0 ? null : i % 2, now()); i++; await adv(5_000); } };
    st.events.push({ kind: "cue", at: T0 });
    start(api, f);
    await talk(1_200_000);
    const gaps = f.at.slice(1).map((t, k) => t - f.at[k]);
    expect(gaps.slice(-2)).toEqual([300_000, 300_000]);
    expect(f.at.length).toBeLessThan(10);
    // 一半句子没组:比例从 0.2 升到 0.5 → 30 秒节奏
    const n0 = f.at.length, t0 = f.at[n0 - 1];
    bad = 2;
    await talk(300_000);
    expect(f.at.length).toBeGreaterThan(n0);
    expect(f.at[n0] - t0).toBeLessThan(300_000); // 本窗口比例升上去就叫,不等满 5 分钟
  });
});

describe("parseLiveJudge", () => {
  const groups = [grp(0, 30), grp(1, 30), grp(2, 30, "X", "library")];
  const people = cfg([{ src: "高橋", reading: "たかはし", tgt: "Takahashi" }]).glossary.people;
  it("有名单:只收名单里的名字,读音/译文换成原文", () => {
    const r = { groups: [{ id: "a", name: "takahashi", evidence: "intro" }, { id: "B", name: "Nobody", evidence: "intro" }, { id: "C", name: "高橋", evidence: "intro" }] };
    expect(parseLiveJudge(r, groups, people)).toEqual([{ id: 0, name: "高橋", src: "gpt-evidence" }]);
  });
  it("没名单:只收 intro/called,不收 context;垃圾输入不抛", () => {
    const r = { groups: [{ id: "A", name: "Zed", evidence: "context" }, { id: "B", name: "Yan", evidence: "called" }, null, { id: "Q", name: "x", evidence: "intro" }] };
    expect(parseLiveJudge(r, groups, [])).toEqual([{ id: 1, name: "Yan", src: "gpt-evidence" }]);
    expect(parseLiveJudge(null, groups, [])).toEqual([]);
    expect(parseLiveJudge({ groups: "x" }, groups, [])).toEqual([]);
  });
  it("提示词:没有组的句子标 [?]", () => {
    const u = liveJudgePrompt(cfg(), [grp(0, 12.4)], [{ id: 1, text: "hi", g: null, aStart: 0 }, { id: 2, text: "yo", g: 0, aStart: 1 }]);
    expect(u).toContain("[?] hi\n[A] yo");
    expect(u).toContain("Known people:\n(none)");
  });
});
