// 实时说话人的 GPT 判定循环:按 nextJudgeDelay 的自适应节奏,把上次调用之后的新字幕 + 各组摘要发给 GPT,
// 拿回每组的名字和依据,经 propose()(applyNames 优先级)写回。只在实时收听时运行;出错只退避,不往界面抛
import type { GlossEntry } from "../glossary";
import type { Template } from "../state";
import type { Usage } from "../cost";
import { nextJudgeDelay, JUDGE_SCHED, type JudgeCall, type NameSrc, type SchedEvent } from "./live-schedule";

/** spk/live.ts 的 LiveSpkApi 里本模块用到的部分(见 docs/live-speaker.md,结构相同即可) */
export interface JudgeApiGroup { id: number; letter: string; name: string | null; src: NameSrc | null; dur: number }
export interface JudgeApiLine { id: number; text: string; g: number | null; aStart: number }
export interface LiveJudgeApi {
  groups(): JudgeApiGroup[];
  linesSince(at: number): JudgeApiLine[];
  uncertain(): number;
  events(): SchedEvent[];
  propose(p: { id: number; name: string; src: NameSrc }[]): { changed: boolean };
}
export interface LiveJudgeCfg { ctModel: string; apiBase: string; tpl: Pick<Template, "description" | "spkNotes">; glossary: { people: GlossEntry[] } }
export interface LiveJudgeDeps {
  api: () => LiveJudgeApi | null;
  cfg: () => LiveJudgeCfg;
  apiHeaders: () => Record<string, string>;
  addMtCost: (model: string, u: Usage | undefined) => void;
  /** 墙钟 ms(和 events() 的 at 同一来源);测试里换成假时钟 */
  now?: () => number;
  fetch?: typeof fetch;
}

export const LIVE_JUDGE = {
  /** 轮询间隔:看有没有新组、线索等事件,重新算延迟 */
  poll: 2_000,
  /** 出错退避:30 s 起翻倍,最多 5 分钟 */
  errBase: 30_000,
  errMax: 300_000,
  /** 一次最多发这么多句(取最新的) */
  maxLines: 200,
  /** 查新句时往回多看这么久的音频(句子 aStart 可能早于上次最新的一句),再按句号去重 */
  slack: 60_000,
  /** 推理强度:窗口小、调用频繁,用 low(文件判定一次判全部,用 medium) */
  effort: "low",
};

type Evidence = "intro" | "called" | "context" | "none";
const EVIDENCE: Evidence[] = ["intro", "called", "context", "none"];

const SYSTEM = `You name the speakers of a live recording (radio show, talk, meeting) while it is happening.
A speaker-embedding model clusters voices into groups A, B, C, ... A group is usually one person but can mix people with similar voices. You get a summary of every group (seconds of speech, current name and where it came from) and only the subtitle lines recognised since your previous call, each tagged with its group ("[B]", or "[B: Name]" when the group is already named, "[?]" when no group).
For each group decide its name:
- evidence "intro": in these lines the group's speaker introduces themself by name.
- evidence "called": someone addresses this person by name and the group's speaker answers right after.
- evidence "context": strong but indirect evidence (hosting/reading the script as the known host, speaker cues from the template, turn-taking). Use only when fairly sure.
- evidence "none" with name null: no new evidence. This is the normal answer; keep a group's current name by returning null/none unless these lines clearly show it is wrong.
Rules:
- Change a name only with clear evidence in these lines. Prefer no name over a wrong one; never invent names.
- {PEOPLE}
- Never rename a group marked "locked" (named by the user or matched to a saved voiceprint); return null/none for it.
- A voice actor's own voice can belong to the character they play (and vice versa): pick the actor or character name according to how people introduce themselves in this recording.
- Two groups may be the same person. Return one entry per listed group, using its letter as id.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["groups"],
  properties: {
    groups: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "evidence"],
      properties: { id: { type: "string" }, name: { type: ["string", "null"] }, evidence: { type: "string", enum: EVIDENCE } } } },
  },
};

const SRC_LABEL: Record<NameSrc, string> = { manual: "named by user", library: "voice library match", "gpt-evidence": "from your earlier evidence", "gpt-guess": "your earlier guess" };
const locked = (g: JudgeApiGroup) => g.src === "manual" || g.src === "library";

/** 组摘要 + 新句 → user 消息 */
export function liveJudgePrompt(c: LiveJudgeCfg, groups: JudgeApiGroup[], lines: JudgeApiLine[]): string {
  const people = c.glossary.people.map((p) => "- " + [p.src, p.reading && "reading: " + p.reading, p.tgt && "translation: " + p.tgt, p.notes && "notes: " + p.notes].filter(Boolean).join(" | ")).join("\n");
  const gs = groups.map((g) => `- ${g.letter}: ${Math.round(g.dur)} s of speech, ` + (g.name ? `name: ${g.name} (${g.src ? SRC_LABEL[g.src] : "?"})` : "unnamed") + (locked(g) ? ", locked" : "")).join("\n");
  const by = new Map(groups.map((g) => [g.id, g]));
  const tag = (id: number | null) => { const g = id == null ? null : by.get(id); return !g ? "[?]" : g.name ? `[${g.letter}: ${g.name}]` : `[${g.letter}]`; };
  return [
    c.tpl.description && "Background:\n" + c.tpl.description,
    c.tpl.spkNotes && "Speaker cues:\n" + c.tpl.spkNotes,
    "Known people:\n" + (people || "(none)"),
    "Voice groups:\n" + gs,
    "New lines:\n" + lines.map((l) => `${tag(l.g)} ${l.text}`).join("\n"),
  ].filter(Boolean).join("\n\n");
}

/** GPT 回复 → 提案。有出演者名单时只收名单里的名字(读音/译文也认,换成原文);没有名单时只收 intro/called;锁定的组不提 */
export function parseLiveJudge(r: unknown, groups: JudgeApiGroup[], people: GlossEntry[]): { id: number; name: string; src: NameSrc }[] {
  const out: { id: number; name: string; src: NameSrc }[] = [];
  const list = (r && typeof r === "object" && Array.isArray((r as { groups?: unknown }).groups) ? (r as { groups: unknown[] }).groups : []);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const canon = (n: string): string | null => {
    if (!people.length) return n.trim() || null;
    const k = norm(n);
    const p = people.find((p) => [p.src, p.reading, p.tgt].some((x) => x && norm(x) === k));
    return p ? p.src : null;
  };
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const { id, name, evidence } = x as { id?: unknown; name?: unknown; evidence?: unknown };
    const g = groups.find((g) => g.letter === String(id ?? "").trim().toUpperCase());
    if (!g || locked(g) || typeof name !== "string" || !name.trim()) continue;
    if (evidence !== "intro" && evidence !== "called" && evidence !== "context") continue;
    if (evidence === "context" && !people.length) continue; // 没有名单时的猜测太容易编名字
    const nm = canon(name);
    if (!nm || out.some((o) => o.id === g.id)) continue;
    out.push({ id: g.id, name: nm, src: evidence === "context" ? "gpt-guess" : "gpt-evidence" });
  }
  return out;
}

// —— 循环状态 ——
let D: LiveJudgeDeps | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let gen = 0;
let busy = false;
let curApi: LiveJudgeApi | null = null;
let calls: JudgeCall[] = [];
let lastId = -Infinity, lastA = -Infinity, uncertainAtLast = 0;
let errN = 0, errUntil = -Infinity;
let ctrl: AbortController | null = null;

const nowOf = () => (D!.now || Date.now)();
function reset(api: LiveJudgeApi | null) { curApi = api; calls = []; lastId = -Infinity; lastA = -Infinity; uncertainAtLast = 0; errN = 0; errUntil = -Infinity; }
function arm(ms: number) { if (timer) clearTimeout(timer); timer = setTimeout(tick, Math.max(0, Math.min(ms, LIVE_JUDGE.poll))); }
function fresh(api: LiveJudgeApi): JudgeApiLine[] {
  return api.linesSince(lastA === -Infinity ? 0 : lastA - LIVE_JUDGE.slack).filter((l) => l.id > lastId && l.text.trim());
}

/** 测试/调试用:当前调用记录 */
export function liveJudgeCalls(): readonly JudgeCall[] { return calls; }

function tick() {
  timer = null;
  if (!D) return;
  const my = gen;
  try {
    const api = D.api();
    if (api !== curApi) reset(api); // 换了一次实时会话:从头来
    if (!api || busy) return arm(LIVE_JUDGE.poll);
    const now = nowOf();
    if (now < errUntil) return arm(errUntil - now);
    calls = calls.filter((c, i) => c.at > now - JUDGE_SCHED.hour || i >= calls.length - 8);
    const groups = api.groups(), lines = fresh(api);
    const d = nextJudgeDelay({ groups, calls, linesSince: lines.length, uncertain: api.uncertain(), uncertainAtLast, events: api.events() }, now);
    if (d == null || d > 0) return arm(d ?? LIVE_JUDGE.poll);
    void run(api, groups, lines, now, my);
  } catch (e) { console.error(e); arm(LIVE_JUDGE.poll); }
}

async function run(api: LiveJudgeApi, groups: JudgeApiGroup[], lines: JudgeApiLine[], at: number, my: number) {
  const deps = D!, c = deps.cfg(), sent = lines.slice(-LIVE_JUDGE.maxLines), unc = api.uncertain();
  busy = true; ctrl = new AbortController();
  try {
    const people = c.glossary.people;
    const sys = SYSTEM.replace("{PEOPLE}", people.length ? "Use only names from the known people list, spelled exactly as listed (original spelling)." : "There is no known people list: give a name only when someone states it in these lines (intro/called).");
    const res = await (deps.fetch || fetch)(c.apiBase + "/chat/completions", { method: "POST", headers: deps.apiHeaders(), signal: ctrl.signal, body: JSON.stringify({
      model: c.ctModel, reasoning_effort: LIVE_JUDGE.effort, messages: [{ role: "system", content: sys }, { role: "user", content: liveJudgePrompt(c, groups, sent) }],
      response_format: { type: "json_schema", json_schema: { name: "live_speakers", strict: true, schema: SCHEMA } } }) });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    deps.addMtCost(c.ctModel, data.usage);
    if (my !== gen) return;
    const props = parseLiveJudge(JSON.parse(data.choices[0].message.content), groups, people);
    if (my !== gen || api !== curApi) return;
    const changed = props.length ? api.propose(props).changed : false;
    calls.push({ at, changed });
    // 这次没发出去的旧句(超过 maxLines 的)也算看过,不再补发
    lastId = Math.max(lastId, ...lines.map((l) => l.id)); lastA = Math.max(lastA, ...lines.map((l) => l.aStart));
    uncertainAtLast = unc; errN = 0; errUntil = -Infinity;
  } catch (e) {
    if (my !== gen) return;
    console.warn("live judge:", e);
    errUntil = nowOf() + Math.min(LIVE_JUDGE.errMax, LIVE_JUDGE.errBase * 2 ** errN++);
  } finally {
    if (my === gen) { busy = false; ctrl = null; arm(0); }
  }
}

/** 实时收听开始时调用(重复调用 = 先停再开) */
export function startLiveJudge(deps: LiveJudgeDeps): void {
  stopLiveJudge();
  D = deps; reset(null); arm(0);
}
/** 实时收听停止时调用:清定时器,丢弃进行中的请求结果 */
export function stopLiveJudge(): void {
  gen++;
  if (timer) clearTimeout(timer);
  timer = null; ctrl?.abort(); ctrl = null; busy = false; D = null; reset(null);
}
