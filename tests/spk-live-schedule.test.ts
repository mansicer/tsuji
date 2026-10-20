import { describe, expect, it } from "vitest";
import { applyNames, canOverride, detectCue, JUDGE_SCHED as C, nextJudgeDelay, uncertainRose, type JudgeStats, type NameSrc, type SchedGroup } from "../src/spk/live-schedule";

const g = (id: number, dur: number, name: string | null = null, src: NameSrc | null = null): SchedGroup => ({ id, dur, name, src });
const st = (o: Partial<JudgeStats> = {}): JudgeStats => ({ groups: [g(0, 25)], calls: [], linesSince: 5, unc: { n: 0, total: 0 }, uncLast: null, events: [], ...o });
const named = [g(0, 60, "Alice", "gpt-evidence"), g(1, 40, "Bob", "gpt-guess")];

describe("nextJudgeDelay", () => {
  it("没有新字幕就不调用", () => {
    expect(nextJudgeDelay(st({ linesSince: 0 }), 0)).toBeNull();
    expect(nextJudgeDelay(st({ linesSince: 0, events: [{ kind: "cue", at: 5 }] }), 10)).toBeNull();
  });
  it("冷启动:组还不到 20 秒且没有事件时不叫;一到 20 秒立即叫", () => {
    expect(nextJudgeDelay(st({ groups: [g(0, 19.9)] }), 100_000)).toBeNull();
    expect(nextJudgeDelay(st({ groups: [g(0, 20)] }), 100_000)).toBe(0);
  });
  it("冷启动节奏 30–60 秒:上次有改动 30 秒,没改动 60 秒", () => {
    expect(nextJudgeDelay(st({ calls: [{ at: 100_000, changed: true }] }), 110_000)).toBe(C.coldFast - 10_000);
    expect(nextJudgeDelay(st({ calls: [{ at: 100_000, changed: false }] }), 110_000)).toBe(C.coldSlow - 10_000);
    expect(nextJudgeDelay(st({ calls: [{ at: 0, changed: false }] }), 500_000)).toBe(0); // 早就过了
  });
  it("新组或线索:立即(但距上次至少 minGap)", () => {
    const calls = [{ at: 100_000, changed: false }, { at: 160_000, changed: false }];
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "new-group", at: 165_000 }] }), 166_000)).toBe(4_000);
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "cue", at: 175_000 }] }), 180_000)).toBe(0);
    // 还没调用过、组也不够 20 秒,线索也能触发
    expect(nextJudgeDelay(st({ groups: [g(0, 3)], events: [{ kind: "cue", at: 1000 }] }), 2000)).toBe(0);
  });
  it("上次调用之前的事件不算", () => {
    const calls = [{ at: 100_000, changed: true }];
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "new-group", at: 90_000 }] }), 100_000)).toBe(C.backoff[0]);
  });
  it("退避:连续没改动 1 → 2 → 5 分钟", () => {
    const calls = (...ch: boolean[]) => ch.map((changed, i) => ({ at: i * 1000, changed }));
    const d = (...ch: boolean[]) => nextJudgeDelay(st({ groups: named, calls: calls(...ch) }), (ch.length - 1) * 1000);
    expect(d(true)).toBe(60_000);
    expect(d(true, false)).toBe(60_000);
    expect(d(true, false, false)).toBe(120_000);
    expect(d(true, false, false, false)).toBe(300_000);
    expect(d(false, false, false, false, false, false)).toBe(300_000);
    expect(d(false, false, false, true)).toBe(60_000);
  });
  it("合并/拆分、不确定句比例上升:回到快速(30 秒)", () => {
    const calls = [0, 1, 2, 3].map((i) => ({ at: i * 1000, changed: false }));
    expect(nextJudgeDelay(st({ groups: named, calls }), 3000)).toBe(300_000);
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "merge", at: 3500 }] }), 4000)).toBe(C.fast - 1000);
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "split", at: 3500 }] }), 4000)).toBe(C.fast - 1000);
    // 上一窗口 1/10 不确定,这次 4/10:比例升了 0.3 → 快速
    expect(nextJudgeDelay(st({ groups: named, calls, unc: { n: 4, total: 10 }, uncLast: { n: 1, total: 10 } }), 4000)).toBe(C.fast - 1000);
    // 只升了 0.1:照常退避
    expect(nextJudgeDelay(st({ groups: named, calls, unc: { n: 2, total: 10 }, uncLast: { n: 1, total: 10 } }), 4000)).toBe(300_000 - 1000);
  });
  it("热闹的多人对话:不确定句累计数每次都涨,但比例不变 → 仍然退避", () => {
    // 每个窗口 30 句里 6 句不确定(累计数每次 +6,旧规则会一直回到快速)
    const calls = [0, 1, 2, 3].map((i) => ({ at: i * 1000, changed: false }));
    expect(nextJudgeDelay(st({ groups: named, calls, unc: { n: 6, total: 30 }, uncLast: { n: 6, total: 30 } }), 4000)).toBe(300_000 - 1000);
    expect(nextJudgeDelay(st({ groups: named, calls, unc: { n: 9, total: 30 }, uncLast: { n: 5, total: 25 } }), 4000)).toBe(300_000 - 1000);
  });
  it("uncertainRose:比例上升够多、两个窗口句数都够才算", () => {
    expect(uncertainRose({ n: 3, total: 10 }, { n: 1, total: 10 })).toBe(true); // +0.2
    expect(uncertainRose({ n: 2, total: 10 }, { n: 1, total: 10 })).toBe(false);
    expect(uncertainRose({ n: 4, total: 4 }, { n: 0, total: 10 })).toBe(false); // 这次句太少
    expect(uncertainRose({ n: 5, total: 10 }, { n: 0, total: 3 })).toBe(false); // 上次句太少
    expect(uncertainRose({ n: 5, total: 10 }, null)).toBe(false);
    expect(uncertainRose({ n: 2, total: 10 }, { n: 1, total: 10 }, { ...C, uncertainRise: 0.1 })).toBe(true);
  });
  it("重置之后,退避从头数(重置之前的没改动不算)", () => {
    const calls = [{ at: 0, changed: false }, { at: 1000, changed: false }, { at: 2000, changed: false }, { at: 5000, changed: false }];
    expect(nextJudgeDelay(st({ groups: named, calls, events: [{ kind: "merge", at: 3000 }] }), 5000)).toBe(60_000);
  });
  it("manual / library 的组 GPT 改不了:全是这种就不调用", () => {
    expect(nextJudgeDelay(st({ groups: [g(0, 60, "A", "manual"), g(1, 60, "B", "library")], events: [{ kind: "cue", at: 0 }] }), 1000)).toBeNull();
    // 有名字但来源是 library 的不算冷启动;另一组还没名字才算
    expect(nextJudgeDelay(st({ groups: [g(0, 60, "A", "library"), g(1, 25)] }), 1000)).toBe(0);
  });
  it("每小时上限:满了等最早那次滑出窗口", () => {
    const H = C.hour, calls = Array.from({ length: C.hourCap }, (_, i) => ({ at: 1000 + i * 60_000, changed: true }));
    const now = calls[calls.length - 1].at + 1000;
    expect(nextJudgeDelay(st({ calls, events: [{ kind: "cue", at: now - 500 }] }), now)).toBe(1000 + H - now);
    // 一小时以前的不计入
    const old = calls.map((c) => ({ ...c, at: c.at - H }));
    expect(nextJudgeDelay(st({ calls: old, events: [{ kind: "cue", at: 1000 }] }), 2000)).toBe(0);
  });
  it("常量可以替换", () => {
    expect(nextJudgeDelay(st({ groups: [g(0, 10)] }), 0, { ...C, coldDur: 5 })).toBe(0);
  });
});

describe("canOverride", () => {
  const S: NameSrc[] = ["manual", "library", "gpt-evidence", "gpt-guess"];
  it("高的盖低的、同级可更新、低的不能盖高的", () => {
    for (let i = 0; i < S.length; i++) for (let j = 0; j < S.length; j++) {
      const exp = S[i] === "manual" ? false : j <= i;
      expect(canOverride(S[i], S[j]), `${S[i]} ← ${S[j]}`).toBe(exp);
    }
  });
  it("没有名字时谁都能写;manual 永远不被覆盖", () => {
    for (const s of S) expect(canOverride(null, s)).toBe(true);
    for (const s of S) expect(canOverride("manual", s)).toBe(false);
  });
});

describe("applyNames", () => {
  const gs = [g(0, 30), g(1, 30, "Bob", "gpt-guess"), g(2, 30, "Carol", "manual"), g(3, 30, "Dan", "library")];
  it("按优先级合并,不改原数组", () => {
    const r = applyNames(gs, [
      { id: 0, name: " Alice ", src: "gpt-guess" }, { id: 1, name: "Bobby", src: "gpt-evidence" },
      { id: 2, name: "X", src: "library" }, { id: 3, name: "Y", src: "gpt-evidence" }, { id: 9, name: "Z", src: "manual" },
    ]);
    expect(r.changed).toBe(true);
    expect(r.groups.map((x) => [x.name, x.src])).toEqual([["Alice", "gpt-guess"], ["Bobby", "gpt-evidence"], ["Carol", "manual"], ["Dan", "library"]]);
    expect(r.changes).toEqual([
      { id: 0, from: { name: null, src: null }, to: { name: "Alice", src: "gpt-guess" } },
      { id: 1, from: { name: "Bob", src: "gpt-guess" }, to: { name: "Bobby", src: "gpt-evidence" } },
    ]);
    expect(gs[0].name).toBeNull();
    expect(gs[1].name).toBe("Bob");
  });
  it("没变化、空名字、同名低来源都不算改动", () => {
    const r = applyNames(gs, [{ id: 1, name: "Bob", src: "gpt-guess" }, { id: 0, name: "  ", src: "library" }, { id: 3, name: "Dan", src: "gpt-guess" }]);
    expect(r.changed).toBe(false); expect(r.changes).toEqual([]);
  });
  it("同名升级来源算改动;同级改名可以", () => {
    const r = applyNames(gs, [{ id: 1, name: "Bob", src: "gpt-evidence" }]);
    expect(r.changes).toEqual([{ id: 1, from: { name: "Bob", src: "gpt-guess" }, to: { name: "Bob", src: "gpt-evidence" } }]);
    expect(applyNames(gs, [{ id: 1, name: "Rob", src: "gpt-guess" }]).groups[1].name).toBe("Rob");
    expect(applyNames(gs, [{ id: 3, name: "Dave", src: "library" }]).groups[3].name).toBe("Dave");
  });
  it("同一组多条提议按顺序处理;保留组上的其它字段", () => {
    const cent = new Float32Array(3), r = applyNames([{ ...g(0, 5), cent }], [{ id: 0, name: "A", src: "gpt-evidence" }, { id: 0, name: "B", src: "gpt-guess" }]);
    expect(r.groups[0].name).toBe("A"); expect(r.groups[0].cent).toBe(cent); expect(r.changes.length).toBe(1);
  });
});

describe("detectCue", () => {
  const yes = (t: string, lang: string, kind: "intro" | "call", name?: string) => {
    const c = detectCue(t, lang);
    expect(c, t).not.toBeNull(); expect(c!.kind, t).toBe(kind);
    if (name) expect(c!.name, t).toBe(name);
  };
  const no = (t: string, lang: string) => expect(detectCue(t, lang), t).toBeNull();
  it("日语:自我介绍", () => {
    yes("こんにちは、田中です。", "ja", "intro", "田中");
    yes("はじめまして、サトウと申します", "ja", "intro", "サトウ");
    yes("鈴木といいます、よろしくお願いします", "ja", "intro", "鈴木");
    yes("私は山田です", "ja", "intro", "山田");
    yes("パーソナリティの佐々木です", "ja", "intro", "佐々木");
    yes("どうも、ひなでーす!", "ja", "intro", "ひな");
  });
  it("日语:点名", () => {
    yes("田中さん、どう思いますか?", "ja", "call", "田中");
    yes("ひなちゃん!", "ja", "call", "ひな");
    yes("じゃあ鈴木くんはどう?", "ja", "call", "鈴木");
    yes("ありがとう、マイクさん", "ja", "call", "マイク");
  });
  it("日语:普通的「です」「さん」不算", () => {
    for (const t of ["そうですね", "今日はいい天気です", "はい、そうです", "はい、大丈夫です", "これは本です", "皆さん、こんにちは", "みなさん!", "お母さん、ありがとう", "お疲れ様です", "田中さんが言ってた話", "それでいいです"]) no(t, "ja");
  });
  it("中文:我是 / 我叫", () => {
    yes("大家好,我是小明", "zh", "intro", "小明");
    yes("我叫李华。", "zh", "intro", "李华");
    yes("我的名字是王芳", "zh", "intro", "王芳");
    for (const t of ["我是说这个不行", "我是觉得还好", "我是不是忘了", "我在家", "今天天气很好"]) no(t, "zh");
  });
  it("英语:I'm X / my name is / X, what do you think", () => {
    yes("Hi everyone, I'm Alice.", "en", "intro", "Alice");
    yes("my name is bob", "en", "intro", "bob");
    yes("This is Carol from the newsroom", "en", "intro", "Carol");
    yes("Dave, what do you think?", "en", "call", "Dave");
    yes("So Erin, how was the trip?", "en", "call", "Erin");
    yes("What do you think, Frank?", "en", "call", "Frank");
    for (const t of ["I'm not sure", "I'm going home", "I'm Sorry about that", "Well, what do you think?", "Yeah, what do you mean", "That is great.", "I'm so happy"]) no(t, "en");
  });
  it("auto 全试;语言指定时只试那种", () => {
    yes("我叫李华", "auto", "intro"); yes("I'm Alice", "auto", "intro"); yes("田中さん、", "auto", "call");
    no("I'm Alice", "ja"); no("我叫李华", "en");
  });
  it("模板人名:名字后跟敬称/逗号/问号是点名,跟です/我是是自我介绍,返回原文名", () => {
    const people = [{ src: "上田麗奈", reading: "うえだれいな" }, { src: "Ann", reading: "" }, { src: "张伟", reading: "zhang wei" }];
    expect(detectCue("上田麗奈です", "ja", people)).toEqual({ kind: "intro", name: "上田麗奈" });
    expect(detectCue("うえだれいなさん、お願いします", "ja", people)).toEqual({ kind: "call", name: "上田麗奈" });
    expect(detectCue("ann, thoughts?", "en", people)).toEqual({ kind: "call", name: "Ann" });
    expect(detectCue("我是张伟", "zh", people)).toEqual({ kind: "intro", name: "张伟" });
    expect(detectCue("张伟,你觉得呢", "zh", people)).toEqual({ kind: "call", name: "张伟" });
    expect(detectCue("Annual report is out", "en", people)).toBeNull(); // 词边界
    expect(detectCue("", "ja", people)).toBeNull();
  });
});
