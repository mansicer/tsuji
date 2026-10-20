import { describe, expect, it } from "vitest";
import { evaluate, formatReport, hungarian, type EvalLine, type RefSeg } from "../src/spk/live-eval";

// 参考:kal 0–10 s,awb 10–20 s,kal 20–30 s,slt 30–40 s
const REF: RefSeg[] = [
  { start: 0, end: 10_000, speaker: "kal" }, { start: 10_000, end: 20_000, speaker: "awb" },
  { start: 20_000, end: 30_000, speaker: "kal" }, { start: 30_000, end: 40_000, speaker: "slt" },
];
const L = (aStart: number, aEnd: number, label: string | null, history?: EvalLine["history"]): EvalLine => ({ aStart, aEnd, label, history });
// 每段两句
const lines = (labels: (string | null)[]) => labels.map((lb, i) => L(i * 5000 + 200, i * 5000 + 4800, lb));

describe("hungarian", () => {
  it("最大化总权重,一对一", () => {
    expect(hungarian([[5, 9], [10, 1]])).toEqual([1, 0]);
    expect(hungarian([[1, 2, 3], [3, 1, 2]])).toEqual([2, 0]);
    expect(hungarian([[4], [7], [1]])).toEqual([-1, 0, -1]); // 行比列多
    expect(hungarian([[0, 0], [0, 3]])).toEqual([-1, 1]); // 权重 0 不配
    expect(hungarian([])).toEqual([]);
  });
});

describe("evaluate", () => {
  it("组字母全对:映射到各自的人", () => {
    const r = evaluate(lines(["A", "A", "B", "B", "A", "A", "C", "C"]), REF);
    expect(r.accuracy).toBe(1); expect(r.coverage).toBe(1); expect(r.correct).toBe(8);
    expect(r.mapping.map((m) => [m.label, m.speaker, m.lines, m.pinned])).toEqual([["A", "kal", 4, false], ["B", "awb", 2, false], ["C", "slt", 2, false]]);
    expect(r.mapping[0].overlap).toBeCloseTo(4 * 4600);
    expect(r.speakers.map((s) => [s.speaker, s.lines, s.accuracy])).toEqual([["awb", 2, 1], ["kal", 4, 1], ["slt", 2, 1]]);
  });
  it("没有任何标签:准确率为空,覆盖率 0", () => {
    const r = evaluate(lines([null, null, null, null]), REF);
    expect(r.labelled).toBe(0); expect(r.accuracy).toBeNull(); expect(r.coverage).toBe(0);
    expect(r.churn).toBeNull(); expect(r.mapping).toEqual([]);
    expect(r.speakers.find((s) => s.speaker === "kal")!.coverage).toBe(0);
    expect(formatReport(r)).toContain("accuracy –");
  });
  it("空输入", () => {
    const r = evaluate([], []);
    expect(r.lines).toBe(0); expect(r.coverage).toBeNull(); expect(r.accuracy).toBeNull(); expect(r.speakers).toEqual([]);
    expect(typeof formatReport(r)).toBe("string");
  });
  it("名字叫错全错:同名直接对应,不会被重新映射成对的", () => {
    // kal 的句标成 awb,awb 的句标成 kal
    const r = evaluate(lines(["awb", "awb", "kal", "kal"]), REF);
    expect(r.accuracy).toBe(0); expect(r.correct).toBe(0);
    expect(r.mapping.every((m) => m.pinned)).toBe(true);
    // 关掉 byName 就按重叠映射(把置换当成对的)
    expect(evaluate(lines(["awb", "awb", "kal", "kal"]), REF, { byName: false }).accuracy).toBe(1);
  });
  it("字母全错:一对一映射下,同一个标签贯穿两个人", () => {
    // A 标了 kal 和 awb 各两句,一对一只能配一个人
    const r = evaluate(lines(["A", "A", "A", "A"]), REF);
    expect(["kal", "awb"]).toContain(r.mapping[0].speaker); // 各 2 句,平手
    expect(r.accuracy).toBe(0.5);
  });
  it("字母与名字混用(排列不同也对)", () => {
    const r = evaluate(lines(["B", "B", "Awb", "awb", "kal", "B", "slt", "Z"]), REF);
    const m = Object.fromEntries(r.mapping.map((x) => [x.label, x.speaker]));
    // 一对一:kal 已被同名标签占了,B 配不上
    expect(m).toEqual({ B: null, Awb: "awb", awb: "awb", kal: "kal", slt: "slt", Z: null });
    expect(r.correct).toBe(4); expect(r.accuracy).toBeCloseTo(4 / 8);
    // 多对一:B 也归 kal、Z 归 slt(字母和名字指同一人)
    const many = evaluate(lines(["B", "B", "Awb", "awb", "kal", "B", "slt", "Z"]), REF, { mode: "many-to-one" });
    expect(Object.fromEntries(many.mapping.map((x) => [x.label, x.speaker]))).toEqual({ B: "kal", Awb: "awb", awb: "awb", kal: "kal", slt: "slt", Z: "slt" });
    expect(many.correct).toBe(8);
    // 纯字母的排列:C/A/B 换着用也全对
    expect(evaluate(lines(["C", "C", "A", "A", "C", "C", "B", "B"]), REF).accuracy).toBe(1);
  });
  it("一对一 vs 多对一:组被分裂成两个字母", () => {
    const ls = lines(["A", "A", "B", "B", "C", "C", "D", "D"]);
    const one = evaluate(ls, REF), many = evaluate(ls, REF, { mode: "many-to-one" });
    expect(one.accuracy).toBe(6 / 8); expect(one.mapping.find((m) => m.speaker === null)!.label).toMatch(/[AC]/);
    expect(many.accuracy).toBe(1); expect(many.mapping.map((m) => m.speaker)).toEqual(["kal", "awb", "kal", "slt"]);
  });
  it("没有参考重叠的句:计入覆盖率,不计准确率", () => {
    const ls = [...lines(["A", "A"]), L(50_000, 52_000, "A"), L(60_000, 61_000, null)];
    const r = evaluate(ls, REF);
    expect(r.unref).toBe(2); expect(r.scored).toBe(2); expect(r.accuracy).toBe(1); expect(r.coverage).toBe(0.75);
    expect(r.perLine[2]).toMatchObject({ refs: [], ok: null, mapped: "kal" });
    expect(formatReport(r)).toContain("2 without reference");
  });
  it("参考段重叠:取重叠最多的人;完全平手两个都算对;同一人的重叠段不重复计", () => {
    const ref: RefSeg[] = [
      { start: 0, end: 6000, speaker: "kal" }, { start: 4000, end: 10_000, speaker: "awb" },
      { start: 20_000, end: 25_000, speaker: "rms" }, { start: 21_000, end: 24_000, speaker: "rms" }, { start: 20_000, end: 23_000, speaker: "slt" },
    ];
    const r = evaluate([L(0, 5000, "A"), L(5000, 10_000, "B"), L(3000, 7000, "B"), L(20_000, 25_000, "C")], ref);
    expect(r.perLine.map((x) => x.refs)).toEqual([["kal"], ["awb"], ["awb", "kal"], ["rms"]]);
    expect(r.perLine.map((x) => x.ok)).toEqual([true, true, true, true]);
    expect(r.mapping.find((m) => m.label === "C")!.overlap).toBe(5000); // rms 两段合并后是 5 s,不是 8 s
  });
  it("长度为 0 的句按时间点算", () => {
    const r = evaluate([L(12_000, 12_000, "awb")], REF);
    expect(r.perLine[0].refs).toEqual(["awb"]); expect(r.accuracy).toBe(1);
  });
  it("churn:第一次出标签之后改了几次;出标签的延迟", () => {
    const ls = [
      L(0, 4000, "A", [{ at: 4500, label: "A" }]), // 不改,延迟 0.5 s
      L(5000, 9000, "kal", [{ at: 8000, label: null }, { at: 10_000, label: "B" }, { at: 12_000, label: "A" }, { at: 15_000, label: "kal" }]), // 改 2 次,延迟 1 s
      L(10_000, 14_000, "B", [{ at: 17_000, label: "A" }, { at: 16_000, label: "B" }]), // 乱序,排好后 B → A,最终 B 补上:改 2 次,延迟 2 s
      L(15_000, 19_000, null, [{ at: 20_000, label: "B" }, { at: 21_000, label: null }]), // 出过又撤:改 1 次,延迟 1 s
      L(20_000, 24_000, "A"), // 没有 history:不改,没有延迟
      L(25_000, 29_000, null), // 从没标过,不计 churn
    ];
    const r = evaluate(ls, REF);
    expect(r.perLine.map((x) => x.changes)).toEqual([0, 2, 2, 1, 0, 0]);
    expect(r.changes).toBe(5); expect(r.churned).toBe(3); expect(r.churn).toBeCloseTo(5 / 5);
    expect(r.perLine.map((x) => x.ttfl)).toEqual([500, 1000, 2000, 1000, null, null]);
    expect(r.ttfl).toEqual({ n: 4, mean: 1125, median: 1000, p90: 2000, max: 2000 });
  });
  it("按说话人明细:被标成了谁", () => {
    const r = evaluate(lines(["A", "B", "B", "B", null, "A", "C", "C"]), REF);
    const kal = r.speakers.find((s) => s.speaker === "kal")!;
    expect(kal).toMatchObject({ lines: 4, labelled: 3, correct: 2, coverage: 0.75 });
    expect(kal.accuracy).toBeCloseTo(2 / 3);
    expect(kal.as).toEqual({ kal: 2, awb: 1 });
  });
  it("formatReport 包含主要数字", () => {
    const r = evaluate(lines(["A", "A", "B", null]), REF);
    const s = formatReport(r);
    expect(s).toContain("labelled 3 (coverage 75.0%)");
    expect(s).toContain("correct 3/3 (accuracy 100.0%)");
    expect(s).toContain("A → kal");
    expect(s).toMatch(/kal: 2 2 2 100\.0% 100\.0%/);
  });
});
