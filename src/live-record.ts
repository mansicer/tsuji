// C:实时会话录音。MediaRecorder 录转写用的同一个麦克风流,约 10 秒一块存进 IndexedDB(rec:<会话 id>:<段>:<块>),
// 标签页被杀最多丢几秒;停止后可以把录音转成文件会话,走文件的识别、翻译和说话人识别流程。默认关,只对当前会话开
import { state } from "./state";
import type { Session, RecInfo } from "./state";
import { idb, isQuotaError, storageFailed } from "./storage";
import { $, el, flash } from "./dom";
import { t } from "./i18n";
import { fmtClock } from "./subtitle";
import { concatAudio } from "./media";

// ---------- 纯函数 ----------
/** 优先 webm/opus;Safari 只有 mp4 */
export const REC_MIMES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
export const REC_BPS = 32000, REC_SLICE = 10000;
/** 选第一个支持的格式;都不支持就返回 "",交给浏览器默认 */
export function pickMime(ok: (m: string) => boolean): string {
  return REC_MIMES.find((m) => { try { return ok(m); } catch { return false; } }) || "";
}
export function recExt(mime: string): string { return /mp4|aac|m4a/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm"; }
export const recPrefix = (sid: string): string => `rec:${sid}:`;
/** 补零,按字符串排序就是录制顺序 */
export function recKey(sid: string, part: number, n: number): string { return recPrefix(sid) + String(part).padStart(3, "0") + ":" + String(n).padStart(6, "0"); }
/** 从键里取段号;不是录音块的键返回 -1 */
export function recPartOf(key: string): number { const m = /^rec:[^:]+:(\d+):\d+$/.exec(key); return m ? Number(m[1]) : -1; }
export function fmtBytes(n: number): string {
  return n < 1048576 ? Math.max(n > 0 ? 1 : 0, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + " MB";
}
/** 录到的总时长(毫秒,按墙钟) */
export function recDur(rec: RecInfo): number { return rec.parts.reduce((a, p) => a + Math.max(0, p.t1 - p.t0), 0); }
/** 有内容的段数 */
export function recCount(rec: RecInfo | undefined): number { return rec ? rec.parts.filter((p) => p.bytes > 0).length : 0; }
/** IndexedDB 里读出的块(按键排好序)→ 每段一个 Blob;值是 Blob,存不了 Blob 的浏览器存的是 {buf, type} */
export function partBlobs(rec: RecInfo, entries: [string, unknown][]): Blob[] {
  const by = new Map<number, BlobPart[]>();
  for (const [k, v] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const p = recPartOf(k); if (p < 0 || !v) continue;
    const x = v as { buf?: ArrayBuffer };
    (by.get(p) || by.set(p, []).get(p)!).push(x.buf ? x.buf : (v as Blob));
  }
  return [...by.keys()].sort((a, b) => a - b).map((p) => new Blob(by.get(p)!, { type: (rec.parts[p] && rec.parts[p].mime || "audio/webm").split(";")[0] })).filter((b) => b.size > 0);
}

// ---------- 录音 ----------
export interface RecDeps {
  saveSessions(): void;
  /** startMic 建的麦克风流(没在收音时为 null) */
  getStream(): MediaStream | null;
  /** 由录音建文件会话、存好文件并切过去(main.ts 和选文件共用一条路) */
  toFileSession(live: Session, f: File): Promise<Session>;
  /** 会话音频时钟(live-audio.ts);没有就只记墙钟 */
  audioNow?: () => number | null;
  /** 切到某个会话(已经转过的录音直接打开那个文件会话) */
  openSession(id: string): void;
}
let D: RecDeps;
let mr: MediaRecorder | null = null, confirmSid = "", converting = false;
/** 已经叫停、最后一块还没写完的录音:onstop 时最后一次 dataavailable 的写入完成才 resolve */
const flushing = new Set<Promise<void>>();
/** 每个录音的收尾函数;recEnd 后迟迟不来 onstop 时兜底调用,免得「转成文件会话」一直不出来 */
const finish = new Map<MediaRecorder, () => void>();
/** 等所有已停的录音把最后一块写进 IndexedDB */
export function recFlushed(): Promise<void> { return Promise.all([...flushing]).then(() => {}); }

/** 开始新的一段:收音开始、重开麦克风、收音中打开录音时调用。stream 是 startMic 建的那个 */
export function recBegin(stream: MediaStream | null): void {
  const ss = state.curSess;
  if (!stream || !ss || ss.kind === "file" || !ss.rec || !ss.rec.on || !state.running || mr || typeof MediaRecorder === "undefined") return;
  const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  let r: MediaRecorder;
  try { r = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: REC_BPS }); r.start(REC_SLICE); }
  catch (e) { console.error(e); ss.rec.on = false; D.saveSessions(); recUi(); flash(t("lrec.fail") + (e as Error).message); return; } // 开关关掉,免得下次收音又悄悄重试
  const rec = ss.rec, p = rec.parts.length, now = Date.now(), at = D.audioNow ? D.audioNow() : null;
  // 段信息先同步落盘,之后这段的块才写:刷新后不会和旧块撞键
  rec.parts.push({ t0: now, t1: now, ...(at != null ? { at } : {}), mime: r.mimeType || mime, bytes: 0 });
  D.saveSessions();
  let n = 0, writes = Promise.resolve(), lastData = Date.now(), poke = false, done = () => {};
  const flushed = new Promise<void>((res) => (done = res));
  flushing.add(flushed); finish.set(r, done);
  flushed.then(() => { flushing.delete(flushed); finish.delete(r); recUi(); });
  mr = r;
  // 块按顺序写;最后一块(stop 时的 dataavailable)写完 onstop 才算收尾
  r.ondataavailable = (e) => { lastData = Date.now(); if (e.data && e.data.size) { const b = e.data, k = n++; writes = writes.then(() => saveChunk(ss, p, k, b, r)); } };
  // 有的 Safari 不理 timeslice(或拖很久),数据要到 stop 才给,标签页被杀这一段就全丢了:
  // 超过 2 个 timeslice 没收到 dataavailable,就改成每个 timeslice 主动 requestData()
  const tick = setInterval(() => {
    if (r.state !== "recording") return;
    if (poke || Date.now() - lastData > 2 * REC_SLICE) { poke = true; try { r.requestData(); } catch {} }
  }, REC_SLICE);
  r.onstop = () => { // 音轨断了也会自己停
    clearInterval(tick);
    if (mr === r) { mr = null; recUi(); }
    writes.then(done, done);
  };
  r.onerror = (e) => { console.error(e); if (mr === r) recEnd(); };
  recUi();
}
/** 结束当前段(最后一块随后由 dataavailable 存) */
export function recEnd(): void {
  const r = mr; mr = null;
  if (r && r.state !== "inactive") { try { r.stop(); } catch {} }
  if (r) setTimeout(() => finish.get(r)?.(), 10000);
  recUi();
}
export const recActive = (): boolean => !!mr;

async function putChunk(key: string, b: Blob): Promise<void> {
  try { await idb.put(key, b); return; } catch (e) { if (isQuotaError(e)) throw e; }
  await idb.put(key, { buf: await b.arrayBuffer(), type: b.type }); // Safari 无痕等不让存 Blob
}
async function saveChunk(ss: Session, p: number, n: number, b: Blob, r: MediaRecorder): Promise<void> {
  const key = recKey(ss.id, p, n), part = ss.rec!.parts[p];
  part.t1 = Date.now();
  try { await putChunk(key, b); }
  catch (e) { return recFailed(ss, r, e); }
  if (!state.sessions.includes(ss)) { idb.del(key).catch(() => {}); return; } // 写的时候会话被删了
  part.bytes += b.size; ss.rec!.bytes += b.size; D.saveSessions(); recUi();
}
// 存不下:停止录音、关掉开关,提示一次
function recFailed(ss: Session, r: MediaRecorder, e: unknown): void {
  if (mr === r) recEnd();
  if (!ss.rec || !ss.rec.on) return;
  ss.rec.on = false; D.saveSessions(); recUi();
  if (isQuotaError(e)) { console.error(e); flash(t("lrec.full")); } else storageFailed(e);
}

// ---------- 界面 ----------
/** 刷新录音开关、录音中标记和「转成文件会话」那一栏 */
export function recUi(): void {
  const ss = state.curSess, live = !!ss && ss.kind !== "file", rec = live ? ss!.rec : undefined, on = !!rec && rec.on;
  const b = $("#recBtn");
  b.hidden = !live; b.classList.toggle("on", on); b.classList.toggle("live", !!mr);
  // 录音中:红点 +「录音中」+ 大小(手机上只留红点和大小)
  if (mr) b.replaceChildren(el("span", { className: "rk", textContent: t("lrec.live") }), el("span", { textContent: fmtBytes(rec ? rec.bytes : 0) }));
  else b.textContent = t(on ? "lrec.armed" : "lrec.btn");
  b.title = t("lrec.tip"); b.setAttribute("aria-pressed", String(on));
  if (!live || confirmSid !== ss!.id) { $("#recConfirm").hidden = true; confirmSid = ""; }
  const has = live && !state.running && !mr && !flushing.size && recCount(rec) > 0; // 最后一块写完再显示,大小才准
  $("#recBar").hidden = !has;
  if (has && !converting) $("#recInfo").textContent = t("lrec.info", { n: recCount(rec), dur: fmtClock(recDur(rec!)), size: fmtBytes(rec!.bytes) });
  // 转过了、文件会话还在:按钮改成打开它;文件会话被删了才再转
  const c = $("#recConvert"), k = live && convertedTo(ss!) ? "lrec.open" : "lrec.convert";
  c.dataset.i18n = k; c.textContent = t(k);
}
/** 这个实时会话的录音转成的、还在的文件会话 */
function convertedTo(ss: Session): Session | undefined {
  return ss.recSession ? state.sessions.find((x) => x.id === ss.recSession) : undefined;
}
function setOn(on: boolean): void {
  const ss = state.curSess; if (!ss || ss.kind === "file") return;
  (ss.rec ||= { on: false, bytes: 0, parts: [] }).on = on; D.saveSessions();
  if (!on) recEnd();
  recUi();
}

/** 录音转文件会话:一段直接用;几段用 ffmpeg.wasm 接成一个同格式的文件。新会话用同一模板和语言,两边互相记着。
 *  已经转过、那个文件会话还在,就直接切过去,不再建新的 */
async function recConvert(): Promise<void> {
  const ss = state.curSess;
  if (!ss || !ss.rec || state.running || mr || converting) return;
  const done = convertedTo(ss);
  if (done) return D.openSession(done.id);
  converting = true; $("#recConvert").disabled = true;
  const info = (s: string) => ($("#recInfo").textContent = s);
  try {
    info(t("lrec.reading"));
    await recFlushed(); // 刚停就点:最后一块(最多 10 秒)还在写
    const blobs = partBlobs(ss.rec, await idb.entries(recPrefix(ss.id)));
    if (!blobs.length) throw new Error(t("lrec.empty"));
    const blob = blobs.length === 1 ? blobs[0] : await concatAudio(blobs, recExt(blobs[0].type) === "m4a",
      (p) => info(t("file.loading", { pct: Math.round(p * 100) })), (p) => info(t("lrec.joining", { pct: Math.round(p * 100) })));
    const f = new File([blob], t("lrec.name", { name: ss.name }) + "." + recExt(blob.type), { type: blob.type });
    const fs = await D.toFileSession(ss, f);
    ss.recSession = fs.id; fs.fromLive = ss.id; D.saveSessions();
  } catch (e) { console.error(e); flash(t("lrec.convFail") + (e as Error).message); }
  finally { converting = false; $("#recConvert").disabled = false; recUi(); }
}

/** main.ts 启动时调用一次:注入依赖,挂上按钮 */
export function initRecord(deps: RecDeps): void {
  D = deps;
  $("#recBtn").onclick = () => {
    const ss = state.curSess; if (!ss) return;
    if (ss.rec && ss.rec.on) return setOn(false);
    confirmSid = ss.id; $("#recConfirm").hidden = false; // 每次开启都先确认
  };
  $("#recOk").onclick = () => {
    $("#recConfirm").hidden = true; confirmSid = "";
    setOn(true);
    if (state.running) recBegin(deps.getStream());
  };
  $("#recNo").onclick = () => { $("#recConfirm").hidden = true; confirmSid = ""; };
  $("#recConvert").onclick = recConvert;
}
