// 实时说话人:什么时候调用 GPT 判定(自适应节奏)、名字来源的优先级、本地的自我介绍/点名线索检测。纯函数,不碰 DOM
// 时间一律是毫秒(音频时钟或 Date.now() 都行,只要同一个来源);组的 dur 是秒(和 judge.ts 一致)

export type NameSrc = "manual" | "library" | "gpt-evidence" | "gpt-guess";

/** 调度用的常量,集中在这里调 */
export const JUDGE_SCHED = {
  /** 冷启动:有组累计说话 ≥ 这么多秒且还没名字,就按冷启动节奏调用 */
  coldDur: 20,
  /** 冷启动间隔:上次调用有改动用短的,没改动用长的(即文档的 30–60 s) */
  coldFast: 30_000,
  coldSlow: 60_000,
  /** 「回到快速」时的间隔(重新聚类合并/拆分、不确定句增多) */
  fast: 30_000,
  /** 退避:连续 1、2、≥3 次没改动时的间隔(1 → 2 → 5 分钟) */
  backoff: [60_000, 120_000, 300_000],
  /** 两次调用之间至少隔这么久,「立即」也要等够(防止新组、线索连发时刷屏) */
  minGap: 10_000,
  /** 不确定句(没给说话人的句)比上次调用时多出这么多句,算「增多」 */
  uncertainRise: 3,
  /** 每小时最多调用次数 */
  hourCap: 40,
  hour: 3_600_000,
};

export interface SchedGroup { id: number; dur: number; name: string | null; src: NameSrc | null }
/** 最近发生的事:新组、重新聚类后的合并/拆分、本地检测到的自我介绍/点名线索 */
export interface SchedEvent { kind: "new-group" | "merge" | "split" | "cue"; at: number }
/** 一次判定调用:发起时间、结果是否改了什么(名字或来源) */
export interface JudgeCall { at: number; changed: boolean }
export interface JudgeStats {
  groups: SchedGroup[];
  /** 历次调用,按时间顺序;至少保留最近一小时(算上限)和最近几次(算退避) */
  calls: JudgeCall[];
  /** 上次调用之后新增的句数(没有调用过 = 全部句数) */
  linesSince: number;
  /** 当前不确定句数,以及上次调用时的不确定句数 */
  uncertain: number;
  uncertainAtLast: number;
  events: SchedEvent[];
}

const RANK: Record<NameSrc, number> = { "gpt-guess": 0, "gpt-evidence": 1, library: 2, manual: 3 };
/** GPT 还能改名字的组(manual、library 的组 GPT 改不了) */
const open = (g: SchedGroup) => !g.src || RANK[g.src] < RANK.library;

/** 距现在多久之后调用判定(ms,0 = 立即);null = 不调用(没有新字幕,或没有 GPT 能改的组) */
export function nextJudgeDelay(st: JudgeStats, now: number, C = JUDGE_SCHED): number | null {
  if (st.linesSince <= 0) return null;
  if (!st.groups.some(open)) return null;
  const last = st.calls.length ? st.calls[st.calls.length - 1].at : -Infinity;
  const since = st.events.filter((e) => e.at > last);
  const cold = st.groups.some((g) => open(g) && !g.name && g.dur >= C.coldDur);
  let at: number;
  if (since.some((e) => e.kind === "new-group" || e.kind === "cue")) at = last + C.minGap; // 立即
  else if (since.length || st.uncertain - st.uncertainAtLast >= C.uncertainRise) at = last + C.fast; // 回到快速
  else {
    if (!st.calls.length && !cold) return null; // 还没人说够 20 秒,先不叫
    // 连续没改动的次数,只数最近一次「重置」事件之后的调用
    const reset = st.events.reduce((m, e) => Math.max(m, e.at), -Infinity);
    let k = 0;
    for (let i = st.calls.length - 1; i >= 0 && !st.calls[i].changed && st.calls[i].at > reset; i--) k++;
    at = last + (cold ? (k ? C.coldSlow : C.coldFast) : C.backoff[Math.min(Math.max(k - 1, 0), C.backoff.length - 1)]);
  }
  // 每小时上限:满了就等最早那次滑出一小时窗口
  const hr = st.calls.filter((c) => c.at > now - C.hour);
  if (hr.length >= C.hourCap) at = Math.max(at, hr[hr.length - C.hourCap].at + C.hour);
  return Math.max(0, Math.max(at, last + C.minGap) - now);
}

/** 名字来源的优先级:manual > library > gpt-evidence > gpt-guess;低的不能盖高的,同级可以更新;manual 锁定(用户改名由界面直接写,不走这里) */
export function canOverride(oldSrc: NameSrc | null, newSrc: NameSrc): boolean {
  if (!oldSrc) return true;
  if (oldSrc === "manual") return false;
  return RANK[newSrc] >= RANK[oldSrc];
}

export interface NameProposal { id: number; name: string; src: NameSrc }
export interface NameChange { id: number; from: { name: string | null; src: NameSrc | null }; to: { name: string; src: NameSrc } }
/** 把 GPT 或声纹库给的一组名字并进组里(按优先级)。不改原数组,返回新组、改动列表、是否有改动 */
export function applyNames<G extends SchedGroup>(groups: G[], proposals: NameProposal[]): { groups: G[]; changes: NameChange[]; changed: boolean } {
  const out = groups.map((g) => ({ ...g })), changes: NameChange[] = [];
  for (const p of proposals) {
    const g = out.find((x) => x.id === p.id), name = p.name.trim();
    if (!g || !name || !canOverride(g.src, p.src)) continue;
    if (g.name === name && g.src === p.src) continue;
    // 同名但来源更低:保留原来源
    if (g.name === name && g.src && RANK[p.src] < RANK[g.src]) continue;
    changes.push({ id: g.id, from: { name: g.name, src: g.src }, to: { name, src: p.src } });
    g.name = name; g.src = p.src;
  }
  return { groups: out, changes, changed: changes.length > 0 };
}

// —— 本地线索检测:自我介绍 / 点名。只是便宜的过滤器,宁可多报,但不能见「です」就报 ——
export interface Cue { kind: "intro" | "call"; name?: string }
export interface CuePerson { src: string; reading?: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_JA = "[\\p{Script=Han}\\p{Script=Katakana}ーA-Za-z]{1,8}|\\p{Script=Hiragana}{2,4}";
const HON_JA = "さん|ちゃん|くん|君|先生|様|せんせい";
// 不是人名的「〜さん」「〜です」:皆さん、お母さん、大丈夫です等
const NOT_NAME_JA = /^(皆|みな|みんな|皆様|お客|客|奥|母|父|姉|兄|妹|弟|赤|お父|お母|お姉|お兄|おにい|おねえ|おじい|おばあ|おじ|おば|ねえ|あの|この|その|どの|誰|だれ|そう|それ|これ|あれ|どう|ここ|大丈夫|以上|本当|了解|正解|結構|問題|元気|最高|無理|一緒|同じ|大変|残念|当然|確か|必要|可能|簡単|有名|自由|普通|特別|心配|安心)$/u;
const GREET_JA = "こんにちは|こんばんは|おはようございます|どうも|はじめまして|初めまして|はい|えー|ええと";
const JA: [Cue["kind"], RegExp][] = [
  ["intro", new RegExp(`(${NAME_JA})\\s*(?:と申します|ともうします|と申す|っていいます|って言います|といいます|と言います)`, "u")],
  ["intro", new RegExp(`(?:私|わたし|わたくし|僕|ぼく|俺|おれ|あたし|うち)(?:は|、|,)\\s*(${NAME_JA})\\s*(?:です|でーす|だよ)`, "u")],
  ["intro", new RegExp(`(?:${GREET_JA})[、,!！。\\s]*(${NAME_JA})\\s*(?:です|でーす|でございます)(?:[。!！、\\s]|$)`, "u")],
  ["intro", new RegExp(`(?:担当|司会|パーソナリティ|MC|アシスタント)の\\s*(${NAME_JA})\\s*(?:です|でーす|でございます)`, "u")],
  // 呼びかけ:「〜さん、」「〜ちゃん!」「〜くんはどう?」、句末的「〜さん」
  ["call", new RegExp(`(${NAME_JA})(?:${HON_JA})(?:[、,!！?？〜ー]|は(?:どう|いかが|どれ|何|なに)|$)`, "u")],
];
// 「我是说」「我是觉得」之类不是自我介绍
const ZH_BAD = "说|不是|觉得|在|想|真|很|有|从|个|一|这|那|的|要|会|也|就|都|还|不|没|对|啊|吧|呢|来|去|当|以|被|把|认为|感觉";
const ZH: [Cue["kind"], RegExp][] = [
  ["intro", new RegExp(`我(?:的名字)?(?:是|叫)(?!${ZH_BAD})\\s*([\\p{Script=Han}A-Za-z·]{1,6})`, "u")],
];
const EN_BAD = new Set(["I", "The", "So", "Just", "Not", "Really", "Sorry", "Here", "Glad", "Back", "Happy", "Going", "Sure", "Very", "Fine", "Good", "Well", "Okay", "Ok", "Yes", "Yeah", "Yep", "No", "Nope", "Oh", "Um", "Uh", "Hmm", "Wow", "Alright", "Like", "Anyway", "And", "But", "Also", "Still", "Gonna", "Excited", "Thrilled", "Afraid", "Actually", "Totally", "A", "An", "In", "On", "At", "With", "From", "Thanks", "Thank", "Hello", "Hi", "Hey", "What", "How", "Why", "Everyone", "Everybody", "Guys", "Folks", "You", "Right", "Now", "Then", "Today", "Honestly", "Seriously", "Listen", "Look", "Please"]);
const EN_PRE = "(?:(?:[Ss]o|[Aa]nd|[Ww]ell|[Oo]kay|OK|[Nn]ow|[Hh]ey|[Bb]ut)[,\\s]+)?";
const EN: [Cue["kind"], RegExp][] = [
  ["intro", /\bmy name(?:'s| is)\s+([A-Za-z][\w'-]*)/i],
  ["intro", /\b(?:I'm|I am|[Tt]his is|[Cc]all me)\s+([A-Z][a-z][\w'-]*)/],
  ["call", new RegExp(`^${EN_PRE}([A-Z][a-z][\\w'-]*)\\s*,\\s*(?:what|how|do|did|are|were|would|could|can|any|tell|your|you)\\b`)],
  ["call", /,\s*([A-Z][a-z][\w'-]*)\s*[?!]\s*$/],
  ["call", /\b(?:[Ww]hat|[Hh]ow) about you,?\s+([A-Z][a-z][\w'-]*)\b/],
];

function scan(text: string, rules: [Cue["kind"], RegExp][], bad: (n: string) => boolean): Cue | null {
  for (const [kind, re] of rules) {
    const m = re.exec(text);
    if (m && !bad(m[1])) return { kind, name: m[1] };
  }
  return null;
}

/** 一句字幕里有没有自我介绍或点名。srcLang:ja / zh / en,其它(含 auto)全都试;people:模板出演者,名字命中就算(返回 people 里的原文名) */
export function detectCue(text: string, srcLang: string, people: CuePerson[] = []): Cue | null {
  const t = text.trim();
  if (!t) return null;
  // 先看模板里的人名:名字 + です/と申します/我是/I'm → 自我介绍;名字 + 敬称、逗号、问号 → 点名
  for (const p of people) {
    for (const n of [p.src, p.reading].map((s) => (s || "").trim()).filter((s) => s.length >= 2)) {
      const N = esc(n), lat = /^[\x20-\x7e]+$/.test(n), b = lat ? "\\b" : "", f = lat ? "iu" : "u";
      if (new RegExp(`(?:私|わたし|僕|ぼく|俺|${GREET_JA}|の)[は、,!！。\\s]*${N}\\s*(?:です|でーす|でございます)|^${N}\\s*(?:です|でーす)|${N}\\s*と申します|我(?:的名字)?(?:是|叫)\\s*${N}|${b}(?:I'm|I am|my name is|this is)\\s+${N}${b}`, f).test(t)) return { kind: "intro", name: p.src };
      if (new RegExp(`${b}${N}${b}\\s*(?:${HON_JA}|老师|姐|哥)?\\s*[、,，!！?？]|${N}\\s*(?:${HON_JA})\\s*$`, f).test(t)) return { kind: "call", name: p.src };
    }
  }
  const all = srcLang !== "ja" && srcLang !== "zh" && srcLang !== "en";
  return (srcLang === "ja" || all ? scan(t, JA, (n) => NOT_NAME_JA.test(n)) : null)
    ?? (srcLang === "zh" || all ? scan(t, ZH, () => false) : null)
    ?? (srcLang === "en" || all ? scan(t, EN, (n) => EN_BAD.has(n[0].toUpperCase() + n.slice(1).toLowerCase())) : null);
}
