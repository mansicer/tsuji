// spk/live.ts 的流水线(换会话、防抖保存、gen 变化后续跑、模型加载失败、读组的竞争):DOM、IndexedDB、模型都换成假的
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spkNorm, SPK_DIM } from "../src/spk/core";

type Fn = (...a: any[]) => any;
const H = vi.hoisted(() => {
  const fakeEl = (): any => ({ hidden: false, textContent: "", style: { setProperty() {} }, classList: { toggle() {} }, querySelector: () => null, prepend() {}, remove() {}, append() {} });
  return {
    fakeEl, els: {} as Record<string, any>,
    db: new Map<string, unknown>(), gets: [] as string[], puts: [] as string[],
    /** 不为空时 idb.get 用它(测读组的竞争) */
    getImpl: null as null | ((k: string) => Promise<unknown>),
    loadImpl: (() => Promise.resolve()) as () => Promise<void>,
    embedImpl: null as null | ((pcm: Float32Array) => Promise<Float32Array>),
    embeds: 0, loads: 0,
    spkOn: true, now: 0, onLine: null as null | ((l: any) => void),
    state: { running: true, curSess: null as any, sessions: [] as any[] },
    lines: [] as any[], who: new Map<number, number>(),
  };
});
vi.mock("../src/dom", () => ({ $: (s: string) => (H.els[s] ||= H.fakeEl()), el: () => H.fakeEl() }));
vi.mock("../src/storage", () => ({ idb: {
  get: (k: string) => { H.gets.push(k); return H.getImpl ? H.getImpl(k) : Promise.resolve(H.db.get(k)); },
  put: (k: string, v: unknown) => { H.puts.push(k); H.db.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
  del: (k: string) => { H.db.delete(k); return Promise.resolve(); },
} }));
vi.mock("../src/spk/engine", () => ({
  loadModel: () => { H.loads++; return H.loadImpl(); },
  embed: (pcm: Float32Array) => { H.embeds++; return H.embedImpl!(pcm); },
}));
vi.mock("../src/speaker-ui", () => ({ spkOn: () => H.spkOn, SPK_COLORS: ["#000"] }));
vi.mock("../src/i18n", () => ({ t: (k: string) => k, CJK: /[぀-鿿]/ }));
vi.mock("../src/subtitle", () => ({ fmtClock: () => "0:00" }));
vi.mock("../src/state", () => ({ state: H.state, cfg: { tpl: { id: "general", source: "en", voices: undefined }, glossary: { people: [] } }, lines: H.lines }));
vi.mock("../src/live-audio", () => ({
  liveAudio: { now: () => H.now, slice: (a: number, b: number) => new Float32Array(Math.round((b - a) * 16)).fill(H.who.get(a) ?? 0) },
  onLineAudio: (cb: Fn) => { H.onLine = cb; return () => {}; },
}));

// 三个说话人,每段加一点噪声
let seed = 3; const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(R(), 1e-12))) * Math.cos(2 * Math.PI * R());
const rv = () => spkNorm(Float32Array.from({ length: SPK_DIM }, gauss));
const SP = [rv(), rv(), rv()];
const voice = (k: number) => { const z = rv(); return spkNorm(Float32Array.from(SP[k], (x, i) => x + 0.3 * z[i])); };

type Live = typeof import("../src/spk/live");
let L: Live, nextId = 0;
const saveLines = vi.fn();
async function fresh(): Promise<Live> {
  vi.resetModules();
  L = await import("../src/spk/live");
  L.initLiveSpk({ saveLines, getTemplate: () => undefined, putTemplate: () => {}, isFileSess: () => false });
  return L;
}
const sess = (id: string) => ({ id, name: id, tplId: "general", source: "en", target: "zh", settings: {}, createdAt: 0, updatedAt: 0, count: 0 });
/** 换到会话 id(null = 没有会话),像 sessions.ts 的 useSession */
function use(id: string | null) {
  H.state.curSess = id ? H.state.sessions.find((x) => x.id === id) || null : null;
  H.lines.length = 0;
  L.liveSpkSession();
}
/** 说话人 k 说了一句 3 秒的话 */
function say(k: number) {
  const id = ++nextId, aStart = id * 5000, l: any = { id, raw: "line " + id, src: "line " + id, tgt: "", t: new Date(), el: H.fakeEl(), done: true, aStart, aEnd: aStart + 3000 };
  H.who.set(aStart, k); H.lines.push(l); H.onLine!(l);
  return l;
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const lspkKeys = () => [...H.db.keys()].filter((k) => k.startsWith("lspk:"));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, body: { append() {} } });
  H.db.clear(); H.gets.length = 0; H.puts.length = 0; H.getImpl = null; H.embeds = H.loads = 0; H.spkOn = true; H.now = 0;
  H.loadImpl = () => Promise.resolve();
  H.embedImpl = (pcm) => Promise.resolve(voice(pcm[0]));
  H.state.running = true; H.state.sessions = [sess("s1"), sess("s2")]; H.state.curSess = null; H.lines.length = 0; H.who.clear();
  for (const k of Object.keys(H.els)) delete H.els[k];
  await fresh();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("session switch and saving", () => {
  it("deleting the current session while an embed is in flight leaves no lspk: key behind", async () => {
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    for (let i = 0; i < 4; i++) say(i % 2);
    await flush();
    expect(L.liveSpkDebug.core.visible().length).toBe(2);
    // 下一句的声纹算到一半:停止收音、删掉会话(sessions.ts:先从列表里删、删 lspk:,再 useSession(null))
    let done!: (v: Float32Array) => void;
    H.embedImpl = () => new Promise((r) => { done = r; });
    say(0); await flush();
    L.liveSpkStop();
    H.state.sessions = H.state.sessions.filter((x) => x.id !== "s1"); H.db.delete("lspk:s1");
    use(null);
    done(voice(0));
    await vi.advanceTimersByTimeAsync(2000);
    expect(lspkKeys()).toEqual([]);
    expect(L.liveSpkDebug.core.visible()).toEqual([]);
  });

  it("a debounced group save is written on session switch and on liveSpkFlush, not dropped", async () => {
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    for (let i = 0; i < 4; i++) say(i % 2);
    await flush();
    L.liveSpkStop(); await vi.advanceTimersByTimeAsync(1000);
    expect(lspkKeys()).toEqual(["lspk:s1"]);
    // 用户改名,600 ms 之内就切走:名字要写进去
    L.liveSpkDebug.rename(0, "Ann");
    use("s2");
    expect((H.db.get("lspk:s1") as any).groups[0].name).toBe("Ann");
    // 回来读到的就是新名字
    use("s1"); await flush();
    expect(L.liveSpkDebug.core.group(0)!.name).toBe("Ann");
    // 关页面前(pagehide → flushLines → liveSpkFlush)
    L.liveSpkDebug.rename(1, "Bo");
    L.liveSpkFlush();
    expect((H.db.get("lspk:s1") as any).groups[1].name).toBe("Bo");
  });

  it("clearing drops the pending save and deletes the groups", async () => {
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    for (let i = 0; i < 4; i++) say(i % 2);
    await flush();
    L.liveSpkClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(lspkKeys()).toEqual([]);
  });

  it("with speaker ID off, switching sessions does not read lspk:, and turning it on reads it once", async () => {
    H.db.set("lspk:s2", { next: 1, groups: [{ id: 0, name: "Zoe", src: "manual", cent: "", dur: 9, n: 3 }] });
    H.spkOn = false;
    use("s1"); use("s2"); await flush();
    expect(H.gets).toEqual([]);
    H.spkOn = true; L.liveSpkToggle(true); await flush();
    L.liveSpkToggle(true); await flush();
    expect(H.gets).toEqual(["lspk:s2"]);
  });

  it("the recluster timer only runs while listening with speaker ID on", async () => {
    use("s1"); await flush();
    const base = vi.getTimerCount();
    L.liveSpkStart(); await flush();
    expect(vi.getTimerCount()).toBe(base + 1);
    L.liveSpkStop(); await flush();
    expect(vi.getTimerCount()).toBe(base);
    L.liveSpkStart(); await flush();
    L.liveSpkToggle(false);
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe("pipeline", () => {
  it("lines wait for the saved groups to load; new groups get ids after the saved ones", async () => {
    // 存过两个组(A = 说话人 0、B = 说话人 1)
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    for (let i = 0; i < 4; i++) say(i % 2);
    await flush(); L.liveSpkStop(); await vi.advanceTimersByTimeAsync(1000);
    // 再进来时读组很慢,句子先到了
    let release!: () => void;
    H.getImpl = (k) => new Promise((r) => { release = () => r(H.db.get(k)); });
    use("s2"); use("s1");
    L.liveSpkStart(); await flush();
    say(2); say(2); say(0);
    await flush();
    expect(H.embeds).toBe(4); // 只有第一轮的四句
    release(); await flush();
    expect(H.embeds).toBe(7);
    const gs = L.liveSpkDebug.core.visible();
    expect(gs.map((g) => g.id)).toEqual([0, 1, 2]);
    expect(H.lines.map((l) => l.lspk && l.lspk.g)).toEqual([2, 2, 0]); // 说话人 2 是新的 C,说话人 0 还是 A
  });

  it("after a gen bump during an embed, lines queued for the new run are processed without waiting for another line", async () => {
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    let done!: (v: Float32Array) => void;
    H.embedImpl = () => new Promise((r) => { done = r; });
    say(0); await flush();
    expect(H.embeds).toBe(1);
    // 关了又开:gen 变了,旧的 pump 还卡在 embed 上;新一轮来了一句
    L.liveSpkToggle(false); L.liveSpkToggle(true);
    H.embedImpl = (pcm) => Promise.resolve(voice(pcm[0]));
    const l = say(1); await flush();
    expect(H.embeds).toBe(1); // 旧的还没完,忙着
    done(voice(0)); await flush();
    expect(H.embeds).toBe(2);
    expect(L.liveSpkDebug.queue).toBe(0);
    expect(l.lspk).toBeTruthy();
  });

  it("a failed model load stops queueing, shows the error, and retries with back-off", async () => {
    let fail = 3;
    H.loadImpl = () => (fail-- > 0 ? Promise.reject(new Error("no wasm")) : Promise.resolve());
    use("s1"); await flush();
    L.liveSpkStart(); await flush();
    expect(H.loads).toBe(1);
    expect(H.els["#lspkInfo"].textContent).toBe("lspk.err");
    for (let i = 0; i < 20; i++) say(i % 2);
    expect(L.liveSpkDebug.queue).toBe(0); // 不排队
    await vi.advanceTimersByTimeAsync(2000); expect(H.loads).toBe(2);
    await vi.advanceTimersByTimeAsync(8000); expect(H.loads).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000); expect(H.loads).toBe(4);
    expect(L.liveSpkDebug.ready).toBe(true);
    say(0); say(0); await flush();
    expect(H.embeds).toBe(2);
    expect(L.liveSpkDebug.core.visible()).toHaveLength(1);
  });

  it("after the retries run out, the next start tries again", async () => {
    H.loadImpl = () => Promise.reject(new Error("no wasm"));
    use("s1"); await flush();
    L.liveSpkStart(); await vi.advanceTimersByTimeAsync(100_000);
    expect(H.loads).toBe(4);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(H.loads).toBe(4); // 放弃了
    L.liveSpkStop();
    H.loadImpl = () => Promise.resolve();
    L.liveSpkStart(); await flush();
    expect(H.loads).toBe(5);
    say(1); await flush();
    expect(H.embeds).toBe(1);
  });
});
