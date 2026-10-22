// 实时说话人的 GPT 判定循环:按 nextJudgeDelay 的自适应节奏,把上次调用之后的新字幕(+ 几句旧句作上下文)+ 各组摘要发给 GPT,
// 拿回每组的名字和依据,经 propose()(applyNames 优先级)写回。只在实时收听时运行;出错只退避,不往界面抛
import type { GlossEntry } from "../glossary";
import type { Template } from "../state";
import type { Usage } from "../cost";
import { detectCue, nextJudgeDelay, JUDGE_SCHED, type JudgeCall, type NameSrc, type SchedEvent, type UncWin } from "./live-schedule";

/** spk/live.ts 的 LiveSpkApi 里本模块用到的部分(见 docs/live-speaker.md,结构相同即可) */
export interface JudgeApiGroup { id: number; letter: string; name: string | null; src: NameSrc | null; dur: number }
export interface JudgeApiLine { id: number; text: string; g: number | null; aStart: number }
export interface LiveJudgeApi {
  groups(): JudgeApiGroup[];
  linesSince(at: number): JudgeApiLine[];
  events(): SchedEvent[];
  propose(p: { id: number; name: string; src: NameSrc }[]): { changed: boolean };
}
export interface LiveJudgeCfg { ctModel: string; apiBase: string; tpl: Pick<Template, "description" | "spkNotes"> & Partial<Pick<Template, "source">>; glossary: { people: GlossEntry[] } }
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
  /** 发出去时还没有组([?])的句:这么久(音频时钟)之内一旦有了组就再发一次,超过就算了 */
  pendWin: 60_000,
  /** 线索触发的调用:等线索那句有了组再叫(否则自我介绍只能以 [?] 发出去),最多等这么久(墙钟,从线索事件算) */
  cueWait: 15_000,
  /** 每次附带这么多句已经发过的最近旧句作上下文(名字在上一句、回答在下一句时也能对上) */
  ctxLines: 5,
  /** 算不确定句比例时,最新这么长(音频时钟)的句还在等声纹,不算 */
  settle: 10_000,
  /** 推理强度:窗口小、调用频繁,用 low(文件判定一次判全部,用 medium) */
  effort: "low",
};

type Evidence = "intro" | "called" | "context" | "none";
const EVIDENCE: Evidence[] = ["intro", "called", "context", "none"];

const SYSTEM = `You name the speakers of a live recording (radio show, talk, meeting) while it is happening.
A speaker-embedding model clusters voices into groups A, B, C, ... A group is usually one person but can mix people with similar voices. You get a summary of every group (seconds of speech, current name and where it came from), a few earlier lines you have already seen (context only), and the new subtitle lines since your previous call, each tagged with its group ("[B]", or "[B: Name]" when the group is already named, "[?]" when no group yet). A line you saw earlier as "[?]" may come again among the new lines once its group is known.
For each group decide its name:
- evidence "intro": in the new lines the group's speaker introduces themself by name.
- evidence "called": someone addresses this person by name and the group's speaker answers right after (the call may be in an earlier context line, the answer in a new line).
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

/** 组摘要 + 上下文旧句 + 新句 → user 消息 */
export function liveJudgePrompt(c: LiveJudgeCfg, groups: JudgeApiGroup[], lines: JudgeApiLine[], ctx: JudgeApiLine[] = []): string {
  const people = c.glossary.people.map((p) => "- " + [p.src, p.reading && "reading: " + p.reading, p.tgt && "translation: " + p.tgt, p.notes && "notes: " + p.notes].filter(Boolean).join(" | ")).join("\n");
  const gs = groups.map((g) => `- ${g.letter}: ${Math.round(g.dur)} s of speech, ` + (g.name ? `name: ${g.name} (${g.src ? SRC_LABEL[g.src] : "?"})` : "unnamed") + (locked(g) ? ", locked" : "")).join("\n");
  const by = new Map(groups.map((g) => [g.id, g]));
  const tag = (id: number | null) => { const g = id == null ? null : by.get(id); return !g ? "[?]" : g.name ? `[${g.letter}: ${g.name}]` : `[${g.letter}]`; };
  return [
    c.tpl.description && "Background:\n" + c.tpl.description,
    c.tpl.spkNotes && "Speaker cues:\n" + c.tpl.spkNotes,
    "Known people:\n" + (people || "(none)"),
    "Voice groups:\n" + gs,
    ctx.length && "Earlier lines (context only, already judged):\n" + ctx.map((l) => `${tag(l.g)} ${l.text}`).join("\n"),
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
/** lastId:发过的最大句号;lastA:发过的最晚 aStart;pend:以 [?] 发出去、还年轻的句(句号 → aStart),有了组再补发 */
let lastId = -Infinity, lastA = -Infinity, uncLast: UncWin | null = null;
let pend = new Map<number, number>();
let errN = 0, errUntil = -Infinity;
let ctrl: AbortController | null = null;

const nowOf = () => (D!.now || Date.now)();
function reset(api: LiveJudgeApi | null) { curApi = api; calls = []; lastId = -Infinity; lastA = -Infinity; uncLast = null; pend = new Map(); errN = 0; errUntil = -Infinity; }
function arm(ms: number) { if (timer) clearTimeout(timer); timer = setTimeout(tick, Math.max(0, Math.min(ms, LIVE_JUDGE.poll))); }

interface Batch { lines: JudgeApiLine[]; ctx: JudgeApiLine[]; unc: UncWin; top: number }
/** 这次要发的句:没发过的新句 + 以 [?] 发过、现在有了组的年轻句;外加几句发过的旧句作上下文 */
function collect(api: LiveJudgeApi): Batch {
  const all = api.linesSince(lastA === -Infinity ? 0 : lastA - LIVE_JUDGE.slack).filter((l) => l.text.trim());
  const top = all.reduce((m, l) => Math.max(m, l.aStart), lastA);
  for (const [id, a] of pend) if (top - a >= LIVE_JUDGE.pendWin) pend.delete(id); // 太老了,不再补发
  const lines = all.filter((l) => l.id > lastId || (pend.has(l.id) && l.g != null));
  const ctx = all.filter((l) => l.id <= lastId && !lines.includes(l)).slice(-LIVE_JUDGE.ctxLines);
  // 不确定句比例:只算真正的新句,且最新 settle 内的不算(还在排队等声纹)
  const st = all.filter((l) => l.id > lastId && l.aStart <= top - LIVE_JUDGE.settle);
  return { lines, ctx, unc: { n: st.filter((l) => l.g == null).length, total: st.length }, top };
}
/** 线索触发后,线索那句还没有组:先等(最多 cueWait,从最早一个还没处理的线索事件算) */
function waitCue(b: Batch, events: SchedEvent[], now: number): boolean {
  const last = calls.length ? calls[calls.length - 1].at : -Infinity;
  const cueAt = events.reduce((m, e) => (e.kind === "cue" && e.at > last ? Math.min(m, e.at) : m), Infinity);
  if (cueAt === Infinity || now >= cueAt + LIVE_JUDGE.cueWait) return false;
  const c = D!.cfg();
  return b.lines.some((l) => l.g == null && !!detectCue(l.text, c.tpl.source || "", c.glossary.people));
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
    const groups = api.groups(), b = collect(api), events = api.events();
    const d = nextJudgeDelay({ groups, calls, linesSince: b.lines.length, unc: b.unc, uncLast, events }, now);
    if (d == null || d > 0) return arm(d ?? LIVE_JUDGE.poll);
    if (waitCue(b, events, now)) return arm(LIVE_JUDGE.poll);
    void run(api, groups, b, now, my);
  } catch (e) { console.error(e); arm(LIVE_JUDGE.poll); }
}

async function run(api: LiveJudgeApi, groups: JudgeApiGroup[], b: Batch, at: number, my: number) {
  const deps = D!, c = deps.cfg(), lines = b.lines, sent = lines.slice(-LIVE_JUDGE.maxLines);
  busy = true; ctrl = new AbortController();
  try {
    const people = c.glossary.people;
    const sys = SYSTEM.replace("{PEOPLE}", people.length ? "Use only names from the known people list, spelled exactly as listed (original spelling)." : "There is no known people list: give a name only when someone states it in these lines (intro/called).");
    const res = await (deps.fetch || fetch)(c.apiBase + "/chat/completions", { method: "POST", headers: deps.apiHeaders(), signal: ctrl.signal, body: JSON.stringify({
      model: c.ctModel, reasoning_effort: LIVE_JUDGE.effort, messages: [{ role: "system", content: sys }, { role: "user", content: liveJudgePrompt(c, groups, sent, b.ctx) }],
      response_format: { type: "json_schema", json_schema: { name: "live_speakers", strict: true, schema: SCHEMA } } }) });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    deps.addMtCost(c.ctModel, data.usage);
    if (my !== gen) return;
    const props = parseLiveJudge(JSON.parse(data.choices[0].message.content), groups, people);
    if (my !== gen || api !== curApi) return;
    const changed = props.length ? api.propose(props).changed : false;
    calls.push({ at, changed });
    // 这次没发出去的旧句(超过 maxLines 的)也算看过,不再补发;以 [?] 发出去的年轻句记下来,有了组再补发
    for (const l of lines) {
      lastId = Math.max(lastId, l.id); lastA = Math.max(lastA, l.aStart);
      if (l.g == null && b.top - l.aStart < LIVE_JUDGE.pendWin) pend.set(l.id, l.aStart); else pend.delete(l.id);
    }
    if (b.unc.total >= JUDGE_SCHED.uncertainMin) uncLast = b.unc;
    errN = 0; errUntil = -Infinity;
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
