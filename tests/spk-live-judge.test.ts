import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyNames, JUDGE_SCHED as C, type NameSrc, type SchedEvent } from "../src/spk/live-schedule";
import { liveJudgeCalls, liveJudgePrompt, parseLiveJudge, startLiveJudge, stopLiveJudge, LIVE_JUDGE, type JudgeApiGroup, type JudgeApiLine, type LiveJudgeApi, type LiveJudgeCfg } from "../src/spk/live-judge";

const T0 = 1_000_000;
const grp = (id: number, dur: number, name: string | null = null, src: NameSrc | null = null): JudgeApiGroup => ({ id, letter: String.fromCharCode(65 + id), name, src, dur });

// 假的 LiveSpkApi:句子按时间自动生成(每 5 秒一句,轮流归 A/B),事件、不确定句可手动加
function fakeApi(groups: JudgeApiGroup[]) {
  const st = {
    groups, events: [] as SchedEvent[], uncertain: 0, talking: true, autoCue: false, extra: [] as JudgeApiLine[],
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
    uncertain: () => st.uncertain,
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

  it("请求只带上次调用之后的句子", async () => {
    const { api, st } = fakeApi([grp(0, 30), grp(1, 25)]);
    const f = fakeFetch(none);
    start(api, f);
    await adv(0);
    expect(user(f.bodies[0])).toContain("[A] line 0");
    await adv(20_000);
    st.events.push({ kind: "cue", at: Date.now() });
    await adv(1);
    const u = user(f.bodies[1]);
    expect(u).not.toMatch(/line 0\b/);
    expect(u).toContain("[B] line 1\n[A] line 2\n[B] line 3\n[A] line 4");
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
