// 说话人的 LLM 判定:声纹分组给出每句的候选分布,LLM 结合字幕文本、上下文和模板(出演者、说话人线索)
// 给每组起名、给每句定最终说话人。能确定名字就给名字,否则给组号;依据(basis)一并返回。

export interface JudgeLine {
  id: number;
  s: number; // 秒
  e: number;
  text: string;
  /** 声纹候选:[组号, 占比],按占比从高到低,最多两个;空 = 没有声纹结果 */
  voice: [number, number][];
  /** 这句本身没有声音片段,voice 取自前后最近的片段,距离(秒) */
  near?: number;
}
export interface JudgeGroup {
  /** 组号(0 起) */
  k: number;
  /** 用户起的名字(优先级最高,LLM 不得改) */
  name: string;
  dur: number;
  /** 和模板声纹库里某人的声音很像(之前确认过名字、存下的声纹) */
  lib?: { name: string; sim: number };
}
export interface JudgeInput {
  lines: JudgeLine[];
  groups: JudgeGroup[];
  /** 模板:背景、说话人线索、出演者(原文 | 读音 | 译文 | 备注) */
  description: string;
  spkNotes: string;
  people: { src: string; reading: string; tgt: string; notes: string }[];
  /** 声纹认定为可信的占比(和面板上的「一句最少占比」一致) */
  share: number;
}
export const BASES = ["voice", "self_intro", "addressed", "turn_taking", "content", "unknown"] as const;
export type Basis = (typeof BASES)[number];
export interface JudgeOutput {
  /** 组号 → 名字(无法确定为空串)及依据的句号 */
  groups: { k: number; name: string; evidence: number[] }[];
  /** 句号 → 说话人(出演者原文名、"G<n>" 组号,或 "" = 无法判断)及依据 */
  lines: Map<number, { who: string; basis: Basis }>;
}
type Chat = (system: string, user: string, schema: object) => Promise<any>;

const SYSTEM = `You decide who speaks each subtitle line of a recording (radio show, talk, meeting).
Inputs:
- Background and speaker cues from the user's template, and the list of known people (the only names you may use).
- Voice groups G1, G2, ... from a speaker-embedding model (clustering of voices). A group is usually one person but can mix people with similar voices; small groups may be noise. A group may already carry a name the user assigned: that name is fixed. A group may also match a voiceprint saved from earlier recordings ("voice library match"): strong evidence of the same physical voice, but a voice actor's own voice can match the character they voice (and vice versa), so pick the actor or character name according to how people introduce themselves in this recording.
- Each line: id, time, voice evidence ("G2 80% / G1 20%" = share of the line's speech assigned to each group; "G2 (nearest clip, 0.8 s away)" = the line's own timing had no voice clip, this is the closest one and is weaker evidence; "none" = no voice evidence) and the recognized text.

Step 1, name the groups: for each group decide which known person it is, using self-introductions, being addressed by name and answering, hosting/reading the script, and the speaker cues. Give the line ids you relied on. Leave the name empty when unsure; never invent names; two groups may map to the same person.
Step 2, label every line: "who" is a known person's name exactly as listed, or "G<n>" when the voice group is clear but its person is unknown, or "" when you cannot tell.
- When the voice evidence is strong (top share >= {SHARE}), keep that group/person unless the text gives explicit contrary evidence (the line is a self-introduction of someone else, or the line answers a question addressed to someone else by name).
- When voice evidence is weak, mixed or missing, decide from the conversation: who was just addressed, question/answer turn-taking, who is hosting, content and speaker cues.
- A line containing two speakers: choose the one who says most of it.
basis: voice (followed voice evidence), self_intro, addressed (answers being called/asked), turn_taking, content (topic/style/speaker cues), unknown.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["groups", "lines"],
  properties: {
    groups: { type: "array", items: { type: "object", additionalProperties: false, required: ["group", "name", "evidence"],
      properties: { group: { type: "string" }, name: { type: "string" }, evidence: { type: "array", items: { type: "integer" } } } } },
    lines: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "who", "basis"],
      properties: { id: { type: "integer" }, who: { type: "string" }, basis: { type: "string", enum: BASES } } } },
  },
};

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const gname = (k: number) => "G" + (k + 1);

export function judgePrompt(inp: JudgeInput, lines = inp.lines): string {
  const people = inp.people.map((p) => "- " + [p.src, p.reading && "reading: " + p.reading, p.tgt && "translation: " + p.tgt, p.notes && "notes: " + p.notes].filter(Boolean).join(" | ")).join("\n");
  const groups = inp.groups.map((g) => `- ${gname(g.k)}: ${Math.round(g.dur)} s of speech` + (g.name ? `, named by user: ${g.name}` : "") + (g.lib ? `, voice library match: ${g.lib.name} (cosine ${g.lib.sim.toFixed(2)})` : "")).join("\n");
  const body = lines.map((l) => `#${l.id} [${clock(l.s)}-${clock(l.e)}] voice: ${!l.voice.length ? "none" : l.near != null ? `${gname(l.voice[0][0])} (nearest clip, ${l.near.toFixed(1)} s away)` : l.voice.map(([k, p]) => `${gname(k)} ${Math.round(p * 100)}%`).join(" / ")} | ${l.text}`).join("\n");
  return [
    inp.description && "Background:\n" + inp.description,
    inp.spkNotes && "Speaker cues:\n" + inp.spkNotes,
    "Known people:\n" + (people || "(none)"),
    "Voice groups:\n" + groups,
    "Lines:\n" + body,
  ].filter(Boolean).join("\n\n");
}

/** 一次请求判完(几百句以内);更长的按窗口分批,组名用第一批的结论 */
export async function judgeSpeakers(inp: JudgeInput, chat: Chat, win = 400): Promise<JudgeOutput> {
  const system = SYSTEM.replace("{SHARE}", Math.round(inp.share * 100) + "%");
  const names = new Set(inp.people.map((p) => p.src).concat(inp.groups.map((g) => g.name).filter(Boolean)));
  const out: JudgeOutput = { groups: [], lines: new Map() };
  const parseWho = (w: string) => (names.has(w) || /^G\d+$/.test(w) ? w : "");
  for (let a = 0; a < inp.lines.length; a += win) {
    const part = inp.lines.slice(Math.max(0, a - 20), a + win); // 前面多带 20 句作上下文
    let user = judgePrompt(inp, part);
    if (out.groups.length) user += "\n\nGroup names decided earlier (keep them): " + out.groups.filter((g) => g.name).map((g) => `${gname(g.k)} = ${g.name}`).join(", ");
    const r = await chat(system, user, SCHEMA);
    if (!out.groups.length) out.groups = r.groups.map((g: any) => ({ k: Number(String(g.group).replace(/\D/g, "")) - 1, name: names.has(g.name) ? g.name : "", evidence: g.evidence || [] })).filter((g: any) => g.k >= 0 && g.k < inp.groups.length);
    for (const l of r.lines) if (l.id >= (inp.lines[a]?.id ?? -Infinity) || !out.lines.has(l.id)) out.lines.set(l.id, { who: parseWho(l.who), basis: BASES.includes(l.basis) ? l.basis : "unknown" });
  }
  return out;
}
export { SCHEMA as JUDGE_SCHEMA };

/**
 * 组名校对:GPT 给整组起的名字有时和它逐句的判定对不上(例如两组都叫同一个人,而句子却标成了别人)。
 * 对每组看「声纹确定属于该组」的句子,GPT 逐句判定的多数人若是别人、且占 60% 以上(至少 3 句),就以逐句多数为准。
 */
export function reconcileGroupNames(lines: JudgeLine[], out: JudgeOutput, share: number, nGroups: number): string[] {
  const names = Array.from({ length: nGroups }, (_, k) => out.groups.find((g) => g.k === k)?.name || "");
  const toName = (w: string) => (/^G\d+$/.test(w) ? names[Number(w.slice(1)) - 1] || "" : w);
  for (let k = 0; k < nGroups; k++) {
    const c: Record<string, number> = {}; let n = 0;
    for (const l of lines) {
      if (l.near != null || !l.voice.length || l.voice[0][0] !== k || l.voice[0][1] < share - 1e-9) continue;
      const w = toName(out.lines.get(l.id)?.who || ""); if (!w) continue;
      c[w] = (c[w] || 0) + 1; n++;
    }
    const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3 && top[1] / n >= 0.6) names[k] = top[0];
  }
  // 重名:几组叫同一个人时,只有确有句子支持(该组声纹确定的句子里 GPT 也判成这个人,至少 3 句)的组保留名字,其余清空
  const support = names.map((nm, k) => (nm ? lines.filter((l) => l.near == null && l.voice.length && l.voice[0][0] === k && l.voice[0][1] >= share - 1e-9 && toName(out.lines.get(l.id)?.who || "") === nm).length : 0));
  for (let k = 0; k < nGroups; k++) {
    if (!names[k] || names.filter((x) => x === names[k]).length < 2) continue;
    if (support[k] < 3) names[k] = "";
  }
  return names;
}
