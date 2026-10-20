// ---------- 创建 / 编辑模板(和 GPT 对话) ----------
import { store } from "./storage";
import { getUiLang, t, LANGS, TARGETS } from "./i18n";
import { parseGlossary, glossaryText, type GlossEntry } from "./glossary";
import { readResponseStream, partialJsonString } from "./sse";
import { WEB_SEARCH_PER_CALL, type Usage } from "./cost";
import { state, cfg, type Template, type View } from "./state";
import { $, el, flashBtn } from "./dom";

/** 草稿 = 模板里可编辑的字段(没有 id / voices) */
export interface Draft { name: string; source: string; target: string; description: string; style: string; asrPrompt: string; spkNotes?: string; glossary: string }
/** 对话里的一条:note 是界面提示,不发给 GPT */
export interface CreatorMsg { role: "user" | "ai" | "note"; text: string; files?: string[] }
export interface Creator { editId: string | null; draft: Draft | null; msgs: CreatorMsg[] }
/** 发给 Responses API 的一段附件内容 */
type AttachPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string } | { type: "input_file"; filename: string; file_data: string };

/** 留在 main.ts(模板、会话、设置、费用)的函数,启动时注入 */
export interface CreatorDeps {
  show: (v: View) => void;
  newSession: (tplId: string) => void;
  putTemplate: (tp: Template) => void;
  newId: () => string;
  applySettings: () => void;
  apiHeaders: () => Record<string, string>;
  addMtCost: (model: string, u: Usage | undefined, extra?: number) => void;
}
let deps: CreatorDeps;

// creator = { editId, draft: 模板字段, msgs: [{role, text}] };存本地,刷新不丢。每轮请求带上最近 CREATOR_TURNS 轮对话和当前草稿
const CREATOR_TURNS = 10;
export let creator: Creator = store.json("creator", null) || { editId: null, draft: null, msgs: [] };
let creatorBusy = false, glossTextMode = false;
function saveCreator() { store.set("creator", JSON.stringify(creator)); }
function blankDraft(): Draft { return { name: "", source: "ja", target: getUiLang() === "zh" ? "zh-Hans" : "en", description: "", style: "", asrPrompt: "", spkNotes: "", glossary: "" }; }
/** 打开创建页:tp 为 null 时新建,否则编辑该模板(从模板列表和设置面板调用) */
export function openCreator(tp: Template | null): void {
  const d = tp ? { name: tp.name, source: tp.source, target: tp.target, description: tp.description || "", style: tp.style || "", asrPrompt: tp.asrPrompt || "", spkNotes: tp.spkNotes || "", glossary: tp.glossary || "" } : blankDraft();
  creator = { editId: tp ? tp.id : null, draft: d, msgs: [{ role: "note", text: tp ? t("create.welcomeEdit", { name: tp.name }) : t("create.welcome") }] };
  attachments = []; renderAttachments();
  saveCreator(); glossTextMode = false; setTab("chat"); deps.show("create");
}
function setTab(tab: "chat" | "draft") { $("#panes").dataset.tab = tab; $("#tabChat").classList.toggle("on", tab === "chat"); $("#tabDraft").classList.toggle("on", tab === "draft"); }
function linkify(text: string) {
  const frag = document.createDocumentFragment();
  // 把 [标题](链接) 和裸链接变成可点的链接,其余按纯文本
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)）」\]]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    frag.append(text.slice(last, m.index));
    const href = m[2] || m[3];
    frag.append(el("a", { href, target: "_blank", rel: "noopener", textContent: m[1] || href }));
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  return frag;
}
function renderChat() {
  const log = $("#chatLog");
  log.replaceChildren(...creator.msgs.map((m) => { const b = el("div", { className: "msg " + m.role }); b.append(linkify(m.text.replace(/\*\*(.+?)\*\*/g, "$1")));
    if (m.files && m.files.length) b.append(el("div", { className: "files" }, ...m.files.map((n) => el("span", { textContent: n }))));
    return b; }));
  if (creatorBusy) log.append(el("div", { className: "msg ai", id: "liveReply", hidden: true }), el("div", { className: "msg note", id: "thinking", textContent: t("create.thinking", { st: t("create.stStart"), s: 0 }) }));
  log.scrollTop = log.scrollHeight;
  $("#chatSend").disabled = creatorBusy; $("#chatAttach").disabled = creatorBusy;
}
function renderDraft() {
  const d = creator.draft!;
  $("#dName").value = d.name; $("#dSource").value = d.source; $("#dTarget").value = d.target;
  $("#dDesc").value = d.description; $("#dStyle").value = d.style; $("#dAsr").value = d.asrPrompt; $("#dSpkNotes").value = d.spkNotes || ""; $("#dGlossText").value = d.glossary;
  renderGlossTable();
}
function renderGlossTable() {
  const g = parseGlossary(creator.draft!.glossary);
  $("#gTitle").textContent = t("draft.gloss", { p: g.people.length, n: g.terms.length });
  $("#tabDraft").textContent = t("create.tabDraft", { n: g.people.length + g.terms.length });
  const tr = (e: GlossEntry, sp: boolean) => el("tr", {}, el("td", {}, e.src, sp ? el("span", { className: "tag", textContent: t("draft.speaker") }) : null), el("td", { textContent: e.reading }), el("td", { textContent: e.tgt }), el("td", { textContent: e.notes }));
  $("#gBody").replaceChildren(...g.people.map((e) => tr(e, true)), ...g.terms.map((e) => tr(e, false)));
  $("#gTableBox").hidden = glossTextMode; $("#dGlossText").hidden = !glossTextMode;
  $("#gToggle").textContent = t(glossTextMode ? "draft.viewTable" : "draft.editText");
}
/** show("create") 时调用 */
export function renderCreator(): void { if (!creator.draft) creator.draft = blankDraft(); renderChat(); renderDraft(); }
const ENTRY = { type: "object", additionalProperties: false, required: ["text", "reading", "translation", "notes"],
  properties: { text: { type: "string" }, reading: { type: "string" }, translation: { type: "string" }, notes: { type: "string" } } };
const CREATOR_SCHEMA = {
  type: "object", additionalProperties: false, required: ["reply", "template"],
  properties: {
    reply: { type: "string" },
    template: { type: "object", additionalProperties: false, required: ["name", "source", "target", "description", "style", "asrPrompt", "spkNotes", "speakers", "terms"],
      properties: {
        name: { type: "string" }, source: { type: "string", enum: Object.keys(LANGS) }, target: { type: "string", enum: Object.keys(TARGETS) },
        description: { type: "string" }, style: { type: "string" }, asrPrompt: { type: "string" }, spkNotes: { type: "string" },
        speakers: { type: "array", items: ENTRY }, terms: { type: "array", items: ENTRY },
      } },
  },
};
const CREATOR_SYSTEM = () => `You help the user build a "translation template" for a live speech-translation web app.
How the app works: the phone mic streams audio to a realtime speech recognizer (ASR) in the template's source language; each recognized utterance is then corrected and translated by an LLM into the target language and shown as subtitles. A template gives context to both:
- ASR gets "asrPrompt" plus the names in speakers and terms (as prompt and keywords), so it spells rare names and terms correctly.
- The translator gets "description" (background), "style" (translation rules) and the glossary (speakers + terms: original spelling | reading | translation | notes).

Your job: from what the user tells you (event, show, meeting, lecture, match, links, pasted text), research with web search when it helps (official pages, performers/attendees and their exact name spellings and readings, recurring segment names, titles of works, character names, venue, jargon, catchphrases, sponsors, and the speaker cues described under spkNotes), ask brief follow-up questions only when really needed, and keep a complete template draft up to date.

The user may attach files (lecture slides, papers, handouts, syllabi, scripts, cast lists, images). Treat them as primary sources and read them thoroughly:
- Lectures and classes: put the lecturer (and anyone likely to speak) in speakers; in terms, collect the technical terms, method/theory/model names, people and works cited, abbreviations and symbols as they would be spoken aloud, and course-specific names that will actually come up. Use the established translation in the target field; add the original in notes when a term is often kept untranslated. description should summarize the course or lecture topic and level; style should cover terminology consistency, formulas and how to handle code or slide references.
- Prefer facts from the attachments over web results when they conflict; use web search to fill gaps (e.g. reading of a name, standard translation of a term).

Rules:
- Always return the FULL updated template in "template", not a diff. The user message includes the current draft, which may contain the user's manual edits: keep them unless asked to change them.
- source / target: the spoken language and the subtitle language; keep the current values unless the user indicates otherwise ("auto" = mixed or unknown spoken language).
- speakers: people likely to speak or be talked about. text = name as written in the source language; reading = pronunciation (kana for Japanese, pinyin for Chinese, empty if obvious); translation = the name as commonly written in the target language (established fan/media usage if any); notes = role, affiliation, nicknames and how others address them.
- terms: roughly 30-150 entries most likely to be misheard or mistranslated: show/event names, segment/corner names, titles of works, character names, places, jargon, catchphrases, nicknames. Precision over volume; add "unverified" in notes when a fact comes from a single weak source.
- description: 3-8 sentences of background, written in the target language (who, what, when, where, format, running jokes).
- style: concrete translation guidance written in the target language (tone, honorifics, how to render nicknames, what to leave untranslated).
- spkNotes: everything that helps tell the speakers apart in a recording (used to label who says each line), written in the target language. Research this like the glossary (official sites, wikis, episode transcripts, fan summaries). Cover:
  * per speaker: the exact self-introduction pattern in the source language (quote it), first-person pronoun, the nicknames others call them and what they call each other (who calls whom what), usual role (host/MC who reads the script and letters, guest, assistant), verbal habits;
  * ambiguity: people who share a name, nickname or similar-sounding name (e.g. two people both called "Hina"), and how to tell them apart (surname used, who is addressing whom, role); say explicitly when a nickname alone cannot identify the person;
  * format: usual line-up and rotation (which people appear together, how many per episode), and if the show has different modes (e.g. episodes hosted in character vs as the cast themselves) how to tell which mode an episode is in and which set of names applies; map voice actors to the characters they voice.
  Only well-sourced facts (mark weak ones "unverified"); one short paragraph per speaker plus the format/ambiguity notes; empty string if nothing useful is known.
- asrPrompt: one or two natural sentences in the SOURCE language describing the audio (e.g. "日本語のラジオ番組の公開イベントの音声。"). No lists; names are appended automatically.
- name: short template name.
- reply: a short message to the user written in ${getUiLang() === "zh" ? "Simplified Chinese" : "English"}: what you found or changed, key sources as plain URLs, and at most two questions. Plain text only, no Markdown. Do not repeat the whole glossary in reply.`;
function draftForGPT() {
  const d = creator.draft!, g = parseGlossary(d.glossary);
  const ent = (e: GlossEntry) => ({ text: e.src, reading: e.reading, translation: e.tgt, notes: e.notes });
  return { name: d.name, source: d.source, target: d.target, description: d.description, style: d.style, asrPrompt: d.asrPrompt, spkNotes: d.spkNotes || "", speakers: g.people.map(ent), terms: g.terms.map(ent) };
}
// 附件:课件、论文等随本轮消息发给 Responses API(PDF/Office 用 input_file,图片用 input_image,纯文本直接读出)
const ATTACH_MAX_MB = 40;
let attachments: { name: string; size: number; part: AttachPart }[] = []; // {name, size, part}
const TEXT_EXT = /\.(txt|md|csv|srt|vtt|tex|html|json)$/i;
function readFile(f: File, asText: boolean) {
  return new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = () => bad(r.error); asText ? r.readAsText(f) : r.readAsDataURL(f); });
}
async function addAttachments(files: File[]) {
  for (const f of files) {
    const total = attachments.reduce((a, x) => a + x.size, 0) + f.size;
    if (total > ATTACH_MAX_MB * 1048576) { creator.msgs.push({ role: "note", text: t("create.attachTooBig", { m: ATTACH_MAX_MB }) }); renderChat(); break; }
    try {
      let part: AttachPart;
      if (TEXT_EXT.test(f.name)) part = { type: "input_text", text: `File: ${f.name}\n\n${await readFile(f, true)}` };
      else if (f.type.startsWith("image/")) part = { type: "input_image", image_url: await readFile(f, false) };
      else part = { type: "input_file", filename: f.name, file_data: await readFile(f, false) };
      attachments.push({ name: f.name, size: f.size, part });
    } catch { creator.msgs.push({ role: "note", text: t("create.attachRead", { name: f.name }) }); renderChat(); }
  }
  renderAttachments();
}
function renderAttachments() {
  $("#attachList").replaceChildren(...attachments.map((a, i) => el("span", { className: "fileChip", title: a.name },
    el("span", { textContent: a.name }),
    el("button", { textContent: "×", title: t("create.attachRemove"), ariaLabel: t("create.attachRemove"), onclick: () => { attachments.splice(i, 1); renderAttachments(); } }))));
}
async function creatorSend() {
  const typed = $("#chatInput").value.trim();
  if ((!typed && !attachments.length) || creatorBusy) return;
  const text = typed || t("create.attachOnly");
  const files = attachments; 
  deps.applySettings();
  if (!cfg.hasKey) { creator.msgs.push({ role: "note", text: t("create.noKey") }); renderChat(); return; }
  creator.msgs.push({ role: "user", text, files: files.map((a) => a.name) }); $("#chatInput").value = ""; saveCreator();
  attachments = []; renderAttachments();
  creatorBusy = true; renderChat();
  const t0 = performance.now();
  let status = t("create.stStart");
  const showStatus = () => { const n = $("#thinking"); if (n) n.textContent = t("create.thinking", { st: status, s: Math.round((performance.now() - t0) / 1000) }); };
  const tick = setInterval(showStatus, 1000);
  // 流式:边收边显示检索进度、回复正文和已整理的条目数
  const onStream = (ev: any /* Responses API 的流事件,原样 JSON(同 sse.ts) */, buf: string) => {
    if (ev.type === "response.output_item.added" && ev.item.type === "web_search_call") status = t("create.stSearch", { n: ++searchN });
    else if (ev.type === "response.output_item.done" && ev.item.type === "web_search_call" && ev.item.action && ev.item.action.query) status = t("create.stSearched", { q: ev.item.action.query });
    else if (ev.type === "response.output_text.delta") {
      const reply = partialJsonString(buf, "reply"), n = (buf.match(/"text"\s*:/g) || []).length;
      status = n ? t("create.stDraft", { n }) : t("create.stWriting");
      const b = $("#liveReply");
      if (b && reply) { b.hidden = false; b.replaceChildren(linkify(reply.replace(/\*\*(.+?)\*\*/g, "$1"))); const log = $("#chatLog"); if (log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight; }
    } else return;
    showStatus();
  };
  let searchN = 0;
  const model = cfg.ctModel;
  // 前几轮对话原样带上(不用 previous_response_id:订阅转发等不存记录的接口不支持,且重发文字比带上整段推理和检索结果更省)
  const past = creator.msgs.slice(0, -1).filter((m) => m.role === "user" || m.role === "ai").slice(-CREATOR_TURNS * 2).map((m) => m.role === "user"
    ? { role: "user", content: [{ type: "input_text", text: m.text + (m.files && m.files.length ? `\n\n(Attached: ${m.files.join(", ")})` : "") }] }
    : { role: "assistant", content: [{ type: "output_text", text: m.text }] });
  const call = async () => {
    const body: { stream?: boolean; [k: string]: unknown } = {
      model, reasoning: { effort: "medium" }, instructions: CREATOR_SYSTEM(), tools: [{ type: "web_search" }],
      input: [...past, { role: "user", content: [
        { type: "input_text", text: `${text}${files.length ? `\n\n(Attached: ${files.map((a) => a.name).join(", ")})` : ""}\n\n---\nCurrent draft (JSON; may include the user's manual edits):\n${JSON.stringify(draftForGPT())}` },
        ...files.map((a) => a.part),
      ] }],
      text: { format: { type: "json_schema", name: "template_turn", strict: true, schema: CREATOR_SCHEMA } },
    };
    body.stream = true;
    const res = await fetch(cfg.apiBase + "/responses", { method: "POST", headers: deps.apiHeaders(), body: JSON.stringify(body) });
    if (!res.ok) { const err: Error & { status?: number } = new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`); err.status = res.status; throw err; }
    return readResponseStream(res, onStream);
  };
  try {
    const d = await call();
    const searches = (d.output || []).filter((o: any /* response.output 里的一项,原样 JSON */) => o.type === "web_search_call").length;
    deps.addMtCost(model, d.usage, searches * WEB_SEARCH_PER_CALL);
    const msg = (d.output || []).find((o: any /* 同上 */) => o.type === "message");
    const out = JSON.parse(((msg && msg.content) || []).map((c: { text?: string }) => c.text || "").join(""));
    const tp = out.template;
    creator.draft = { name: tp.name, source: tp.source, target: tp.target, description: tp.description, style: tp.style, asrPrompt: tp.asrPrompt, spkNotes: tp.spkNotes, glossary: glossaryText(tp.speakers, tp.terms) };
    creator.msgs.push({ role: "ai", text: out.reply });
    creator.msgs.push({ role: "note", text: t("create.updated", { p: tp.speakers.length, n: tp.terms.length }) });
  } catch (e) {
    console.error(e);
    creator.msgs.push({ role: "note", text: t("create.err", { m: (e as Error).message }) });
    if (files.length && !attachments.length) { attachments = files; renderAttachments(); } // 失败时把附件放回去,方便重发
  } finally {
    clearInterval(tick);
    creatorBusy = false; saveCreator();
    if (state.view === "create") { renderChat(); renderDraft(); }
  }
}
function saveDraft() {
  const d = creator.draft!;
  if (!d.name.trim()) { setTab("draft"); $("#dName").focus(); flashBtn($("#dSave"), t("draft.needName")); return null; }
  const id = creator.editId || deps.newId();
  deps.putTemplate({ ...d, name: d.name.trim(), id });
  creator.editId = id; saveCreator();
  return id;
}
/** main.ts 启动时调用一次(在原来这段代码的位置):注入依赖、绑定创建页的按钮和输入框 */
export function initCreator(d: CreatorDeps): void {
  deps = d;
  $("#tabChat").onclick = () => setTab("chat");
  $("#tabDraft").onclick = () => setTab("draft");
  $("#gToggle").onclick = () => { glossTextMode = !glossTextMode; renderGlossTable(); };
  // 草稿手动修改随时存;下一轮对话会把当前草稿一起发给 GPT
  for (const [sel, key] of [["#dName", "name"], ["#dSource", "source"], ["#dTarget", "target"], ["#dDesc", "description"], ["#dStyle", "style"], ["#dAsr", "asrPrompt"], ["#dSpkNotes", "spkNotes"], ["#dGlossText", "glossary"]] as const) {
    $(sel).addEventListener("input", () => { creator.draft![key] = $(sel).value; saveCreator(); if (key === "glossary") renderGlossTable(); });
    $(sel).addEventListener("change", () => { creator.draft![key] = $(sel).value; saveCreator(); });
  }
  $("#chatAttach").onclick = () => $("#attachFile").click();
  $("#attachFile").onchange = async (e: Event) => { const inp = e.target as HTMLInputElement; await addAttachments([...inp.files!]); inp.value = ""; };
  $("#chatSend").onclick = creatorSend;
  $("#chatInput").addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) creatorSend(); });
  $("#dSave").onclick = () => { if (saveDraft()) deps.show("tpl"); };
  $("#dSaveStart").onclick = () => { const id = saveDraft(); if (id) { deps.newSession(id); deps.show("live"); } };
  $("#dDiscard").onclick = (e: Event) => {
    const b = e.target as HTMLElement;
    if (!b.dataset.armed) { b.dataset.armed = "1"; flashBtn(b, t("draft.discardSure")); setTimeout(() => delete b.dataset.armed, 2000); return; }
    attachments = []; renderAttachments();
    creator = { editId: null, draft: null, msgs: [] }; store.set("creator", null); deps.show("tpl");
  };
}
