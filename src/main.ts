// @ts-nocheck —— 从单文件页面整体搬过来的主程序,之后按功能逐步拆模块、补类型
import "./style.css";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import ffmpegCore from "@ffmpeg/core?url";
import ffmpegWasm from "@ffmpeg/core/wasm?url";
import * as ort from "onnxruntime-web/wasm";
import { BUILTIN, SERVER_API, ASR_MODEL, MT_MODEL, CT_MODEL, VAD, BUILD, SPK_MODEL } from "./config";
import { applyMemo, memoPrompt, MEMO_SCHEMA } from "./memo";
import { judgeSpeakers, reconcileGroupNames } from "./spk/judge";
import { SPK_SR, SPK_DIM, spkResample, spkSegments, spkFbank, spkCluster, spkNorm, spkDot, spkSmooth } from "./spk/core";

// ---------- 小工具 ----------
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem("jls." + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { v === null ? localStorage.removeItem("jls." + k) : localStorage.setItem("jls." + k, v); } catch {} },
  json(k, d) { try { return JSON.parse(this.get(k, "null")) ?? d; } catch { return d; } },
};
function el(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null)); return e; }

function showModelHints() { $("#asrModelHint").textContent = t("asrDesc." + $("#asrModel").value); $("#mtModelHint").textContent = t("mtDesc." + $("#mtModel").value); $("#ctModelHint").textContent = t("ctDesc." + $("#ctModel").value) + (uiLang === "zh" ? "" : " ") + t("set.ctModelHint"); }

// 滑动条刻度:每项列出带数字的主刻度,默认值高亮;点刻度直接跳到该值
const TICKS = {
  maxGain: [1, 10, 20, 30, 40, 50], agcTarget: [2, 8, 14, 20, 25], vad: [0.05, 0.2, 0.4, 0.6, 0.9],
  silence: [200, 600, 1000, 1500, 2000], maxTurn: [3, 8, 15, 20, 25, 30], prefix: [0, 300, 500, 750, 1000], tgtSize: [16, 24, 32, 40],
};
const TICK_DEF = { tgtSize: 24 }; // 不在收音设置里的滑动条的默认值
function buildTicks() {
  for (const [id, marks] of Object.entries(TICKS)) {
    const r = $("#" + id), min = Number(r.min), max = Number(r.max), def = TICK_DEF[id] ?? AUDIO_DEFAULTS[id];
    const box = el("div", { className: "ticks", ariaHidden: "true" }, ...marks.map((v) => el("span", {
      className: v === def ? "def" : "", textContent: String(v), style: `left:${((v - min) / (max - min)) * 100}%`,
      onclick: (e) => { e.preventDefault(); r.value = v; r.dispatchEvent(new Event("input", { bubbles: true })); },
    })));
    r.after(box);
    // 数值标放进标签第一行(名称右侧)
    const head = r.closest("label").querySelector("span");
    const row = el("span", { className: "rhead" }); head.replaceWith(row); row.append(head, el("output", { className: "rv", id: "rv-" + id }));
  }
}
// 每个滑动条标签右侧显示当前值(带单位),和填充色一起刷新
const RANGE_UNIT = { maxGain: "u.x", silence: "u.ms", prefix: "u.ms", maxTurn: "u.s", tgtSize: "u.px" };
function updateRangeFill() {
  document.querySelectorAll("input[type=range]").forEach((r) => {
    r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%");
    const o = document.getElementById("rv-" + r.id), v = String(Number(Number(r.value).toFixed(2)));
    if (o) { o.textContent = RANGE_UNIT[r.id] ? t(RANGE_UNIT[r.id], { v }) : v; o.classList.toggle("changed", TICKS[r.id] && Number(r.value) !== (TICK_DEF[r.id] ?? AUDIO_DEFAULTS[r.id])); }
  });
}

// ---------- 界面语言 ----------
const I18N = {
  zh: {
    "app": "实时翻译", "hdr.home": "模板", "hdr.sessions": "会话", "hdr.settings": "设置", "tpl.title": "模板", "card.file": "翻译文件", "sess.file": "文件", "sess.live": "实时",
    "file.start": "开始处理", "file.pause": "暂停", "file.resume": "继续处理", "file.redo": "重新处理", "file.redoSure": "再次点击以清空字幕并重新处理", "file.reattach": "重新选择原文件",
    "file.idle": "时长 {total}。点击“开始处理”，以 {speed} 倍速识别并翻译。", "file.loading": "正在下载解码组件 {pct}%(约 32 MB，仅首次需要)", "file.extract": "正在提取音轨 {pct}%",
    "file.run": "识别 {pct}% · {pos} / {total} · {speed} 倍速 · 预计剩余 {eta} · 已翻译 {done}/{n} 句", "file.flush": "正在完成最后的识别和翻译 · 已翻译 {done}/{n} 句",
    "file.paused": "已暂停 · 已处理 {pos} / {total} · {n} 句字幕", "file.done": "已完成 · 时长 {total} · {n} 句字幕", "file.missing": "本地没有保存原文件，请重新选择同一个文件后再播放或处理。",
    "file.err": "处理中断：{m}。点击“继续处理”可从中断处接着处理。", "file.noStore": "文件较大，未能保存到浏览器本地；刷新页面后需要重新选择文件。", "file.asrNote": "文件翻译固定使用 gpt-transcribe，以获得精确的时间戳。",
    "status.processing": "处理中", "status.paused": "已暂停", "status.done": "已完成",
    "home.sessIntro": "每次翻译是一个会话，各自保存所用的模板、语言、设置和字幕记录，可以随时回来继续。", "home.newSession": "新建翻译",
    "home.noSessions": "还没有翻译会话。点击“新建翻译”，选择一个模板即可开始。",
    "sess.continue": "继续", "sess.rename": "重命名", "sess.export": "导出字幕", "sess.del": "删除", "sess.delSure": "再次点击以确认删除",
    "sess.meta": "{tpl} · {src} → {tgt}", "sess.when": "{time} · {n} 条字幕", "sess.tplMissing": "模板已删除",
    "set.sessChip": "本会话", "set.sessCur": "当前会话：{name}", "set.sessNone": "尚未创建会话。下面标有“本会话”的设置将作为新会话的默认值。",
    "status.idle": "未开始", "status.connecting": "正在连接", "status.listening": "正在收音", "status.reconnect": "连接中断，正在重连", "status.keyBad": "API 密钥无效",
    "status.https": "需要 HTTPS 连接", "status.noMic": "未获得麦克风权限", "status.stopped": "已停止", "status.tapFix": "，请轻触屏幕恢复", "status.micCant": "麦克风无法使用，请停止后重新开始",
    "mic.ended": "麦克风已断开", "mic.muted": "麦克风已被系统暂停", "mic.ctx": "音频处理未运行", "mic.nodata": "未收到音频数据",
    "home.intro": "选择一个模板即可开始新的翻译会话。模板包含背景说明、翻译风格和词表，可为语音识别与翻译提供上下文，显著提高准确度。",
    "home.noKey": "尚未配置 OpenAI API 密钥，请在“设置”中填写。",
    "home.new": "新建模板", "home.import": "导入模板", "home.importFail": "导入失败：文件不是有效的模板。",
    "card.open": "开始翻译", "card.edit": "编辑", "card.dup": "复制", "card.export": "导出", "card.del": "删除", "card.delSure": "再次点击以确认删除",
    "card.reset": "恢复内置版本", "card.builtin": "内置", "card.modified": "已修改", "card.current": "当前使用",
    "card.meta": "{src} → {tgt} · 说话人 {p} 位 · 词条 {n} 个", "card.copy": " 副本",
    "live.start": "开始收音", "live.stop": "停止收音", "live.follow": "自动滚动", "live.unfollow": "回到最新",
    "live.empty": "点击下方“开始收音”。请将设备朝向声源，并保持屏幕常亮。", "live.emptyKey": "请先在“设置”中填写 OpenAI API 密钥，然后点击下方“开始收音”。",
    "line.translating": "正在翻译……", "line.noise": "未识别到有效语音", "line.failed": "翻译失败", "line.unfinished": "页面刷新前未完成翻译", "line.sep": "以上为之前的 {n} 条记录",
    "lat.stream": "流式", "ib.gain": "增益", "ib.asr": "识别", "ib.mt": "翻译", "ib.avg": "平均", "ib.queue": "待翻译", "ib.lines": "语句", "ib.noise": "杂音", "ib.err": "错误", "ib.cost": "累计费用", "ib.level": "输入音量", "ib.deltas": "已收到识别片段 {n} 个", "sec": "{s} 秒",
    "cost": "预估累计费用：识别 {a}，翻译与模板 {m}，合计 {t}。按官方价格与实际用量估算，仅统计本设备，刷新页面后保留。",
    "flash.mt": "翻译失败：", "flash.timeout": "请求超时", "flash.asr": "识别出错：", "flash.mic": "无法打开麦克风：", "flash.https": "需通过 HTTPS 访问本页面才能使用麦克风。",
    "create.titleNew": "新建模板", "create.titleEdit": "编辑模板", "create.tabChat": "对话", "create.tabDraft": "模板草稿 · {n} 条",
    "create.placeholder": "请描述翻译场合，例如活动、课程或会议名称、日期、出演者或讲师、官方网站链接，以及容易听错的词语。",
    "create.send": "发送", "create.attach": "附件", "create.attachRemove": "移除", "create.attachTooBig": "附件总大小不能超过 {m} MB。", "create.attachRead": "无法读取文件：{name}", "create.attachOnly": "请阅读附件，并据此完善模板。", "create.thinking": "{st}，已用时 {s} 秒", "create.stStart": "正在分析需求", "create.stSearch": "正在联网检索，第 {n} 次", "create.stSearched": "已检索：{q}", "create.stWriting": "正在撰写回复", "create.stDraft": "正在生成模板，已整理 {n} 个条目", "create.err": "出错：{m}",
    "create.welcome": "请描述需要翻译的场合，例如活动、节目、会议、课程或比赛。信息越具体越好，包括名称、日期、出演者或参会者、官方网站链接以及容易听错的词语，也可以直接粘贴相关资料，或通过“附件”上传课件、论文、讲义、台本等文件。\n\n我会联网检索，并将背景说明、翻译风格、说话人和词表整理到模板草稿中。在手机上，请切换到“模板草稿”页查看。草稿可随时手动修改，修改后也可以让我继续补充。",
    "create.welcomeEdit": "正在编辑“{name}”。你可以让我补充词表，例如“加入今天的嘉宾和环节名称”，或调整翻译风格，也可以直接修改草稿。",
    "create.updated": "草稿已更新：说话人 {p} 位，词条 {n} 个。", "create.noKey": "请先在“设置”中填写 OpenAI API 密钥。",
    "draft.name": "模板名称", "draft.source": "源语言", "draft.target": "目标语言",
    "draft.desc": "背景说明", "draft.descHint": "提供给翻译模型的背景信息，例如场合、参与者及其相互关系。",
    "draft.style": "翻译风格", "draft.styleHint": "对译文的具体要求，例如称呼、语气和固定译法。",
    "draft.spkNotes": "说话人线索", "draft.spkNotesHint": "帮助区分说话人：每人怎么自我介绍、怎么称呼自己和别人、谁负责主持、说话习惯，以及常见的出场阵容。仅用于说话人识别，不影响翻译。",
    "draft.asr": "语音识别提示", "draft.asrHint": "请使用源语言写一两句话，描述音频内容。说话人和词表会自动附加在后面。",
    "draft.gloss": "说话人与词表：{p} 位说话人，{n} 个词条", "draft.glossHint": "每行格式为：原文 | 读音 | 译文 | 备注。以 @ 开头的行表示说话人，以 # 开头的行为注释。语音识别使用原文拼写，翻译统一使用译文。",
    "draft.editText": "编辑文本", "draft.viewTable": "表格视图", "draft.save": "保存", "draft.saveStart": "保存并开始", "draft.discard": "放弃",
    "draft.needName": "请填写模板名称", "draft.discardSure": "再次点击以确认放弃", "draft.speaker": "说话人",
    "g.src": "原文", "g.reading": "读音", "g.tgt": "译文", "g.notes": "备注",
    "set.title": "设置", "set.done": "完成", "sec.general": "通用", "set.uiLang": "界面语言", "set.apiKey": "OpenAI API 密钥",
    "set.keyHint": "可留空。留空时通过本站服务器转发请求并使用服务器配置的密钥，密钥不会出现在网页中。填写后将直接连接 OpenAI，密钥仅保存在本设备的浏览器中。",
    "set.keyHintByok": "密钥仅保存在本设备的浏览器中，页面直接连接 OpenAI，不经过任何服务器。",
    "sec.lang": "语言", "set.langHint": "仅对当前会话生效，不会修改模板，点击“完成”后生效。", "set.editTpl": "编辑当前模板", "set.curTpl": "当前模板：{name}",
    "sec.models": "模型", "set.asrModel": "语音识别模型", "set.mtModel": "翻译模型", "set.effort": "翻译推理强度", "set.ctModel": "模板生成模型", "set.ctModelHint": "同时用于说话人判定和整理摘要。",
    "ctDesc.gpt-6.1-sol": "默认模型。用于和 GPT 对话创建模板，联网检索与整理词表效果好。",
    "ctDesc.gpt-6-luna": "费用约为 gpt-6.1-sol 的十分之一，资料整理可能不够完整。",
    "asrDesc.gpt-transcribe": "按句识别，准确度高，词表将作为关键词使用，费用约为 gpt-live-transcribe 的四分之一。",
    "asrDesc.gpt-live-transcribe": "默认模型。流式识别，边听边出字，延迟低，支持词表。",
    "mtDesc.gpt-6.1-sol": "准确度最高，平均延迟约 2.7 秒，费用约为 gpt-6-luna 的十倍。",
    "mtDesc.gpt-6-luna": "默认模型。费用约为 gpt-6.1-sol 的十分之一，细节处理略弱。",
    "opt.effortNone": "不设置", "opt.effortMinimal": "最低", "opt.effortLow": "低", "opt.effortMedium": "中", "opt.effortHigh": "高",
    "set.effortHint": "默认为“中”。强度越高，翻译越慢。非推理模型请选择“不设置”。",
    "set.micDev": "麦克风", "opt.micDefault": "系统默认", "opt.micN": "麦克风 {n}", "opt.micMissing": "之前选择的麦克风（当前未连接）", "set.micDevHint": "收音中切换会立即改用新的麦克风。", "set.micDevNoLabel": "开始收音并允许使用麦克风后，这里会显示各设备的名称。", "flash.micFallback": "所选麦克风不可用，已改用系统默认麦克风。", "u.x": "{v}×", "u.ms": "{v} 毫秒", "u.s": "{v} 秒", "u.px": "{v} px", "u.pct": "{v}%",
    "spk.btn": "说话人", "spk.title": "说话人识别", "spk.beta": "实验功能", "spk.close": "关闭",
   
   
   
   
   
    "spk.judging": "GPT 正在根据 {n} 句字幕判定说话人，已用 {s} 秒(一集通常需要几十秒)……", "spk.judged": "其中 {n} 句由 GPT 根据上下文判定(虚线标签)。",
   
    "spk.by.self_intro": "GPT 判定:自我介绍", "spk.by.addressed": "GPT 判定:被点名后回答", "spk.by.turn_taking": "GPT 判定:对话轮次", "spk.by.content": "GPT 判定:内容与说话习惯", "spk.by.voice": "GPT 判定:声纹", "spk.by.unknown": "GPT 判定",
    "sec.spk": "说话人", "spk.settings": "说话人设置", "spk.on": "识别说话人", "spk.onHint": "开启后自动标出每句字幕是谁说的：先在本机分析声音并分组(首次需下载约 40 MB 组件，不消耗 API)，再由 GPT 结合字幕内容和当前模板的出演者、说话人线索确定每组是谁、补全声音不够确定的句子(消耗 API，一集约几美分)。文件处理完成后自动进行，已处理完的文件开启后立即开始。结果显示在字幕、画面和导出文件中，关闭后隐藏但不删除。", "spk.introOff": "说话人识别未开启。开启后会自动标出每句字幕是谁说的。", "spk.introOn": "下面是按声音分出的各组和认出的名字。名字不对可以直接改，改完点“重新识别”，GPT 会以你的名字为准重新判定；几组改成同一个名字即合并。点“试听”可听该组最有代表性的一段。", "spk.enable": "开启说话人识别", "spk.start": "开始识别", "spk.rerun": "重新识别", "spk.none": "尚未识别。点击“开始识别”。", "spk.wait": "文件处理完成后会自动识别。", "spk.needKey": "GPT 判定需要 API 密钥，请先在设置中填写。", "spk.done": "已分为 {k} 组，标注 {a} / {b} 句字幕。", "file.spk": "已完成字幕 · 说话人识别：{m}", "spk.confirm": "开启前请确认：首次使用需要下载约 40 MB 的声音分析组件(之后由浏览器缓存)，建议在 Wi-Fi 下进行；每个文件识别时还会调用一次 GPT，按 API 计费，一集约几美分。", "spk.confirmOk": "确认开启", "spk.confirmNo": "暂不开启", "spk.saveVoices": "把这些声音存进模板", "spk.saveVoicesHint": "确认各组名字无误后保存。之后用同一个模板处理文件时，会自动对照这些声音来认人，减少认错。只保存声音特征(每人约 1 KB)，不保存录音；同名的会和已存的合并。", "spk.saved": "已存入模板：{names}", "spk.lib": "模板声纹库：{names}", "spk.libNone": "模板声纹库：暂无", "spk.libMatch": "像声纹库里的 {name}", "spk.clearVoices": "清空声纹库", "spk.clearVoicesSure": "再次点击以清空", "spk.n": "说话人 {n}", "spk.unsure": "不确定", "spk.play": "试听", "spk.meta": "{dur} · {n} 段",
    "spk.loadModel": "正在加载声纹模型 {pct}%", "spk.extract": "正在重新提取音轨……", "spk.embed": "正在分析声音特征 {i} / {n} 段",
   
    "spk.err": "分析失败：{m}", "spk.needMedia": "需要原文件才能分析，请先重新选择原文件。", "spk.busy": "文件正在处理，请在完成或暂停后再分析。", "sec.audio": "收音", "set.audioHint": "除最后三项系统选项需停止后重新开始收音外，其余设置在点击“完成”后立即生效；麦克风切换立即生效。",
    "set.gain": "麦克风增益", "opt.gainAuto": "自动", "opt.gain1": "不放大", "set.gainHint": "默认为自动，底部信息栏会显示当前放大倍数。距离声源较远且没有字幕输出时，请先确认信息栏左侧的信号格是否有变化。",
    "set.maxGain": "自动增益上限", "set.agcTarget": "自动增益目标响度", "set.vad": "识别灵敏度", "set.silence": "断句静音时长", "set.maxTurn": "单句最长时长", "set.prefix": "句首保留时长",
    "set.nr": "云端降噪", "opt.far": "远场", "opt.near": "近场", "opt.off": "关闭", "set.nrHint": "默认关闭，保留原始声音。环境嘈杂、离声源较远时可选择远场；贴近扬声器或使用耳机麦克风时可选择近场。",
    "set.micAgc": "系统自动增益", "set.micNs": "系统降噪", "set.micEc": "系统回声消除", "set.micHint": "系统降噪可能将远处的人声当作噪声消除；回声消除通常无需开启。", "set.resetAudio": "恢复默认收音设置",
    "v.maxGain": "默认 40 倍。自动增益最多把声音放大到这个倍数。", "v.agcTarget": "默认 14。没有字幕输出时请调高；底噪被误识别时请调低。",
    "v.vad": "默认 " + VAD + "。数值越小越灵敏。声音较小时请调低；掌声或笑声造成误触发时请调高。", "v.maxTurn": "默认 8 秒。仅适用于 gpt-transcribe，在持续噪声或背景音乐下到时强制断句。字幕过碎时请调高。",
    "v.prefix": "默认 300 毫秒。句首被截断时请调高。", "v.silence": "默认 600 毫秒。对话交替频繁时请调低；字幕过碎时请调高。",
    "sec.display": "显示", "set.showSrc": "显示原文", "set.fontSize": "译文字号",
    "sec.records": "字幕记录", "rec.copy": "复制全部字幕", "rec.save": "下载字幕", "rec.clear": "清空记录", "rec.clearSure": "再次点击以确认清空",
    "rec.copied": "已复制", "rec.copyFail": "复制失败，请使用下载", "rec.resetCost": "费用清零", "rec.costCleared": "已清零",
    "rec.memo": "翻译记忆 · {n} 条", "rec.memoHint": "翻译时模型会把对后续翻译有用的信息(谁在场、当前话题、昵称、某个词指什么等)记在这里,之后每次翻译都会参考;过时或有误的会自行删掉。按会话保存,最多 30 条。", "rec.memoEmpty": "还没有记录。", "rec.memoClear": "清空记忆", "rec.memoCleared": "已清空", "rec.recap": "生成摘要", "rec.recapBusy": "正在生成摘要，内容较多时可能需要一至两分钟。", "rec.recapEmpty": "暂无字幕记录。", "rec.recapFail": "摘要生成失败：",
    "sec.adv": "高级", "set.apiBase": "API 地址", "set.ver": "版本 {v}",
    "tpl.blank": "通用模板", "tpl.blankDesc": "",
  },
  en: {
    "app": "Live Translate", "hdr.home": "Templates", "hdr.sessions": "Sessions", "hdr.settings": "Settings", "tpl.title": "Templates", "card.file": "Translate file", "sess.file": "File", "sess.live": "Live",
    "file.start": "Start processing", "file.pause": "Pause", "file.resume": "Resume", "file.redo": "Process again", "file.redoSure": "Tap again to clear and reprocess", "file.reattach": "Select the original file",
    "file.idle": "Duration {total}. Tap “Start processing” to transcribe and translate at {speed}× speed.", "file.loading": "Downloading the decoder {pct}% (about 32 MB, first time only)", "file.extract": "Extracting audio {pct}%",
    "file.run": "Recognition {pct}% · {pos} / {total} · {speed}× · about {eta} left · translated {done}/{n}", "file.flush": "Finishing recognition and translation · translated {done}/{n}",
    "file.paused": "Paused · processed {pos} / {total} · {n} lines", "file.done": "Done · duration {total} · {n} lines", "file.missing": "The original file is not stored on this device. Select the same file again to play or process it.",
    "file.err": "Processing stopped: {m}. Tap “Resume” to continue from where it stopped.", "file.noStore": "The file is too large to store in this browser; you will need to select it again after reloading.", "file.asrNote": "File translation always uses gpt-transcribe for accurate timestamps.",
    "status.processing": "Processing", "status.paused": "Paused", "status.done": "Done",
    "home.sessIntro": "Each translation is a session that keeps its own template, languages, settings and transcript, so you can come back and continue at any time.", "home.newSession": "New translation",
    "home.noSessions": "No sessions yet. Tap “New translation” and choose a template to begin.",
    "sess.continue": "Continue", "sess.rename": "Rename", "sess.export": "Export transcript", "sess.del": "Delete", "sess.delSure": "Tap again to confirm",
    "sess.meta": "{tpl} · {src} → {tgt}", "sess.when": "{time} · {n} lines", "sess.tplMissing": "Template deleted",
    "set.sessChip": "Session", "set.sessCur": "Current session: {name}", "set.sessNone": "No session yet. Settings marked “Session” below will be used as defaults for new sessions.",
    "status.idle": "Idle", "status.connecting": "Connecting", "status.listening": "Listening", "status.reconnect": "Connection lost, reconnecting", "status.keyBad": "Invalid API key",
    "status.https": "HTTPS required", "status.noMic": "Microphone access denied", "status.stopped": "Stopped", "status.tapFix": ". Tap the screen to resume", "status.micCant": "Microphone unavailable. Stop and start again",
    "mic.ended": "Microphone disconnected", "mic.muted": "Microphone paused by the system", "mic.ctx": "Audio processing stopped", "mic.nodata": "No audio received",
    "home.intro": "Select a template to start a new translation session. A template provides background information, translation style and a glossary, giving speech recognition and translation the context they need for higher accuracy.",
    "home.noKey": "No OpenAI API key is configured. Please add one in Settings.",
    "home.new": "New template", "home.import": "Import template", "home.importFail": "Import failed: the file is not a valid template.",
    "card.open": "Start", "card.edit": "Edit", "card.dup": "Duplicate", "card.export": "Export", "card.del": "Delete", "card.delSure": "Tap again to confirm",
    "card.reset": "Restore built-in version", "card.builtin": "Built-in", "card.modified": "Modified", "card.current": "In use",
    "card.meta": "{src} → {tgt} · {p} speakers · {n} terms", "card.copy": " copy",
    "live.start": "Start listening", "live.stop": "Stop listening", "live.follow": "Auto-scroll", "live.unfollow": "Jump to latest",
    "live.empty": "Tap “Start listening” below. Point the device toward the sound source and keep the screen on.", "live.emptyKey": "Add an OpenAI API key in Settings, then tap “Start listening” below.",
    "line.translating": "Translating…", "line.noise": "No speech detected", "line.failed": "Translation failed", "line.unfinished": "Not translated before the page was reloaded", "line.sep": "{n} earlier lines above",
    "lat.stream": "streaming", "ib.gain": "Gain", "ib.asr": "ASR", "ib.mt": "Translation", "ib.avg": "Avg", "ib.queue": "Queued", "ib.lines": "Lines", "ib.noise": "Noise", "ib.err": "Errors", "ib.cost": "Spend", "ib.level": "Input level", "ib.deltas": "{n} recognition segments received", "sec": "{s}s",
    "cost": "Estimated spend: recognition {a}, translation and templates {m}, total {t}. Based on list prices and actual usage for this device only; kept across reloads.",
    "flash.mt": "Translation failed: ", "flash.timeout": "request timed out", "flash.asr": "Recognition error: ", "flash.mic": "Unable to open the microphone: ", "flash.https": "This page must be served over HTTPS to use the microphone.",
    "create.titleNew": "New template", "create.titleEdit": "Edit template", "create.tabChat": "Chat", "create.tabDraft": "Draft · {n} entries",
    "create.placeholder": "Describe the occasion: the event, course or meeting name, date, speakers or lecturers, official links, and words likely to be misheard.",
    "create.send": "Send", "create.attach": "Attach", "create.attachRemove": "Remove", "create.attachTooBig": "Attachments cannot exceed {m} MB in total.", "create.attachRead": "Unable to read file: {name}", "create.attachOnly": "Please read the attachments and refine the template accordingly.", "create.thinking": "{st}, {s}s elapsed", "create.stStart": "Analyzing the request", "create.stSearch": "Searching the web, query {n}", "create.stSearched": "Searched: {q}", "create.stWriting": "Writing the reply", "create.stDraft": "Building the template, {n} entries so far", "create.err": "Error: {m}",
    "create.welcome": "Describe the occasion you need to translate, such as an event, program, meeting, lecture or match. The more specific, the better: name, date, speakers or attendees, official links and words likely to be misheard. You can also paste reference material or attach files such as slides, papers, handouts or scripts.\n\nI will search the web and organize the background, translation style, speakers and glossary into the template draft. On a phone, switch to the Draft tab to view it. You can edit the draft at any time and ask me to refine it further.",
    "create.welcomeEdit": "Editing “{name}”. You can ask me to extend the glossary, for example “add today's guests and segment names”, adjust the translation style, or edit the draft directly.",
    "create.updated": "Draft updated: {p} speakers, {n} terms.", "create.noKey": "Please add an OpenAI API key in Settings first.",
    "draft.name": "Template name", "draft.source": "Source language", "draft.target": "Target language",
    "draft.desc": "Background", "draft.descHint": "Context for the translation model, such as the occasion, participants and their relationships.",
    "draft.style": "Translation style", "draft.styleHint": "Specific requirements for the translation, such as forms of address, tone and fixed renderings.",
    "draft.spkNotes": "Speaker cues", "draft.spkNotesHint": "Helps tell speakers apart: how each person introduces themselves, what they call themselves and others, who hosts, verbal habits, and the usual line-up. Used only for speaker identification, not for translation.",
    "draft.asr": "Speech recognition hint", "draft.asrHint": "One or two sentences in the source language describing the audio. Speakers and glossary are appended automatically.",
    "draft.gloss": "Speakers and glossary: {p} speakers, {n} terms", "draft.glossHint": "One entry per line: original | reading | translation | notes. Lines beginning with @ are speakers; lines beginning with # are comments. Recognition uses the original spelling; translation uses the given rendering.",
    "draft.editText": "Edit as text", "draft.viewTable": "Table view", "draft.save": "Save", "draft.saveStart": "Save and start", "draft.discard": "Discard",
    "draft.needName": "Please enter a template name", "draft.discardSure": "Tap again to confirm", "draft.speaker": "Speaker",
    "g.src": "Original", "g.reading": "Reading", "g.tgt": "Translation", "g.notes": "Notes",
    "set.title": "Settings", "set.done": "Done", "sec.general": "General", "set.uiLang": "Interface language", "set.apiKey": "OpenAI API key",
    "set.keyHint": "Optional. If left blank, requests are relayed through this site's server using its configured key, which never appears in the page. If you enter a key, the page connects to OpenAI directly and the key is stored only in this browser.",
    "set.keyHintByok": "The key is stored only in this browser. The page connects to OpenAI directly without going through any server.",
    "sec.lang": "Languages", "set.langHint": "Applies to the current session only and does not change the template. Takes effect when you tap Done.", "set.editTpl": "Edit current template", "set.curTpl": "Current template: {name}",
    "sec.models": "Models", "set.asrModel": "Speech recognition model", "set.mtModel": "Translation model", "set.effort": "Translation reasoning effort", "set.ctModel": "Template creation model", "set.ctModelHint": "Also used for speaker identification and summaries.",
    "ctDesc.gpt-6.1-sol": "Default. Used when creating templates with GPT; good results for web research and glossary building.",
    "ctDesc.gpt-6-luna": "About one tenth the cost of gpt-6.1-sol; research may be less thorough.",
    "asrDesc.gpt-transcribe": "Sentence-by-sentence recognition with high accuracy; the glossary is used as keywords. About a quarter of the cost of gpt-live-transcribe.",
    "asrDesc.gpt-live-transcribe": "Default. Streaming recognition that transcribes as you listen, with low latency; supports the glossary.",
    "mtDesc.gpt-6.1-sol": "Most accurate; average latency about 2.7 seconds, about ten times the cost of gpt-6-luna.",
    "mtDesc.gpt-6-luna": "Default. About one tenth the cost of gpt-6.1-sol, with slightly weaker handling of detail.",
    "opt.effortNone": "Not set", "opt.effortMinimal": "Minimal", "opt.effortLow": "Low", "opt.effortMedium": "Medium", "opt.effortHigh": "High",
    "set.effortHint": "Default is Medium. Higher effort makes translation slower. Choose Not set for non-reasoning models.",
    "set.micDev": "Microphone", "opt.micDefault": "System default", "opt.micN": "Microphone {n}", "opt.micMissing": "Previously selected microphone (not connected)", "set.micDevHint": "Switching while listening takes effect immediately.", "set.micDevNoLabel": "Device names appear here after you start listening and allow microphone access.", "flash.micFallback": "The selected microphone is unavailable; using the system default instead.", "u.x": "{v}×", "u.ms": "{v} ms", "u.s": "{v} s", "u.px": "{v} px", "u.pct": "{v}%",
    "spk.btn": "Speakers", "spk.title": "Speaker identification", "spk.beta": "Experimental", "spk.close": "Close",
   
   
   
   
   
    "spk.judging": "GPT is identifying speakers in {n} lines, {s}s so far (usually under a minute per episode)…", "spk.judged": "{n} lines were decided by GPT from context (dashed tags).",
   
    "spk.by.self_intro": "GPT: self-introduction", "spk.by.addressed": "GPT: answers when addressed", "spk.by.turn_taking": "GPT: turn-taking", "spk.by.content": "GPT: content and speaking habits", "spk.by.voice": "GPT: voice", "spk.by.unknown": "GPT",
    "sec.spk": "Speakers", "spk.settings": "Speaker settings", "spk.on": "Identify speakers", "spk.onHint": "When on, each subtitle line is tagged with who said it: voices are first analyzed and grouped on this device (the first run downloads about 40 MB, no API usage), then GPT uses the subtitles and the current template's people and speaker cues to work out who each group is and fill in uncertain lines (uses the API, a few cents per episode). Runs automatically when a file finishes processing, or right away for files that are already done. Results appear in the subtitles, on the video and in exported files; turning this off hides them without deleting them.", "spk.introOff": "Speaker identification is off. Turn it on to tag each subtitle line with who said it.", "spk.introOn": "These are the voice groups and the names identified. Rename a group if it is wrong, then tap Identify again and GPT will re-check using your names; give several groups the same name to merge them. Tap Listen to hear a typical clip of a group.", "spk.enable": "Turn on speaker identification", "spk.start": "Identify speakers", "spk.rerun": "Identify again", "spk.none": "Not identified yet. Tap Identify speakers.", "spk.wait": "Identification starts automatically when the file finishes processing.", "spk.needKey": "GPT identification needs an API key. Add one in Settings first.", "spk.done": "{k} groups; {a} of {b} lines tagged.", "file.spk": "Subtitles done · Speakers: {m}", "spk.confirm": "Before turning this on: the first run downloads about 40 MB of voice-analysis components (cached by the browser afterwards), so Wi-Fi is recommended. Each file also makes one GPT request, billed to your API key, about a few cents per episode.", "spk.confirmOk": "Turn on", "spk.confirmNo": "Not now", "spk.saveVoices": "Save these voices to the template", "spk.saveVoicesHint": "Save after checking the group names. Files processed later with the same template are matched against these voices to recognize people. Only voice features are stored (about 1 KB per person), no audio; voices with the same name are merged.", "spk.saved": "Saved to the template: {names}", "spk.lib": "Template voice library: {names}", "spk.libNone": "Template voice library: empty", "spk.libMatch": "sounds like {name} (library)", "spk.clearVoices": "Clear voice library", "spk.clearVoicesSure": "Tap again to clear", "spk.n": "Speaker {n}", "spk.unsure": "Uncertain", "spk.play": "Listen", "spk.meta": "{dur} · {n} clips",
    "spk.loadModel": "Loading the voice model {pct}%", "spk.extract": "Re-extracting the audio track…", "spk.embed": "Analyzing voices {i} / {n} clips",
   
    "spk.err": "Analysis failed: {m}", "spk.needMedia": "The original file is required. Select it again first.", "spk.busy": "The file is being processed. Analyze after it finishes or is paused.", "sec.audio": "Audio capture", "set.audioHint": "All settings take effect when you tap Done, except the last three system options, which require stopping and restarting. Microphone changes apply immediately.",
    "set.gain": "Microphone gain", "opt.gainAuto": "Automatic", "opt.gain1": "No amplification", "set.gainHint": "Default is Automatic; the info bar at the bottom shows the current gain. If no subtitles appear far from the source, first check that the signal bars on the left of the info bar are moving.",
    "set.maxGain": "Automatic gain limit", "set.agcTarget": "Automatic gain target level", "set.vad": "Recognition sensitivity", "set.silence": "Silence before sentence break", "set.maxTurn": "Maximum sentence duration", "set.prefix": "Leading audio retained",
    "set.nr": "Cloud noise reduction", "opt.far": "Far field", "opt.near": "Near field", "opt.off": "Off", "set.nrHint": "Off by default to keep the original audio. Choose Far field in noisy settings away from the source, or Near field when close to a speaker or using a headset microphone.",
    "set.micAgc": "System automatic gain", "set.micNs": "System noise suppression", "set.micEc": "System echo cancellation", "set.micHint": "System noise suppression may remove distant voices; echo cancellation is usually unnecessary.", "set.resetAudio": "Restore default audio settings",
    "v.maxGain": "Default 40×. Automatic gain never amplifies beyond this.", "v.agcTarget": "Default 14. Raise it if no subtitles appear; lower it if background noise is transcribed.",
    "v.vad": "Default " + VAD + ". Lower values are more sensitive. Lower it for quiet audio; raise it if applause or laughter triggers recognition.", "v.maxTurn": "Default 8s. Applies to gpt-transcribe only; forces a break under continuous noise or music. Raise it if subtitles are too fragmented.",
    "v.prefix": "Default 300 ms. Raise it if the beginnings of sentences are cut off.", "v.silence": "Default 600 ms. Lower it for rapid exchanges; raise it if subtitles are too fragmented.",
    "sec.display": "Display", "set.showSrc": "Show original text", "set.fontSize": "Subtitle size",
    "sec.records": "Transcript", "rec.copy": "Copy all subtitles", "rec.save": "Download subtitles", "rec.clear": "Clear transcript", "rec.clearSure": "Tap again to confirm",
    "rec.copied": "Copied", "rec.copyFail": "Copy failed. Please use Download", "rec.resetCost": "Reset spend", "rec.costCleared": "Reset complete",
    "rec.memo": "Translation memory · {n}", "rec.memoHint": "While translating, the model notes things useful for later lines here (who is present, the current topic, nicknames, what a term refers to, etc.) and uses them in every following translation; outdated or wrong notes are removed by the model. Saved per session, up to 30 notes.", "rec.memoEmpty": "Nothing noted yet.", "rec.memoClear": "Clear memory", "rec.memoCleared": "Cleared", "rec.recap": "Generate summary", "rec.recapBusy": "Generating summary. This may take a minute or two for long transcripts.", "rec.recapEmpty": "No subtitles recorded yet.", "rec.recapFail": "Summary failed: ",
    "sec.adv": "Advanced", "set.apiBase": "API base URL", "set.ver": "Version {v}",
    "tpl.blank": "General", "tpl.blankDesc": "",
  },
};
let uiLang = store.get("uiLang", /^zh/i.test(navigator.language || "") ? "zh" : "en");
function t(key, vars = {}) { const s = (I18N[uiLang] && I18N[uiLang][key]) ?? I18N.zh[key] ?? key; return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""); }
function applyI18n() {
  document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  document.title = t("app");
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(!SERVER_API && n.dataset.i18n === "set.keyHint" ? "set.keyHintByok" : n.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((n) => (n.placeholder = t(n.dataset.i18nPh)));
  fillLangSelects();
  document.querySelectorAll("section.sess h3").forEach((h) => (h.dataset.chip = t("set.sessChip")));
  $("#buildVer").textContent = t("set.ver", { v: BUILD });
}

// 语言:识别语言(ASR 的 language 参数)和翻译目标语言
const LANGS = {
  ja: { zh: "日语", en: "Japanese", asr: "ja" }, zh: { zh: "中文", en: "Chinese", asr: "zh" }, en: { zh: "英语", en: "English", asr: "en" },
  ko: { zh: "韩语", en: "Korean", asr: "ko" }, fr: { zh: "法语", en: "French", asr: "fr" }, de: { zh: "德语", en: "German", asr: "de" },
  es: { zh: "西班牙语", en: "Spanish", asr: "es" }, auto: { zh: "自动检测", en: "Auto-detect", asr: null },
};
const TARGETS = {
  "zh-Hans": { zh: "简体中文", en: "Simplified Chinese" }, "zh-Hant": { zh: "繁體中文", en: "Traditional Chinese" }, en: { zh: "英语", en: "English" },
  ja: { zh: "日语", en: "Japanese" }, ko: { zh: "韩语", en: "Korean" }, fr: { zh: "法语", en: "French" }, de: { zh: "德语", en: "German" }, es: { zh: "西班牙语", en: "Spanish" },
};
const srcName = (c, l = uiLang) => (LANGS[c] || LANGS.auto)[l];
const tgtName = (c, l = uiLang) => (TARGETS[c] || TARGETS["zh-Hans"])[l];
function fillLangSelects() {
  document.querySelectorAll("select.srcLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(LANGS).map((c) => el("option", { value: c, textContent: srcName(c) }))); if (v) s.value = v; });
  document.querySelectorAll("select.tgtLangs").forEach((s) => { const v = s.value; s.replaceChildren(...Object.keys(TARGETS).map((c) => el("option", { value: c, textContent: tgtName(c) }))); if (v) s.value = v; });
}
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

// ---------- 模板 ----------
// 模板 = { id, name, source, target, description, style, asrPrompt, glossary(文本) }
// 内置模板随页面更新;改过的内置模板以同 id 存在本机,可恢复内置版本
const GENERAL = { id: "general", source: "ja", target: "zh-Hans", description: "", style: "", asrPrompt: "", glossary: "" };
function builtins() { return [...BUILTIN, { ...GENERAL, name: t("tpl.blank") }]; }
function userTemplates() { return store.json("templates", []); }
function allTemplates() {
  const user = userTemplates(), byId = new Map(user.map((x) => [x.id, x]));
  const out = builtins().map((b) => (byId.has(b.id) ? { ...b, ...byId.get(b.id), builtin: true, modified: true } : { ...b, builtin: true }));
  return out.concat(user.filter((x) => !builtins().some((b) => b.id === x.id)));
}
function getTemplate(id) { return allTemplates().find((x) => x.id === id); }
function putTemplate(tp) {
  const prev = getTemplate(tp.id), voices = tp.voices !== undefined ? tp.voices : prev && prev.voices; // 编辑模板时草稿里没有声纹库,沿用原来的
  const clean = { ...(voices && Object.keys(voices).length ? { voices } : {}), id: tp.id, name: tp.name, source: tp.source, target: tp.target, description: tp.description || "", style: tp.style || "", asrPrompt: tp.asrPrompt || "", spkNotes: tp.spkNotes || "", glossary: tp.glossary || "", updatedAt: Date.now() };
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== tp.id).concat(clean)));
  if (cfg.tpl && cfg.tpl.id === tp.id) refreshTemplate();
}
function removeTemplate(id) {
  store.set("templates", JSON.stringify(userTemplates().filter((x) => x.id !== id)));
  if (cfg.tpl && cfg.tpl.id === id) refreshTemplate();
}
function newId() { return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function parseGlossary(text) {
  const people = [], terms = [];
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const person = line.startsWith("@");
    const [src, reading = "", tgt = "", notes = ""] = line.replace(/^@/, "").split("|").map((s) => s.trim());
    if (src) (person ? people : terms).push({ src, reading, tgt, notes });
  }
  return { people, terms };
}
function glossaryText(people, terms) {
  const row = (e, at) => (at ? "@" : "") + [e.src || e.text || "", e.reading || "", e.tgt || e.translation || "", e.notes || ""].join(" | ").replace(/( \| )+$/, "");
  return [...people.map((e) => row(e, true)), ...(people.length && terms.length ? [""] : []), ...terms.map((e) => row(e, false))].join("\n");
}

const cfg = {};
// 收音参数默认值(和设置面板的控件 id 一一对应);和默认值相同就不落盘,以后改默认值设备会跟着变
const AUDIO_DEFAULTS = { gain: "auto", maxGain: 40, agcTarget: 14, vad: VAD, silence: 600, prefix: 300, maxTurn: 8, nr: "off", micAgc: true, micNs: false, micEc: false };
function saveAudioSettings() {
  for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id), v = e.type === "checkbox" ? String(e.checked) : e.value; sset(id, v === String(d) ? null : v); }
}
// ---------- 会话 ----------
// 会话 = {id, name, tplId, source, target, settings, createdAt, updatedAt, count};字幕存在 slines.<id>
// settings 只存和默认值不同的项;没有会话时这些项存在 sessDefaults,作为新会话的初始值
const SESSION_KEYS = ["asrModel", "mtModel", "mtEffort", ...Object.keys(AUDIO_DEFAULTS), "showSrc", "tgtSize"];
let sessions = store.json("sessions", []), curSess = null, sessDefaults = store.json("sessDefaults", {});
function saveSessions() { store.set("sessions", JSON.stringify(sessions)); }
function sessSettings() { return curSess ? (curSess.settings ||= {}) : sessDefaults; }
function sget(k, d) { const v = sessSettings()[k]; return v == null ? d : String(v); }
function sset(k, v) { const o = sessSettings(); if (v == null) delete o[k]; else o[k] = String(v); if (curSess) saveSessions(); else store.set("sessDefaults", JSON.stringify(sessDefaults)); }
function sessTemplate(ss) { return ss && getTemplate(ss.tplId); }
function fmtWhen(ms) { return new Date(ms).toLocaleString(uiLang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function newSession(tplId) {
  const tp = getTemplate(tplId) || builtins()[0], now = Date.now();
  const ss = { id: "s" + now.toString(36) + Math.random().toString(36).slice(2, 6), name: tp.name + " · " + fmtWhen(now), tplId: tp.id, source: tp.source, target: tp.target,
    settings: { ...(curSess ? curSess.settings : sessDefaults) }, createdAt: now, updatedAt: now, count: 0 };
  sessions.push(ss); saveSessions(); useSession(ss.id);
  return ss;
}
// 切换会话:收音中先停;重新读该会话的设置和字幕
function useSession(id) {
  const ss = sessions.find((x) => x.id === id) || null;
  const changed = ss !== curSess;
  if (changed && running) stop();
  if (changed && fileJob.active) filePause();
  curSess = ss; store.set("curSession", ss ? ss.id : null);
  if (changed) { spk = null; spkPanel(false); }
  loadSettings(); refreshTemplate();
  if (changed) {
    clearTimeout(saveLinesTimer);
    lines.length = 0; history.length = 0; queue.length = 0; nextId = 0;
    $("#log").replaceChildren(); $("#partial").textContent = "";
    if (curSess) restoreLines();
    loadMemo();
  }
}
// 会话引用模板:模板改了(补词表等)这里重新取;语言用会话自己的
function refreshTemplate() {
  const tp = sessTemplate(curSess) || builtins().find((x) => x.id === "general");
  cfg.tpl = curSess ? { ...tp, source: curSess.source, target: curSess.target } : tp;
  cfg.glossary = parseGlossary(tp.glossary);
  $("#srcLang").value = cfg.tpl.source; $("#tgtLang").value = cfg.tpl.target;
  $("#curTplName").textContent = curSess ? t("set.sessCur", { name: curSess.name }) + "\n" + t("set.curTpl", { name: tp.name }) : t("set.sessNone");
  $("#langSec .two").hidden = $("#editCurTpl").hidden = !curSess;
  if (running && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "session.update", session: sessionConfig() }));
  if (view === "live" && curSess) $("#title").textContent = curSess.name;
}
function deleteSession(id) {
  sessions = sessions.filter((x) => x.id !== id); saveSessions(); store.set("slines." + id, null); store.set("smemo." + id, null); idb.del(id).catch(() => {}); idb.del("spk:" + id).catch(() => {});
  if (curSess && curSess.id === id) useSession(sessions.length ? [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id : null);
}
// 旧版数据(字幕按模板存、设置全局存)升级成会话:每个有字幕的模板一个会话,当前设置带进去。只复制,不删旧数据
function migrateToSessions() {
  if (store.get("sessMigrated", null)) return;
  const legacy = {};
  for (const k of SESSION_KEYS) { const v = store.get(k, null); if (v != null) legacy[k] = v; }
  if (legacy.showSrc == null && store.get("showJa", null) != null) legacy.showSrc = store.get("showJa", null);
  if (legacy.tgtSize == null && store.get("zhSize", null) != null) legacy.tgtSize = store.get("zhSize", null);
  if (legacy.tgtSize === "24") delete legacy.tgtSize;
  if (legacy.showSrc === "1") delete legacy.showSrc;
  sessDefaults = { ...legacy }; store.set("sessDefaults", JSON.stringify(sessDefaults));
  const cur = store.get("current", null);
  for (const tp of allTemplates()) {
    const arr = store.json("lines." + tp.id, []);
    if (!arr.length) continue;
    const first = arr[0].t || Date.now(), last = arr[arr.length - 1].t || first;
    const ss = { id: "s" + first.toString(36) + Math.random().toString(36).slice(2, 6), name: tp.name + " · " + fmtWhen(first), tplId: tp.id, source: tp.source, target: tp.target,
      settings: { ...legacy }, createdAt: first, updatedAt: last, count: arr.length };
    sessions.push(ss); store.set("slines." + ss.id, JSON.stringify(arr));
    if (tp.id === cur || !store.get("curSession", null)) store.set("curSession", ss.id);
  }
  saveSessions(); store.set("sessMigrated", "1");
}

function loadSettings() {
  $("#secSpk").hidden = !isFileSess();
  $("#spkOn").checked = spkOn();
  document.body.classList.toggle("nospk", !spkOn());
  $("#uiLang").value = uiLang;
  $("#apiKey").value = store.get("apiKey", "");
  $("#asrModel").value = sget("asrModel", ASR_MODEL);
  $("#mtModel").value = sget("mtModel", MT_MODEL);
  $("#ctModel").value = store.get("ctModel", CT_MODEL);
  $("#mtEffort").value = sget("mtEffort", "medium");
  for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id), v = sget(id, String(d)); if (e.type === "checkbox") e.checked = v === "true"; else e.value = v; }
  $("#apiBase").value = store.get("apiBase", "https://api.openai.com/v1");
  $("#showSrc").checked = sget("showSrc", "1") === "1";
  $("#tgtSize").value = sget("tgtSize", "24");
  applySettings();
}
function applySettings() {
  cfg.apiKey = $("#apiKey").value.trim();
  if (!$("#asrModel").value) $("#asrModel").value = ASR_MODEL;
  cfg.asrModel = $("#asrModel").value;
  if (!$("#mtModel").value) $("#mtModel").value = MT_MODEL; // 以前存过不在列表里的模型名
  cfg.mtModel = $("#mtModel").value;
  if (!$("#ctModel").value) $("#ctModel").value = CT_MODEL;
  cfg.ctModel = $("#ctModel").value;
  cfg.mtEffort = $("#mtEffort").value;
  cfg.gain = $("#gain").value; cfg.maxGain = Number($("#maxGain").value) || 20; cfg.agcTarget = (Number($("#agcTarget").value) || 8) / 100;
  cfg.vad = Number($("#vad").value) || 0.3; cfg.prefix = Number($("#prefix").value) || 0; cfg.nr = $("#nr").value;
  cfg.micId = store.get("micId", "");
  cfg.mic = { autoGainControl: $("#micAgc").checked, noiseSuppression: $("#micNs").checked, echoCancellation: $("#micEc").checked };
  cfg.maxTurn = Number($("#maxTurn").value) || 8;
  cfg.silence = Math.max(200, Math.min(3000, parseInt($("#silence").value, 10) || 600));
  showModelHints();
  $("#maxGainV").textContent = t("v.maxGain", { v: cfg.maxGain });
  $("#agcTargetV").textContent = t("v.agcTarget", { v: $("#agcTarget").value });
  $("#vadV").textContent = t("v.vad", { v: Number(cfg.vad.toFixed(2)) });
  $("#maxTurnV").textContent = t("v.maxTurn", { v: cfg.maxTurn });
  $("#prefixV").textContent = t("v.prefix", { v: cfg.prefix });
  $("#silenceV").textContent = t("v.silence", { v: cfg.silence });
  cfg.useServer = !cfg.apiKey && !!SERVER_API && location.protocol === "https:";
  cfg.hasKey = !!cfg.apiKey || cfg.useServer;
  cfg.apiBase = cfg.useServer ? location.origin + SERVER_API : ($("#apiBase").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  document.body.classList.toggle("hidesrc", !$("#showSrc").checked);
  document.documentElement.style.setProperty("--tgt", $("#tgtSize").value + "px");
  updateRangeFill();
  for (const id of ["apiKey", "apiBase"]) store.set(id, $("#" + id).value);
  // 和默认值相同就不落盘,之后更新页面默认值时会跟着换;会话级的项存进当前会话
  store.set("ctModel", $("#ctModel").value === CT_MODEL ? null : $("#ctModel").value);
  for (const [id, d] of [["asrModel", ASR_MODEL], ["mtModel", MT_MODEL], ["mtEffort", "medium"], ["tgtSize", "24"]]) sset(id, $("#" + id).value === d ? null : $("#" + id).value);
  saveAudioSettings();
  sset("showSrc", $("#showSrc").checked ? null : "0");
}

// ---------- 提示词 ----------
function sep() { return CJK.test(cfg.tpl.asrPrompt || cfg.tpl.name) || ["ja", "zh"].includes(cfg.tpl.source) ? "、" : ", "; }
function asrPrompt(maxChars = 900) {
  const { people, terms } = cfg.glossary, s = sep();
  let head = (cfg.tpl.asrPrompt || cfg.tpl.name || "").trim();
  if (head && !/[。.!?！？]$/.test(head)) head += s === "、" ? "。" : ".";
  if (people.length) head += (s === "、" ? "出演:" : " Speakers: ") + people.map((e) => e.src).join(s) + (s === "、" ? "。" : ".");
  let words = "";
  for (const x of terms) {
    const next = words ? words + s + x.src : x.src;
    if (head.length + next.length + 6 > maxChars) break;
    words = next;
  }
  return head + (words ? (s === "、" ? "用語:" : " Terms: ") + words + (s === "、" ? "。" : ".") : "");
}
function keywords(limit = 300) { return [...new Set([...cfg.glossary.people, ...cfg.glossary.terms].map((e) => e.src))].slice(0, limit); }
function glossaryForLLM() {
  const fmt = (e) => "- " + [e.src, e.reading && "reading: " + e.reading, e.tgt && "translation: " + e.tgt, e.notes && "notes: " + e.notes].filter(Boolean).join(" | ");
  const { people, terms } = cfg.glossary;
  return [
    cfg.tpl.description && "Background:\n" + cfg.tpl.description,
    cfg.tpl.style && "Template-specific translation rules (follow these, they override the defaults above):\n" + cfg.tpl.style,
    people.length && "Speakers (almost all speech comes from these people; when a name is misrecognized, prefer correcting to one of these):\n" + people.map(fmt).join("\n"),
    terms.length && "Glossary / proper nouns:\n" + terms.map(fmt).join("\n"),
  ].filter(Boolean).join("\n\n");
}
const SYSTEM = () => {
  const src = cfg.tpl.source === "auto" ? "speech (language may vary)" : srcName(cfg.tpl.source, "en") + " speech", tgt = tgtName(cfg.tpl.target, "en");
  return `You are a live subtitle translator. The input is real-time speech recognition (ASR) of ${src} from: ${cfg.tpl.name || "a live event"}. The audience needs ${tgt} subtitles.

How to work:
1. Fix the source text first: ASR often mishears names, titles and jargon as similar-sounding words and drops punctuation. If something sounds close to a glossary entry and the context fits, change it to the glossary spelling; if unsure, keep it. Never invent content. Laughter and filler can be trimmed. Put the corrected source text in "src".
2. Translate into ${tgt} in "tgt": natural spoken style, concise, readable at a glance as a subtitle; keep the speaker's tone (teasing, surprise, etc.). Use the glossary translations for names and terms strictly; names with no translation stay in the original.
3. One output item per input item, same id. Return empty "src" and "tgt" only when the input is pure noise, applause or music with no recognizable words. Far-field ASR is often fragmentary: if any meaning can be recovered, translate it, marking uncertain parts with "(?)".
4. If a segment is already in ${tgt}, still return it in "tgt" (cleaned up).
5. "Recent context" is only for understanding references and topics; do not translate it again.
6. "Running notes" are facts you recorded earlier for translating later lines. Use them. In "memory", you may add notes that will help translate later lines and are not already covered by the glossary or notes: who is present or speaking, the current segment/topic, nicknames and how people address each other, what an ambiguous word or name refers to here, recurring jokes, how you resolved a mishearing. One short sentence each, written in English. Add nothing for ordinary lines (usually "add" is empty). Put in "drop" the numbers of notes that became outdated or turned out wrong.

${glossaryForLLM()}`;
};
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "src", "tgt"],
    properties: { id: { type: "integer" }, src: { type: "string" }, tgt: { type: "string" } } } }, memory: MEMO_SCHEMA },
};
SCHEMA.required.push("memory");

// ---------- 字幕列表 ----------
const lines = [];          // {id, raw, src, tgt, t, el}
let follow = true;
function linesKey() { return "slines." + (curSess ? curSess.id : "none"); }
// 翻译记忆(见 memo.ts):按会话存,随字幕一起清空
let memo = [];
function loadMemo() { memo = curSess ? store.json("smemo." + curSess.id, []) : []; renderMemo(); }
function setMemo(next, ss = curSess) { if (ss !== curSess) return; memo = next; if (ss) store.set("smemo." + ss.id, memo.length ? JSON.stringify(memo) : null); renderMemo(); }
function renderMemo() {
  $("#memoSum").textContent = t("rec.memo", { n: memo.length });
  $("#memoList").replaceChildren(...(memo.length ? memo.map((m) => el("li", { textContent: m })) : [el("li", { className: "empty", textContent: t("rec.memoEmpty") })]));
}
function showEmptyHint() {
  if (isFileSess()) return;
  if (lines.length || $("#log").children.length) return;
  $("#log").append(el("div", { className: "empty", id: "emptyHint", textContent: t(cfg.hasKey ? "live.empty" : "live.emptyKey") }));
}
function addLine(id, raw) {
  const h = $("#emptyHint"); if (h) h.remove();
  const e = el("div", { className: "row pending" }, el("div", { className: "tgt", textContent: t("line.translating") }), el("div", { className: "src", textContent: raw }));
  $("#log").append(e);
  const line = { id, raw, src: raw, tgt: "", t: new Date(), el: e, done: false };
  e.onclick = () => { if (isFileSess() && line.ms != null) seekTo(line.ms); };
  lines.push(line);
  scrollEnd();
  saveLines();
  return line;
}
// 字幕存到本地(按模板分开):刷新、误触下拉刷新、iOS 回收标签页之后打开还在
let saveLinesTimer = null;
function saveLines() {
  clearTimeout(saveLinesTimer);
  const key = linesKey();
  const ss = curSess;
  saveLinesTimer = setTimeout(() => {
    store.set(key, JSON.stringify(lines.map((l) => ({ id: l.id, raw: l.raw, src: l.src, tgt: l.tgt, t: l.t.getTime(), done: l.done, ...(l.ms != null ? { s: l.ms, e: l.endMs } : {}), ...(l.spk != null ? { k: l.spk, kc: l.spc, ...(l.spkBy ? { kb: l.spkBy } : {}) } : {}) }))));
    if (ss) { ss.count = lines.length; ss.updatedAt = Date.now(); saveSessions(); }
  }, 500);
}
function restoreLines() {
  const saved = store.json(linesKey(), []);
  if (!saved.length) return showEmptyHint();
  for (const s of saved) {
    const line = addLine(s.id, s.raw);
    line.src = s.src ?? s.ja ?? s.raw; line.tgt = s.tgt ?? s.zh ?? ""; line.t = new Date(s.t);
    if (s.s != null) setLineTime(line, s.s, s.e);
    if (s.k != null) { line.spk = s.k; line.spc = s.kc; if (s.kb) line.spkBy = s.kb; paintSpk(line); }
    if (s.done) { line.done = true; renderLine(line, false); }
    else { line.el.className = "row"; line.el.querySelector(".tgt").textContent = t("line.unfinished"); }
    if (line.done && line.src) history.push(line);
    nextId = Math.max(nextId, s.id);
  }
  $("#log").append(el("div", { className: "empty sep", textContent: t("line.sep", { n: saved.length }) }));
  clearTimeout(saveLinesTimer); // 只是恢复显示,不算新的活动,别改会话的最后更新时间
}
// 超长的一条(几个人的话被并成一句)按句末标点分行显示,内容不变
function breakLong(s) { return s.length > (CJK.test(s) ? 40 : 90) ? s.replace(/([。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))\s*(?=\S)/g, "$1\n") : s; }
// 只有几个字的碎句(「那……」「好。」「OK.」)且紧跟上一条,就并进上一条,少占一行
const MERGE_GAP_MS = 3000;
function isShort(s) {
  const x = s.replace(/[\s。、！？!?,.，…「」『』()（）ー〜~"']/g, "");
  return CJK.test(x) ? x.length <= 4 : s.trim().split(/\s+/).filter(Boolean).length <= 2;
}
function tryMerge(line) {
  if (isFileSess()) return false; // 文件会话按说话人断句:不合并,免得把不同人的话拼成一行
  const i = lines.indexOf(line), prev = lines[i - 1];
  if (i < 1 || !prev.done || !prev.tgt || !prev.el.isConnected || prev.tgt.length > 60) return false;
  if (line.t - (prev.tEnd || prev.t) > MERGE_GAP_MS || !isShort(line.src)) return false;
  prev.src += " " + line.src; prev.tgt += " " + line.tgt; prev.raw += " " + line.raw; prev.tEnd = line.t;
  if (line.endMs != null) prev.endMs = line.endMs;
  prev.el.querySelector(".tgt").textContent = breakLong(prev.tgt);
  prev.el.querySelector(".src").textContent = breakLong(prev.src);
  line.el.remove(); lines.splice(i, 1); saveLines(); scrollEnd();
  return true;
}
function renderLine(line, merge = true) {
  line.done = true; saveLines();
  if (!line.tgt.trim()) line.tgt = "";
  if (!line.tgt && line.failed) { line.el.className = "row"; line.el.querySelector(".tgt").textContent = t("line.failed"); line.el.querySelector(".src").textContent = breakLong(line.src || line.raw); return; }
  if (!line.tgt) {
    diag.noise++; showLat();
    // 原始识别有实际内容(不只是标点/单个语气词)就别删,灰显原文
    if (/[\p{L}]{3,}/u.test(line.raw)) { line.src = line.raw; line.el.className = "row pending"; line.el.querySelector(".tgt").textContent = t("line.noise"); line.el.querySelector(".src").textContent = line.raw; return; }
    line.el.remove(); return;
  }
  if (merge && tryMerge(line)) return;
  line.el.className = "row";
  line.el.querySelector(".tgt").textContent = breakLong(line.tgt);
  line.el.querySelector(".src").textContent = breakLong(line.src);
  scrollEnd();
}
function scrollEnd() { if (follow) { const m = $("#log"); m.scrollTop = m.scrollHeight; } }
$("#log").addEventListener("scroll", () => {
  const m = $("#log");
  const atEnd = m.scrollHeight - m.scrollTop - m.clientHeight < 40;
  if (!atEnd && follow && userScrolled) setFollow(false);
});
let userScrolled = false;
$("#log").addEventListener("touchstart", () => (userScrolled = true), { passive: true });
$("#log").addEventListener("wheel", () => (userScrolled = true), { passive: true });
function setFollow(v) { follow = v; const b = $("#follow"); b.textContent = t(v ? "live.follow" : "live.unfollow"); b.classList.toggle("off", !v); if (v) { userScrolled = false; scrollEnd(); } }
$("#follow").onclick = () => setFollow(!follow);

// ---------- 翻译(OpenAI Chat Completions) ----------
const queue = [];
let translating = false;
const history = [];
async function pumpTranslate() {
  if (translating || !queue.length) return;
  translating = true;
  const batch = queue.splice(0, 6);
  const tplId = cfg.tpl.id, ss = curSess;
  try {
    const ctx = history.slice(-8).map((l) => `${l.src} → ${l.tgt}`).join("\n") || "(none)";
    const user = `Running notes:\n${memoPrompt(memo)}\n\nRecent context (already translated, reference only):\n${ctx}\n\nNew ASR segments:\n` + JSON.stringify(batch.map((l) => ({ id: l.id, asr: l.raw })));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const mtStart = performance.now();
    const res = await fetch(cfg.apiBase + "/chat/completions", {
      method: "POST", signal: ctl.signal,
      headers: apiHeaders(),
      body: JSON.stringify({
        model: cfg.mtModel, ...effort(),
        messages: [{ role: "system", content: SYSTEM() }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "subtitles", strict: true, schema: SCHEMA } },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    addMtCost(cfg.mtModel, data.usage);
    lat.mt = performance.now() - mtStart; mtHist.push(lat.mt); if (mtHist.length > 10) mtHist.shift();
    lat.mtAvg = mtHist.reduce((a, b) => a + b, 0) / mtHist.length; showLat();
    if (cfg.tpl.id !== tplId) return; // 翻译途中换了模板,这批行已经不在页面上
    const out = JSON.parse(data.choices[0].message.content), items = out.items || [];
    setMemo(applyMemo(memo, out.memory), ss);
    const byId = new Map(items.map((it) => [it.id, it]));
    for (const l of batch) {
      const it = byId.get(l.id);
      if (it) { l.src = it.src.trim(); l.tgt = it.tgt.trim(); }
      renderLine(l);
      if (l.src) history.push(l);
    }
  } catch (e) {
    console.error(e);
    flash(t("flash.mt") + (e.name === "AbortError" ? t("flash.timeout") : e.message)); diag.err++;
    if (cfg.tpl.id === tplId) for (const l of batch) { l.tgt = ""; l.failed = true; renderLine(l); }
  } finally {
    translating = false;
    pumpTranslate();
  }
}
function apiHeaders() { return { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}) }; }
function effort() { return cfg.mtEffort ? { reasoning_effort: cfg.mtEffort } : {}; }
function flash(msg) { const p = $("#partial"); p.textContent = msg; p.style.color = "var(--bad)"; setTimeout(() => (p.style.color = ""), 4000); }

// ---------- 识别(OpenAI Realtime 转写会话,WebSocket) ----------
let ws = null, running = false, nextId = 0, reconnectTimer = null;
const partial = new Map();
// 流式模型:不支持 turn_detection,整段音频只在一个 item 里不断吐 delta,没有 completed。
// 所以客户端按句末标点切句;停顿 LIVE_IDLE_MS 没新 delta 就把剩下的也当一句,并 commit 一下让服务端开新 item。
const STREAMING_ASR = new Set(["gpt-live-transcribe", "gpt-realtime-whisper"]);
const LIVE_IDLE_MS = 2000;
let liveBuf = "", liveIdle = null, liveUncommitted = false;
function isStreamingAsr() { return STREAMING_ASR.has(cfg.asrModel); }
function sessionConfig() {
  const streaming = isStreamingAsr();
  const transcription = { model: cfg.asrModel };
  const lang = (LANGS[cfg.tpl.source] || LANGS.auto).asr;
  if (lang) transcription.language = lang;
  // 实测 gpt-transcribe:关键词 + 提示一起给最准(只给提示时节目名写成片假名,都不给时羊宮妃那听成陽空ひな)
  const kw = keywords();
  if ((cfg.asrModel === "gpt-live-transcribe" || cfg.asrModel === "gpt-transcribe") && kw.length) transcription.keywords = kw;
  const prompt = asrPrompt();
  if (cfg.asrModel !== "gpt-realtime-whisper" && prompt) transcription.prompt = prompt; // whisper 两个都不收
  return { type: "transcription", audio: { input: {
    format: { type: "audio/pcm", rate: 24000 },
    transcription,
    noise_reduction: cfg.nr === "off" ? null : { type: cfg.nr },
    turn_detection: streaming ? null : { type: "server_vad", threshold: cfg.vad, prefix_padding_ms: cfg.prefix, silence_duration_ms: cfg.silence },
  } } };
}
function emitLine(text) {
  // 只有标点/空白的碎片(比如 delta 开头单独一个「。」)丢掉
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  diag.asr++; queue.push(addLine(++nextId, text)); pumpTranslate(); showLat();
}
function liveDelta(delta) {
  liveBuf += delta; liveUncommitted = true;
  // 日中文只按全角句末标点断句:半角 ! ? 常出现在节目名里(EXTEND STEP HOOOOPE!);其他语言按半角句末 + 空格
  const re = ["ja", "zh"].includes(cfg.tpl.source) ? /^[\s\S]*?[。！？]+[」』）)]*/ : /^[\s\S]*?(?:[。！？]+[」』）)]*|[.!?]+["')\]]*(?=\s))/;
  let m;
  while ((m = liveBuf.match(re))) {
    emitLine(m[0].trim());
    liveBuf = liveBuf.slice(m[0].length);
  }
  liveBuf = liveBuf.replace(/^\s+/, "");
  $("#partial").textContent = liveBuf;
  clearTimeout(liveIdle);
  liveIdle = setTimeout(liveFlush, LIVE_IDLE_MS);
}
function liveFlush() {
  clearTimeout(liveIdle); liveIdle = null;
  const s = liveBuf.trim(); liveBuf = "";
  $("#partial").textContent = "";
  emitLine(s);
  // 停顿时 commit,免得一整场都堆在同一个 item 里;commit 后的 completed 文本已经按 delta 出过了,忽略
  if (liveUncommitted && ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); liveUncommitted = false; }
}
let speechSince = 0, turnEndAt = 0;
// 实时延迟显示:翻译 = 请求往返;识别 = 云端判定一句结束(或强制断句)到出识别结果,流式模型没有句末信号所以不测
const lat = { asr: 0, mt: 0, mtAvg: 0 };
const mtHist = [];
const diag = { asr: 0, noise: 0, err: 0, deltas: 0 }; // 现场排障计数
function fmtS(ms) { return ms ? t("sec", { s: (ms / 1000).toFixed(1) }) : "—"; }
function showLat() {
  const asr = isStreamingAsr() ? t("lat.stream") : fmtS(lat.asr);
  const gain = running && !micBroken ? agcGain.toFixed(agcGain < 10 ? 1 : 0) + "×" : "—";
  const item = (k, v, cls = "") => el("span", { className: "ib " + cls }, el("span", { className: "k", textContent: t(k) }), el("b", { textContent: String(v) }));
  $("#ibItems").replaceChildren(...[
    isFileSess() ? null : item("ib.gain", gain), isFileSess() ? null : item("ib.asr", asr), item("ib.mt", fmtS(lat.mt)), item("ib.avg", fmtS(lat.mtAvg)),
    queue.length ? item("ib.queue", queue.length, "warn") : null,
    item("ib.lines", diag.asr), item("ib.noise", diag.noise), item("ib.err", diag.err, diag.err ? "bad" : ""),
    item("ib.cost", "$" + cost.total().toFixed(cost.total() < 1 ? 3 : 2)),
  ].filter(Boolean));
  $("#infobar").title = t("ib.deltas", { n: diag.deltas }); $("#signal").title = t("ib.level");
  showCost();
}
// 费用估算(官方单价,美元)
const ASR_PRICE_PER_MIN = { "gpt-live-transcribe": 0.017, "gpt-realtime-whisper": 0.017, "gpt-transcribe": 0.0045, "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003 };
const MT_PRICE = { "gpt-6-sol": [2.0, 0.2, 10.0], "gpt-6.1-sol": [2.0, 0.1, 10.0], "gpt-6-luna": [0.1, 0.01, 0.5] }; // 输入 / 缓存输入 / 输出
const WEB_SEARCH_PER_CALL = 0.01;
const cost = {
  asr: Number(store.get("costAsr", "0")) || 0, mt: Number(store.get("costMt", "0")) || 0,
  total() { return this.asr + this.mt; },
  save() { store.set("costAsr", String(this.asr)); store.set("costMt", String(this.mt)); },
};
let costShownAt = 0;
function showCost() {
  const usd = (v) => "$" + v.toFixed(v < 1 ? 3 : 2);
  $("#costOut").textContent = t("cost", { a: usd(cost.asr), m: usd(cost.mt), t: usd(cost.total()) });
}
function addAsrCost(seconds, model = cfg.asrModel) {
  cost.asr += (seconds / 60) * (ASR_PRICE_PER_MIN[model] || 0.017);
  if (performance.now() - costShownAt > 1000) { costShownAt = performance.now(); cost.save(); showLat(); }
}
// 兼容 Chat Completions(prompt_tokens)和 Responses(input_tokens)两种 usage
function addMtCost(model, u, extra = 0) {
  if (!u) return;
  const [pin, pcache, pout] = MT_PRICE[model] || MT_PRICE["gpt-6-sol"];
  const input = u.prompt_tokens ?? u.input_tokens ?? 0, output = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = (u.prompt_tokens_details || u.input_tokens_details || {}).cached_tokens || 0;
  cost.mt += ((input - cached) * pin + cached * pcache + output * pout) / 1e6 + extra;
  cost.save(); showLat();
}
setInterval(() => {
  if (!running || isStreamingAsr() || !speechSince || !ws || ws.readyState !== 1) return;
  if (performance.now() - speechSince > cfg.maxTurn * 1000) {
    speechSince = performance.now();
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }
}, 250);
function connect() {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  setStatus("status.connecting", "warn");
  ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]);
  liveUncommitted = false;
  ws.onopen = () => { ws.send(JSON.stringify({ type: "session.update", session: sessionConfig() })); setStatus("status.listening", "on"); showLat(); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    // 强制断句:持续噪声/背景音乐下 server VAD 一直认为在说话,一句话要等很久才出
    if (m.type === "input_audio_buffer.speech_started") speechSince = performance.now();
    else if (m.type === "input_audio_buffer.speech_stopped") { speechSince = 0; turnEndAt = performance.now(); }
    else if (m.type === "input_audio_buffer.committed" && !isStreamingAsr() && !turnEndAt) turnEndAt = performance.now(); // 强制断句
    if (m.type === "conversation.item.input_audio_transcription.completed" && !isStreamingAsr() && turnEndAt) { lat.asr = performance.now() - turnEndAt; turnEndAt = 0; showLat(); }
    if (m.type === "conversation.item.input_audio_transcription.delta") { diag.deltas++; if (diag.deltas % 10 === 1) showLat(); }
    if (m.type === "conversation.item.input_audio_transcription.delta" && isStreamingAsr()) {
      liveDelta(m.delta || "");
    } else if (m.type === "conversation.item.input_audio_transcription.completed" && isStreamingAsr()) {
      // 已经按 delta 切过句了
    } else if (m.type === "conversation.item.input_audio_transcription.delta") {
      const s = (partial.get(m.item_id) || "") + (m.delta || "");
      partial.set(m.item_id, s);
      $("#partial").textContent = s;
    } else if (m.type === "conversation.item.input_audio_transcription.completed") {
      partial.delete(m.item_id);
      $("#partial").textContent = "";
      const text = (m.transcript || "").trim();
      if (text) emitLine(text);
    } else if (m.type === "error") {
      const msg = (m.error && (m.error.message || m.error.code)) || "?";
      console.error(m);
      flash(t("flash.asr") + msg); diag.err++; showLat();
      if (/api key|auth|unauthorized|invalid_api_key/i.test(msg)) { stop(); setStatus("status.keyBad", "err"); }
    }
  };
  speechSince = 0;
  ws.onclose = (ev) => {
    if (!running) return;
    setStatus("status.reconnect", "err");
    console.warn("ws closed", ev.code, ev.reason);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => running && connect(), 1500);
  };
  ws.onerror = () => {};
}
// 状态:key 是 I18N 键,extra 是附加的原样文字(增益倍数等)
let statusKey = "status.idle", statusKind = "", statusExtra = "";
function setStatus(key, kind, extra = "") { statusKey = key; statusKind = kind || ""; statusExtra = extra; const s = $("#status"); s.textContent = t(key) + extra; s.className = "chip" + (kind ? " " + kind : ""); }

// ---------- 麦克风 → 24 kHz PCM16 ----------
let stream = null, actx = null, tap = null, wakeLock = null;
let carry = new Float32Array(0), resamplePos = 0, prevSample = 0;
const CHUNK = 2400; // 100 ms @ 24 kHz
function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength); // 可能是大数组的切片
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// 数字增益:离声源远、收音小声时放大。自动模式跟踪语音电平,放大到目标电平(最多 cfg.maxGain 倍)
let agcLevel = 0.01, agcGain = 1, gainShownAt = 0;
function applyGain(x) {
  if (!x.length) return x;
  let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / x.length) + 1e-9;
  let want;
  if (cfg.gain === "auto") {
    // 有声时较快跟上,安静时慢慢回落,免得把底噪放大到满格
    agcLevel = rms > agcLevel * 0.5 ? agcLevel * 0.997 + rms * 0.003 : agcLevel * 0.9995 + rms * 0.0005;
    want = Math.min(cfg.maxGain, Math.max(1, cfg.agcTarget / agcLevel));
  } else want = Number(cfg.gain) || 1;
  agcGain = agcGain * 0.99 + want * 0.01;
  if (running && !micBroken && performance.now() - gainShownAt > 1000) { gainShownAt = performance.now(); showLat(); }
  if (agcGain === 1) return x;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = Math.max(-1, Math.min(1, x[i] * agcGain));
  return y;
}
// 信号格:放大后的音量分 5 格,只在格数变化时改 DOM
const SIG_STEPS = [0.03, 0.1, 0.22, 0.4, 0.7];
function setSignal(v) {
  const n = SIG_STEPS.filter((x) => v >= x).length, s = $("#signal");
  if (s.dataset.level !== String(n)) s.dataset.level = n;
}
let lastSampleAt = 0;
function onSamples(input) {
  if (!actx) return; // 停止后 worklet 可能还有一条消息在路上
  lastSampleAt = performance.now();
  // 线性重采样到 24 kHz(AudioContext 拿不到 24 kHz 时才用到)
  let x = input;
  if (actx.sampleRate !== 24000) {
    const ratio = actx.sampleRate / 24000, out = [];
    // resamplePos 可能落在 [-1, 0):用上一块的最后一个样本插值(原先读 input[-1] 得到 NaN)
    while (resamplePos < input.length - 1) {
      const i = Math.floor(resamplePos), f = resamplePos - i;
      out.push((i < 0 ? prevSample : input[i]) * (1 - f) + input[i + 1] * f);
      resamplePos += ratio;
    }
    resamplePos -= input.length;
    prevSample = input[input.length - 1];
    x = Float32Array.from(out);
  }
  x = applyGain(x);
  let rms = 0; for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  setSignal(Math.sqrt(rms / (x.length || 1)) * 4);
  const merged = new Float32Array(carry.length + x.length);
  merged.set(carry); merged.set(x, carry.length);
  let off = 0;
  while (merged.length - off >= CHUNK) {
    const pcm = new Int16Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) { const v = Math.max(-1, Math.min(1, merged[off + i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    off += CHUNK;
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) })); addAsrCost(CHUNK / 24000); }
  }
  carry = merged.slice(off);
}
async function startMic() {
  // iOS Safari:AudioContext 要在点击的同步阶段建好并 resume(await 之后就不算用户手势了);
  // 也不能指定 24 kHz(和硬件采样率不一致时麦克风只出静音),统一用默认采样率再在 JS 里重采样
  const Ctx = window.AudioContext || window.webkitAudioContext;
  actx = new Ctx();
  const resumed = actx.resume().catch(() => {});
  const want = { channelCount: 1, ...cfg.mic };
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: cfg.micId ? { ...want, deviceId: { exact: cfg.micId } } : want }); }
  catch (e) {
    // 选定的麦克风拔掉了:退回系统默认,不让整个收音失败
    if (!cfg.micId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(e.name)) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: want }); flash(t("flash.micFallback"));
  }
  listMics();
  await resumed; actx.resume().catch(() => {});
  const code = `class Tap extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor("tap", Tap);`;
  await actx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
  const src = actx.createMediaStreamSource(stream);
  tap = new AudioWorkletNode(actx, "tap");
  tap.port.onmessage = (e) => onSamples(e.data);
  const mute = actx.createGain(); mute.gain.value = 0;
  src.connect(tap); tap.connect(mute); mute.connect(actx.destination);
}
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (running && document.visibilityState === "visible") { keepAwake(); actx && actx.resume(); } });

async function start() {
  applySettings();
  if (!cfg.hasKey) { openSettings(); $("#apiKey").focus(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices) { setStatus("status.https", "err"); flash(t("flash.https")); return; }
  try { await startMic(); } catch (e) { setStatus("status.noMic", "err"); flash(t("flash.mic") + e.message); return; }
  running = true; micBroken = false; lastSampleAt = performance.now();
  $("#go").textContent = t("live.stop"); $("#go").classList.add("stop");
  keepAwake();
  connect();
}
function stop() {
  running = false;
  speechSince = 0;
  clearTimeout(reconnectTimer);
  if (liveBuf) liveFlush();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (stream) stream.getTracks().forEach((x) => x.stop());
  if (actx) actx.close();
  stream = actx = tap = null; carry = new Float32Array(0); resamplePos = 0; agcLevel = 0.01; agcGain = 1;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  $("#go").textContent = t("live.start"); $("#go").classList.remove("stop");
  setSignal(0); showLat();
  setStatus("status.stopped");
}
$("#go").onclick = () => (isFileSess() ? (fileJob.active ? filePause() : fileStart()) : running ? stop() : start());
// iOS:音频上下文偶尔起不来(suspended),点一下屏幕任意处再试
document.addEventListener("touchend", () => {
  if (!running) return;
  if (micBroken) restartMic(); // 在点击里重建,iOS 才允许音频上下文启动
  else if (actx && actx.state !== "running") actx.resume().catch(() => {});
}, { passive: true });
// 麦克风看门狗:iOS 锁屏/切后台/来电后麦克风可能中断,页面却还显示收音中。
// 发现音轨结束、被静音、音频上下文没在跑或 2.5 秒没收到采样,就自动重开麦克风;重开不成功就提示点屏幕
let micBroken = false, micRestarting = false, lastRestartAt = 0;
function micProblem() {
  const tr = stream && stream.getAudioTracks()[0];
  if (!tr || tr.readyState === "ended") return "mic.ended";
  if (tr.muted) return "mic.muted";
  if (actx && actx.state !== "running") return "mic.ctx";
  if (performance.now() - lastSampleAt > 2500) return "mic.nodata";
  return "";
}
setInterval(() => {
  if (!running || micRestarting || document.visibilityState !== "visible") return;
  const why = micProblem();
  if (!why) { if (micBroken) { micBroken = false; setStatus("status.listening", "on"); } return; }
  micBroken = true;
  setStatus(why, "err", t("status.tapFix"));
  if (performance.now() - lastRestartAt > 4000) restartMic();
}, 1000);
async function restartMic() {
  if (micRestarting) return;
  micRestarting = true; lastRestartAt = performance.now();
  try {
    if (stream) stream.getTracks().forEach((x) => x.stop());
    if (actx) actx.close().catch(() => {});
    stream = actx = tap = null; carry = new Float32Array(0); resamplePos = 0; prevSample = 0;
    await startMic();
    lastSampleAt = performance.now();
  } catch (e) {
    console.error(e);
    setStatus("status.micCant", "err");
  } finally { micRestarting = false; }
}

// ---------- 视图切换 ----------
let view = "home";
function show(v) {
  if (v === "live" && !curSess) v = "home";
  view = v; document.body.dataset.view = v;
  for (const [id, name] of [["#viewHome", "home"], ["#viewTpl", "tpl"], ["#viewLive", "live"], ["#viewCreate", "create"]]) $(id).hidden = v !== name;
  $("#toHome").hidden = v === "home"; $("#toTpl").hidden = v === "tpl";
  $("#title").textContent = v === "live" ? curSess.name : v === "create" ? t(creator.editId ? "create.titleEdit" : "create.titleNew") : v === "tpl" ? t("tpl.title") : t("app");
  document.title = $("#title").textContent;
  if (v === "home") renderSessions();
  if (v === "tpl") renderHome();
  if (v === "live") { setupFileView(); showEmptyHint(); scrollEnd(); }
  if (v !== "live") spkPanel(false);
  if (v === "create") renderCreator();
  store.set("view", v);
}
$("#toHome").onclick = () => show("home");
$("#toTpl").onclick = () => show("tpl");
$("#newSession").onclick = () => show("tpl");


// ---------- 文件翻译 ----------
// 浏览器内用 ffmpeg.wasm 提取音轨(边读边解,不把整个视频读进内存)→ 24 kHz 单声道 PCM → 按 FILE_SPEED 倍速送进实时转写
// 固定 gpt-transcribe + server VAD:每段都有 audio_start_ms / audio_end_ms,字幕能和视频精确对齐(以后声纹切片也靠它)
// 实测 4 倍速与 1 倍速识别结果一致,8 倍速开始丢字
const FILE_SPEED = 4, MEDIA_BASE = new Date(2000, 0, 1).getTime();
const fileJob = { active: false, phase: "idle", sid: null, pcm: null, pos: 0, total: 0, t0: 0, from: 0, ws: null, items: {}, pending: 0, lastEnd: 0, speakFrom: null, lastEvt: 0, err: "", extractPct: 0 };
function isFileSess() { return !!(curSess && curSess.kind === "file"); }
function fmtClock(ms) { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }
function setLineTime(line, s, e) {
  line.ms = s; line.endMs = e; line.t = new Date(MEDIA_BASE + e);
  if (!line.el.querySelector(".tm")) line.el.prepend(el("div", { className: "tm", textContent: fmtClock(s) }));
}
// 原文件存在浏览器 IndexedDB,刷新后还能播放、续处理
const idb = {
  db: null,
  open() { return (this.db ||= new Promise((ok, bad) => { const r = indexedDB.open("jls", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); })); },
  async run(mode, fn) { const db = await this.open(); return new Promise((ok, bad) => { const tx = db.transaction("files", mode); const rq = fn(tx.objectStore("files")); tx.oncomplete = () => ok(rq.result); tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error); }); },
  put(k, v) { return this.run("readwrite", (st) => st.put(v, k)); },
  get(k) { return this.run("readonly", (st) => st.get(k)); },
  del(k) { return this.run("readwrite", (st) => st.delete(k)); },
};
let mediaBlob = null, mediaUrl = null, pickFor = null;
// 先直接存 File;Safari 无痕模式等不让存 Blob 时,300 MB 以内改存 ArrayBuffer
async function storeMedia(id, f) {
  try { await idb.put(id, f); return true; } catch {}
  if (f.size > 300 * 1048576) return false;
  try { await idb.put(id, { name: f.name, type: f.type, buf: await f.arrayBuffer() }); return true; } catch { return false; }
}
async function loadMedia(id) {
  const v = await idb.get(id).catch(() => null);
  return v && v.buf ? new File([v.buf], v.name, { type: v.type }) : v || null;
}
function pickMedia(tplId) { pickFor = { tplId }; $("#mediaFile").value = ""; $("#mediaFile").click(); }
$("#reattach").onclick = () => { pickFor = { reattach: curSess.id }; $("#mediaFile").value = ""; $("#mediaFile").click(); };
$("#mediaFile").onchange = async () => {
  const f = $("#mediaFile").files[0]; if (!f || !pickFor) return;
  let ss;
  if (pickFor.reattach) ss = sessions.find((x) => x.id === pickFor.reattach);
  else {
    ss = newSession(pickFor.tplId);
    Object.assign(ss, { kind: "file", name: f.name.replace(/\.[^.]+$/, ""), file: { name: f.name, size: f.size, type: f.type, duration: 0 }, progress: 0, done: false });
    saveSessions();
  }
  pickFor = null; mediaBlob = f; fileJob.pcm = null; fileJob.sid = null;
  ss.file.stored = await storeMedia(ss.id, f);
  if (!ss.file.stored) flash(t("file.noStore"));
  saveSessions(); useSession(ss.id); show("live");
  if (ss.done) spkAuto(ss);
};
async function setupFileView() {
  const on = isFileSess();
  document.body.classList.toggle("filemode", on);
  $("#playerBox").hidden = $("#fileBar").hidden = !on;
  if (!on) { $("#go").textContent = t(running ? "live.stop" : "live.start"); return; }
  const ss = curSess;
  if (!mediaBlob || fileJob.sid !== ss.id) { mediaBlob = await loadMedia(ss.id) || (mediaBlob && mediaBlob.name === ss.file.name && fileJob.sid == null ? mediaBlob : null); fileJob.sid = ss.id; fileJob.pcm = null; }
  if (curSess !== ss) return;
  const p = $("#player");
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = mediaBlob ? URL.createObjectURL(mediaBlob) : null;
  if (mediaUrl) p.src = mediaUrl; else p.removeAttribute("src");
  $("#playerBox").classList.toggle("audio", /^audio\//.test(ss.file.type) || /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(ss.file.name));
  $("#playerBox").hidden = !mediaBlob;
  $("#reattach").hidden = true; // 缺文件时主按钮就是「重新选择原文件」
  p.onloadedmetadata = () => { if (isFinite(p.duration) && !ss.file.duration) { ss.file.duration = p.duration * 1000; saveSessions(); fileProgress(); } };
  fileJob.phase = fileJob.active ? fileJob.phase : ss.done ? "done" : ss.progress ? "paused" : "idle";
  fileProgress();
}
// 播放时叠加当前字幕、高亮对应行
$("#player").ontimeupdate = () => {
  const ms = $("#player").currentTime * 1000;
  let cur = null;
  for (const l of lines) { if (l.ms == null) continue; if (l.ms <= ms + 150 && ms <= l.endMs + 400) cur = l; if (l.ms > ms + 150) break; }
  $("#ovl .ot").textContent = cur && cur.tgt ? spkPrefix(cur) + cur.tgt : ""; $("#ovl .os").textContent = cur ? cur.src : "";
  if (spkStopAt != null && ms >= spkStopAt) { spkStopAt = null; $("#player").pause(); }
  const prev = $("#log .row.active");
  if (cur && prev !== cur.el) { if (prev) prev.classList.remove("active"); cur.el.classList.add("active"); if (!$("#player").paused) cur.el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  else if (!cur && prev) prev.classList.remove("active");
};
function seekTo(ms) { const p = $("#player"); if (!p.src) return; spkStopAt = null; p.currentTime = ms / 1000; p.play().catch(() => {}); }
// ffmpeg.wasm 核心(约 32 MB)随页面同源发布,首次用到时才加载,之后走浏览器缓存
let ffmpegP = null;
// 带进度下载(用于 32 MB 的 ffmpeg 核心和 28 MB 的声纹模型);已缓存时很快走完
async function fetchProgress(url, onPct, guess) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()} ${res.status}`);
  const total = Number(res.headers.get("content-length")) || guess, rd = res.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onPct && onPct(Math.min(1, got / total)); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function loadFfmpeg(onPct) {
  return (ffmpegP ||= (async () => {
    const ff = new FFmpeg();
    const wasm = URL.createObjectURL(new Blob([await fetchProgress(new URL(ffmpegWasm, location.href).href, onPct, 32232419)], { type: "application/wasm" }));
    try { await ff.load({ coreURL: new URL(ffmpegCore, location.href).href, wasmURL: wasm }); } finally { URL.revokeObjectURL(wasm); }
    return ff;
  })().catch((e) => { ffmpegP = null; throw e; }));
}
async function extractPcm(blob) {
  fileJob.phase = "loading"; fileJob.loadPct = 0; fileProgress();
  const ff = await loadFfmpeg((p) => { fileJob.loadPct = p; fileProgress(); });
  fileJob.phase = "extract"; fileJob.extractPct = 0; fileProgress();
  const onP = ({ progress }) => { fileJob.extractPct = Math.max(0, Math.min(1, progress || 0)); fileProgress(); };
  ff.on("progress", onP);
  try {
    await ff.createDir("/in").catch(() => {});
    await ff.mount("WORKERFS", { blobs: [{ name: "input", data: blob }] }, "/in");
    const rc = await ff.exec(["-i", "/in/input", "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "/out.pcm"]);
    if (rc !== 0) throw new Error("ffmpeg " + rc);
    const d = await ff.readFile("/out.pcm"); await ff.deleteFile("/out.pcm").catch(() => {});
    return new Int16Array(d.buffer, d.byteOffset, d.byteLength >> 1);
  } finally { ff.off("progress", onP); await ff.unmount("/in").catch(() => {}); }
}
// 按说话人断句时停顿 0.3 秒就断句(快速接话时换人处更容易断开),识别费用不变
function fileConfig() {
  const keep = [cfg.asrModel, cfg.silence]; cfg.asrModel = "gpt-transcribe"; cfg.silence = Math.min(cfg.silence, 300); // 短停顿就断句,便于区分说话人
  const c = sessionConfig(); [cfg.asrModel, cfg.silence] = keep; return c;
}
async function fileStart() {
  const ss = curSess;
  applySettings();
  if (!cfg.hasKey) { openSettings(); $("#apiKey").focus(); return; }
  if (!mediaBlob) { $("#reattach").click(); return; }
  if (ss.done && !$("#go").dataset.armed) { // 重新处理会清空字幕:先确认
    $("#go").dataset.armed = "1"; $("#go").textContent = t("file.redoSure");
    setTimeout(() => { delete $("#go").dataset.armed; setGoFile(); }, 3000); return;
  }
  delete $("#go").dataset.armed;
  if (ss.done) { // 重新处理:清空字幕从头来
    clearTimeout(saveLinesTimer); lines.length = 0; history.length = 0; queue.length = 0; nextId = 0;
    $("#log").replaceChildren(); store.set(linesKey(), null); ss.progress = 0; ss.done = false; ss.count = 0; saveSessions(); setMemo([]);
  }
  fileJob.active = true; fileJob.err = ""; setGoFile(); setStatus("status.processing", "on"); keepAwake();
  try {
    if (!fileJob.pcm) fileJob.pcm = await extractPcm(mediaBlob);
  } catch (e) { fileJob.active = false; fileJob.phase = "error"; fileJob.err = e.message; setGoFile(); fileProgress(); setStatus("status.paused", "err"); return; }
  if (!fileJob.active || curSess !== ss) return;
  fileJob.total = fileJob.pcm.length / 24; ss.file.duration = fileJob.total; saveSessions();
  fileJob.from = fileJob.pos = Math.min(ss.progress || 0, fileJob.total); fileJob.items = {}; fileJob.pending = 0; fileJob.forcedAt = []; fileJob.commitEnd = null; fileJob.lastEnd = fileJob.from; fileJob.speakFrom = null; fileJob.phase = "run";
  fileConnect(ss);
}
function fileConnect(ss) {
  const url = cfg.apiBase.replace(/^http/, "ws") + "/realtime?intent=transcription";
  const ws2 = (fileJob.ws = cfg.useServer ? new WebSocket(url) : new WebSocket(url, ["realtime", "openai-insecure-api-key." + cfg.apiKey]));
  const J = fileJob, off = J.from; // 转写会话里的 audio_*_ms 从本次连接开始送的第一帧算起
  ws2.onopen = () => { ws2.send(JSON.stringify({ type: "session.update", session: fileConfig() })); J.t0 = performance.now(); J.lastEvt = performance.now(); filePump(ws2, ss); };
  ws2.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    J.lastEvt = performance.now();
    if (m.type === "input_audio_buffer.speech_started") { (J.items[m.item_id] ||= {}).s = off + m.audio_start_ms; J.speakFrom = off + m.audio_start_ms; J.pending++; }
    else if (m.type === "input_audio_buffer.speech_stopped") { (J.items[m.item_id] ||= {}).e = off + m.audio_end_ms; J.speakFrom = null; }
    else if (m.type === "input_audio_buffer.committed") {
      // 强制断句的段没有 speech_stopped:结束时间用发 commit 时的位置;紧接着的下一段从这里开始
      const it = (J.items[m.item_id] ||= {});
      if (it.s == null) { it.s = J.commitEnd ?? J.lastEnd; J.pending++; }
      if (it.e == null) it.e = J.forcedAt.shift() ?? J.pos;
      J.commitEnd = it.e;
    }
    else if (m.type === "conversation.item.input_audio_transcription.delta") { $("#partial").textContent = (($("#partial").textContent || "") + (m.delta || "")).slice(-120); }
    else if (m.type === "conversation.item.input_audio_transcription.completed") {
      const it = J.items[m.item_id] || {}; delete J.items[m.item_id]; J.pending = Math.max(0, J.pending - 1);
      const s0 = it.s ?? J.lastEnd, e0 = Math.max(s0 + 300, it.e ?? J.pos);
      J.lastEnd = e0; $("#partial").textContent = "";
      emitTimed((m.transcript || "").trim(), s0, e0);
      if (curSess === ss) { ss.progress = Math.max(ss.progress || 0, e0); saveSessions(); }
    } else if (m.type === "error") {
      const msg = (m.error && (m.error.message || m.error.code)) || "?";
      console.error(m); diag.err++; showLat();
      if (/api key|auth|unauthorized|invalid_api_key/i.test(msg)) { J.err = msg; filePause(true); }
    }
    fileProgress();
  };
  ws2.onclose = () => { if (J.ws === ws2 && J.active && J.phase !== "finish") { J.err = t("status.reconnect"); filePause(true); } };
}
// 按 FILE_SPEED 倍速、每 100 ms 一帧送音频;一句超过「单句最长时长」就强制断句;送完后等最后几段识别和翻译收尾
function filePump(ws2, ss) {
  const J = fileJob, CHUNK_MS = 100, N = 2400;
  const tick = () => {
    if (!J.active || J.ws !== ws2 || ws2.readyState !== 1) return;
    const target = Math.min(J.total, J.from + (performance.now() - J.t0) * FILE_SPEED);
    while (J.pos < target) {
      const i = Math.round(J.pos * 24), chunk = J.pcm.subarray(i, Math.min(i + N, J.pcm.length));
      if (!chunk.length) { J.pos = J.total; break; }
      ws2.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(chunk) }));
      J.pos += CHUNK_MS; addAsrCost(CHUNK_MS / 1000, "gpt-transcribe");
      if (J.speakFrom != null && J.pos - J.speakFrom > cfg.maxTurn * 1000) { ws2.send(JSON.stringify({ type: "input_audio_buffer.commit" })); J.forcedAt.push(J.pos); J.speakFrom = J.pos; }
    }
    if (J.pos >= J.total) {
      if (J.phase === "run") { J.phase = "flush"; if (J.speakFrom != null) { ws2.send(JSON.stringify({ type: "input_audio_buffer.commit" })); J.forcedAt.push(J.pos); } J.flushAt = performance.now(); }
      const quiet = performance.now() - J.lastEvt > 4000;
      if ((J.pending === 0 && quiet || performance.now() - J.flushAt > 60000) && !queue.length && !translating) return fileFinish(ss);
    }
    fileProgress();
    setTimeout(tick, CHUNK_MS);
  };
  tick();
}
function emitTimed(text, s, e) {
  if (!text || !/[^\s。、！？!?,.，「」『』()（）…]/.test(text)) return;
  // 一段里有几句就拆开,时间按字数比例分
  const re = ["ja", "zh"].includes(cfg.tpl.source) ? /[^。！？]+[。！？]+[」』）)]*|[^。！？]+$/g : /[^.!?]+(?:[.!?]+["')\]]*(?=\s|$))|[^.!?]+$/g;
  const parts = (text.match(re) || [text]).map((x) => x.trim()).filter(Boolean);
  const total = parts.reduce((a, x) => a + x.length, 0) || 1; let at = s;
  for (const ptxt of parts) {
    const d = (e - s) * ptxt.length / total;
    if (/[^\s。、！？!?,.，「」『』()（）…]/.test(ptxt)) {
      diag.asr++; const line = addLine(++nextId, ptxt); setLineTime(line, Math.round(at), Math.round(at + d)); queue.push(line);
      const j = lines.findIndex((l) => l !== line && l.ms != null && l.ms > line.ms);
      if (j >= 0) { lines.splice(lines.indexOf(line), 1); lines.splice(j, 0, line); lines[j + 1].el.before(line.el); }
    }
    at += d;
  }
  pumpTranslate(); showLat(); saveLines();
}
function fileFinish(ss) {
  const J = fileJob;
  J.active = false; J.phase = "done"; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  ss.done = true; ss.progress = J.total; saveSessions();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus("status.done", "on"); fileProgress();
  spkAfterFile(ss); // 开着说话人识别:自动识别;之前识别过:先按已有声纹结果标注新字幕,GPT 判定重做
}
function filePause(isErr) {
  const J = fileJob;
  J.active = false; try { J.ws && J.ws.close(); } catch {} J.ws = null;
  J.phase = isErr ? "error" : "paused";
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setGoFile(); setStatus(isErr ? "status.paused" : "status.paused", isErr ? "err" : "warn"); fileProgress();
}
function setGoFile() {
  if (!isFileSess()) return;
  const ss = curSess, g = $("#go");
  if (g.dataset.armed) return;
  g.textContent = t(fileJob.active ? "file.pause" : !mediaBlob ? "file.reattach" : ss.done ? "file.redo" : ss.progress ? "file.resume" : "file.start");
  g.classList.toggle("stop", fileJob.active);
  g.classList.toggle("redo", !fileJob.active && !!ss.done);
}
function fileProgress() {
  if (!isFileSess()) return;
  const ss = curSess, J = fileJob, total = J.total || (ss.file && ss.file.duration) || 0;
  const done = lines.filter((l) => l.done).length, n = lines.length, pos = J.active ? J.pos : ss.progress || 0;
  let pct = total ? pos / total : 0, txt;
  const fill = $("#pfill"); fill.classList.toggle("busy", J.phase === "flush");
  if (J.phase === "loading") { txt = t("file.loading", { pct: Math.round((J.loadPct || 0) * 100) }); pct = J.loadPct || 0; }
  else if (J.phase === "extract") { txt = t("file.extract", { pct: Math.round(J.extractPct * 100) }); pct = J.extractPct; }
  else if (J.phase === "run") { const left = (total - pos) / FILE_SPEED + (n - done) * 400; txt = t("file.run", { pct: Math.round(pct * 100), pos: fmtClock(pos), total: fmtClock(total), speed: FILE_SPEED, eta: fmtClock(left), done, n }); }
  else if (J.phase === "flush") { txt = t("file.flush", { done, n }); pct = 1; }
  else if ((J.phase === "done" || ss.done) && spkRunning() && spkNow.msg) { txt = t("file.spk", { m: spkNow.msg }); pct = spkNow.p == null ? 1 : spkNow.p; fill.classList.toggle("busy", spkNow.p == null); }
  else if (J.phase === "done" || ss.done) { txt = t("file.done", { total: fmtClock(total), n }); pct = 1; }
  else if (J.phase === "error") txt = t("file.err", { m: J.err || "?" });
  else if (!mediaBlob) txt = t("file.missing");
  else if (ss.progress) txt = t("file.paused", { pos: fmtClock(pos), total: fmtClock(total), n });
  else txt = t("file.idle", { total: total ? fmtClock(total) : "—", speed: FILE_SPEED });
  fill.style.width = Math.round(Math.min(1, pct) * 1000) / 10 + "%";
  $("#pinfo").textContent = txt;
  $("#expSrt").hidden = $("#expVtt").hidden = !lines.some((l) => l.ms != null && l.done);
  setGoFile();
}
// 字幕文件:译文在上、原文在下(设置里关掉「显示原文」就只导出译文)
function subtitleFile(kind) {
  const ts = (ms) => { const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s2 = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000); return [h, m, s2].map((v) => String(v).padStart(2, "0")).join(":") + (kind === "srt" ? "," : ".") + String(x).padStart(3, "0"); };
  const withSrc = $("#showSrc").checked;
  const cues = lines.filter((l) => l.ms != null && (l.tgt || l.src)).map((l, i) => `${i + 1}\n${ts(l.ms)} --> ${ts(Math.max(l.endMs, l.ms + 800))}\n${spkPrefix(l)}${l.tgt || l.src}${withSrc && l.tgt && l.src ? "\n" + l.src : ""}\n`);
  return (kind === "vtt" ? "WEBVTT\n\n" : "") + cues.join("\n");
}
$("#expSrt").onclick = () => download(fileName(curSess.name) + ".srt", subtitleFile("srt"), "application/x-subrip");
$("#expVtt").onclick = () => download(fileName(curSess.name) + ".vtt", subtitleFile("vtt"), "text/vtt");


// ---------- 说话人识别(实验功能,全部在本机计算,不调用 API) ----------
// 能量检测在 0.25 秒的停顿处细切 → 每段算 CAM++ 声纹(onnxruntime-web)→ 1.5 秒以上的片段做层次聚类分组 → 每段归到最近的组
// → 每句字幕按重叠时长投票,最多的一组占比达到阈值才标名字。实测(3 人快速接话的电台节目):片段 93%,按句约 75%,约一半的句子有标签
// 声纹存在 IndexedDB「spk:<会话 id>」,改阈值、改名字只重新分组/投票,不用重算
const SPK_COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e64980", "#5c7cfa"];
let spk = null, spkBusy = false, spkStopAt = null, spkModelP = null;
// 一句字幕里声纹占比达到这个比例才算声纹确定(MyGO 实测的最优值),不确定的交给 GPT 判定
const SPK_SHARE = 0.85;
// 分组阈值(余弦距离)、投票时句子两端放宽的秒数、没有重叠片段时找最近片段的最大距离:
// 都按 MyGO #199 官方字幕颜色标注(真实说话人)实测选定,0.5–0.9 的阈值结果几乎一样
const SPK_DIST = 0.5, SPK_PAD = 0.5, SPK_NEAR = 2;
function spkOn() { return sget("spkOn", "0") === "1"; }
function spkPrefix(l) { return l.spk && spkOn() ? l.spk + (CJK.test(l.tgt || l.src || "") ? "：" : ": ") : ""; }
function spkName(c) { return (spk.names[c] || "").trim() || (spk.llm && spk.llm.names[c]) || t("spk.n", { n: c + 1 }); }
function paintSpk(l) {
  const tm = l.el.querySelector(".tm"); if (!tm) return;
  let w = tm.querySelector(".who");
  if (l.spk == null) { if (w) w.remove(); return; }
  if (!w) tm.append(w = el("span", { className: "who" }));
  w.textContent = l.spk || t("spk.unsure"); w.classList.toggle("unsure", !l.spk); w.style.setProperty("--c", l.spk ? SPK_COLORS[(l.spc || 0) % SPK_COLORS.length] : "");
  w.classList.toggle("ai", !!l.spkBy); w.title = l.spkBy ? t("spk.by." + l.spkBy) : "";
}
// onnxruntime-web 的 wasm(14 MB)和声纹模型都随页面同源发布;模型 28 MB,边下边显示进度
function loadSpkModel(onPct) {
  return (spkModelP ||= (async () => {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const buf = await fetchProgress(SPK_MODEL, onPct, 28281138);
    return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  })().catch((e) => { spkModelP = null; throw e; }));
}
async function spkEmbed(model, x) {
  const { data, T } = spkFbank(x);
  const r = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", data, [1, T, 80]) });
  return spkNorm(r[model.outputNames[0]].data);
}
async function spkLoad() {
  if (!curSess) return null;
  if (spk && spk.sid === curSess.id) return spk;
  const sid = curSess.id, rec = await idb.get("spk:" + sid).catch(() => null);
  if (!curSess || curSess.id !== sid) return null;
  spk = rec ? { ...rec, sid } : null;
  if (spk) spkRecluster(false, true);
  return spk;
}
function spkSave() { if (spk) idb.put("spk:" + spk.sid, { segs: spk.segs, emb: spk.emb, n: spk.n, cents: spk.cents, names: spk.names, llm: spk.llm || null }).catch(() => {}); }
async function spkAnalyze() {
  const ss = curSess;
  if (!ss || spkBusy) return;
  if (fileJob.active) return spkMsg(t("spk.busy"));
  if (!mediaBlob) return spkMsg(t("spk.needMedia"));
  spkBusy = true; renderSpk(); spkBar(0);
  try {
    spkMsg(t("spk.loadModel", { pct: 0 }));
    const model = await loadSpkModel((p) => { spkBar(p); spkMsg(t("spk.loadModel", { pct: Math.round(p * 100) })); });
    if (!fileJob.pcm) {
      spkBar(null); spkMsg(t("spk.extract"));
      const keep = fileJob.phase;
      try { fileJob.pcm = await extractPcm(mediaBlob); } finally { fileJob.phase = keep; fileProgress(); }
    }
    if (curSess !== ss) return;
    const pcm = fileJob.pcm, segs = spkSegments(pcm, 24000), n = segs.length, emb = new Float32Array(n * SPK_DIM);
    // 模型在主线程里跑,await 不会真的把控制权还给浏览器:每 40 ms 主动让一次,页面才能响应、进度条才会刷新
    let yieldAt = performance.now();
    for (let i = 0; i < n; i++) {
      if (curSess !== ss) return;
      emb.set(await spkEmbed(model, spkResample(pcm, Math.round(segs[i][0] * 24000), Math.round(segs[i][1] * 24000))), i * SPK_DIM);
      if (performance.now() - yieldAt > 40) { spkBar(i / n); spkMsg(t("spk.embed", { i, n })); await new Promise((r) => setTimeout(r, 0)); yieldAt = performance.now(); }
    }
    const old = spk && spk.sid === ss.id ? spk : null;
    spk = { sid: ss.id, segs: Float32Array.from(segs.flat()), emb, n, cents: old ? old.cents : null, names: old ? old.names : [] };
    spkRecluster(true); spkSave();
  } catch (e) { console.error(e); spkMsg(t("spk.err", { m: e.message || String(e) })); }
  finally { spkBusy = false; spkBar(null); if (curSess === ss) renderSpk(); }
}
// 分组:长片段聚类(最多取最长的 600 段),太小的组(少于 3 段且不到 3%)并进最近的组;组按总时长排序。
// 重新分组后,和旧的组声纹很像的沿用旧名字
function spkRecluster(inherit, keepLlm) {
  const { n, segs, emb } = spk, vec = (i) => emb.subarray(i * SPK_DIM, (i + 1) * SPK_DIM), dur = (i) => segs[2 * i + 1] - segs[2 * i];
  let long = []; for (let i = 0; i < n; i++) if (dur(i) >= 1.5) long.push(i);
  if (long.length > 600) long = long.sort((a, b) => dur(b) - dur(a)).slice(0, 600);
  if (long.length < 2) for (let i = 0; i < n; i++) if (!long.includes(i)) long.push(i);
  const lab = spkCluster(long.map(vec), SPK_DIST), groups = new Map();
  long.forEach((i, k) => { const g = groups.get(lab[k]) || []; g.push(i); groups.set(lab[k], g); });
  let keep = [...groups.values()].filter((g) => g.length >= Math.max(3, 0.03 * long.length));
  if (!keep.length) keep = [[...groups.values()].sort((a, b) => b.length - a.length)[0]];
  const mean = (idx) => { const m = new Float32Array(SPK_DIM); for (const i of idx) { const v = vec(i); for (let d = 0; d < SPK_DIM; d++) m[d] += v[d]; } return spkNorm(m); };
  let cents = keep.map(mean);
  const assign = () => { spk.lab = new Int16Array(n); spk.sim = new Float32Array(n); for (let i = 0; i < n; i++) { let b = 0, bs = -2; const v = vec(i); cents.forEach((c, k) => { const s2 = spkDot(v, c); if (s2 > bs) { bs = s2; b = k; } }); spk.lab[i] = b; spk.sim[i] = bs; } };
  assign();
  const tot = cents.map((_, k) => { let s2 = 0; for (let i = 0; i < n; i++) if (spk.lab[i] === k) s2 += dur(i); return s2; });
  const order = cents.map((_, k) => k).sort((a, b) => tot[b] - tot[a]);
  cents = order.map((k) => cents[k]); assign();
  // 前后文平滑:短片段结合前后片段一起定组(MyGO 三集实测按时长准确率 +0~2 个百分点)
  { const K = cents.length, sims = new Float32Array(n * K);
    for (let i = 0; i < n; i++) { const v = vec(i); cents.forEach((c, k) => { sims[i * K + k] = spkDot(v, c); }); }
    spk.lab = spkSmooth(segs, sims, K); for (let i = 0; i < n; i++) spk.sim[i] = sims[i * K + spk.lab[i]]; }
  const oldC = spk.cents ? Array.from({ length: spk.cents.length / SPK_DIM }, (_, k) => spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) : [], oldN = spk.names || [];
  if (inherit !== false) { // 新旧两组互为最像、且余弦 ≥ 0.8 才沿用名字,避免名字沿着相近的组一路传下去
    const best = (v, arr) => { let b = -1, bs = 0.8; arr.forEach((o, k) => { const s2 = spkDot(v, o); if (s2 >= bs) { bs = s2; b = k; } }); return b; };
    spk.names = cents.map((c, k) => { const o = best(c, oldC); return o >= 0 && best(oldC[o], cents) === k ? oldN[o] || "" : ""; });
  }
  const same = spk.cents && spk.cents.length === cents.length * SPK_DIM && cents.every((c, k) => spkDot(c, spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)) > 0.999);
  if (!keepLlm && !same) spk.llm = null; // 分组变了,之前的 LLM 判定对不上组号,作废
  spk.cents = new Float32Array(cents.length * SPK_DIM); cents.forEach((c, k) => spk.cents.set(c, k * SPK_DIM));
  spk.groups = cents.map((_, k) => {
    let d = 0, cnt = 0, best = -1, bs = -2;
    for (let i = 0; i < n; i++) if (spk.lab[i] === k) { d += dur(i); cnt++; if (dur(i) >= 1.5 && spk.sim[i] > bs) { bs = spk.sim[i]; best = i; } }
    if (best < 0) for (let i = 0; i < n; i++) if (spk.lab[i] === k && (best < 0 || dur(i) > dur(best))) best = i;
    return { dur: d, n: cnt, sample: best };
  });
  spkVote();
}
// 每句字幕:和它重叠的片段按时长投票(1.5 秒以下的片段权重减半),同名的组合并计票;
// 按组的候选分布记在 l.spkV(给 LLM 判定用)。有 LLM 判定且开着时:声纹不确定的句子用 LLM 的结论;
// 声纹确定的句子只在 LLM 有明确证据(自我介绍、被点名后回答)时改判
function spkVote() {
  if (!spk) return;
  const share = SPK_SHARE, { n, segs } = spk, color = {};
  spk.groups.forEach((_, k) => { const nm = spkName(k); if (!(nm in color)) color[nm] = k; });
  const llm = spk.llm ? new Map(spk.llm.lines.map(([id, who, basis]) => [id, { who, basis }])) : null;
  const llmName = (who) => (/^G\d+$/.test(who) ? spkName(Number(who.slice(1)) - 1) : who);
  let tagged = 0, timed = 0;
  for (const l of lines) {
    if (l.ms == null) continue;
    timed++;
    const s = l.ms / 1000 - SPK_PAD, e = l.endMs / 1000 + SPK_PAD, vote = {}, gv = {}; let sum = 0;
    for (let i = 0; i < n; i++) {
      const ov = Math.min(e, segs[2 * i + 1]) - Math.max(s, segs[2 * i]);
      if (ov <= 0) continue;
      const w = ov * (segs[2 * i + 1] - segs[2 * i] >= 1.5 ? 1 : 0.5), nm = spkName(spk.lab[i]);
      vote[nm] = (vote[nm] || 0) + w; gv[spk.lab[i]] = (gv[spk.lab[i]] || 0) + w; sum += w;
    }
    l.spkV = Object.entries(gv).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, w]) => [Number(k), w / sum]); delete l.spkNear;
    // 句子的时间戳有时偏短、落在两段声音之间:取前后 SPK_NEAR 秒内最近的片段作参考,但不算声纹确定,交给 GPT 判断
    if (!sum) { let bi = -1, bg = Infinity; for (let i = 0; i < n; i++) { const g = Math.max(segs[2 * i] - e, s - segs[2 * i + 1]); if (g < bg) { bg = g; bi = i; } } if (bi >= 0 && bg <= SPK_NEAR) { l.spkV = [[spk.lab[bi], 1]]; l.spkNear = Math.max(0, bg); } }
    const top = Object.entries(vote).sort((a, b) => b[1] - a[1])[0], sure = top && top[1] / sum >= share - 1e-9;
    delete l.spkBy;
    if (!top) delete l.spk; else if (sure) l.spk = top[0]; else l.spk = "";
    const j = llm && llm.get(l.id);
    if (j && j.who) {
      const nm = llmName(j.who);
      const unnamed = sure && /^G\d+$/.test(j.who) === false && spk.groups.some((_, k) => spkName(k) === l.spk && spkName(k) === t("spk.n", { n: k + 1 }));
      if (nm !== l.spk && (!sure || unnamed || j.basis === "self_intro" || j.basis === "addressed")) { l.spk = nm; l.spkBy = j.basis; }
    }
    if (l.spk) { if (!(l.spk in color)) color[l.spk] = Object.keys(color).length; l.spc = color[l.spk]; tagged++; } else delete l.spc;
    paintSpk(l);
  }
  spk.tagged = tagged; spk.timed = timed;
  saveLines();
}
// 模板声纹库:{ 名字: { v: base64(192 维 float32), d: 累计秒数 } }。确认过组名后存进模板,之后同一模板的文件自动对照
const f32b64 = (v) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(v).buffer)));
const b64f32 = (s) => new Float32Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);
function spkGroupVecs() { return spk.groups.map((_, k) => spk.cents.subarray(k * SPK_DIM, (k + 1) * SPK_DIM)); } // 各组质心
function spkSaveVoices() {
  const tp = getTemplate(cfg.tpl.id); if (!tp || !spk) return;
  const lib = { ...(tp.voices || {}) }, acc = {}, G = spkGroupVecs();
  for (let k = 0; k < spk.groups.length; k++) {
    const nm = spkName(k); if (nm === t("spk.n", { n: k + 1 })) continue; // 没认出名字的组不存
    const a = (acc[nm] ||= { v: new Float32Array(SPK_DIM), d: 0 }), d = spk.groups[k].dur;
    for (let i = 0; i < SPK_DIM; i++) a.v[i] += G[k][i] * d; a.d += d;
  }
  for (const [nm, a] of Object.entries(acc)) { // 和库里同名的按时长加权合并
    const old = lib[nm];
    if (old) { const ov = b64f32(old.v); for (let i = 0; i < SPK_DIM; i++) a.v[i] += ov[i] * old.d; a.d += old.d; }
    lib[nm] = { v: f32b64(spkNorm(a.v)), d: Math.round(a.d) };
  }
  putTemplate({ ...tp, voices: lib }); renderSpk(); spkMsg(t("spk.saved", { names: Object.keys(acc).join("、") || "—" }));
}
// 对照规则(MyGO 四集跨集实测):余弦 ≥ 0.88、比第二像的高 0.05 以上、且互为最像 —— 不同人的误认全部排除;
// 同一声优的「本人声线」和「角色声线」可能互相匹配,所以只作为提示交给 GPT,由它按本集是角色回还是本人回定名字
const SPK_LIB_MIN = 0.88, SPK_LIB_MARGIN = 0.05;
function spkLibMatch() {
  const lib = Object.entries((cfg.tpl && cfg.tpl.voices) || {}).map(([name, x]) => ({ name, v: b64f32(x.v) }));
  if (!spk || !lib.length) return [];
  const G = spkGroupVecs();
  return G.map((c, k) => {
    const sc = lib.map((x) => spkDot(c, x.v)).map((s2, i) => [s2, i]).sort((a, b) => b[0] - a[0]);
    const [s1, i1] = sc[0], s2 = sc[1] ? sc[1][0] : -1;
    const mutual = G.every((h, j) => j === k || spkDot(h, lib[i1].v) < s1);
    return s1 >= SPK_LIB_MIN && s1 - s2 >= SPK_LIB_MARGIN && mutual ? { name: lib[i1].name, sim: s1 } : null;
  });
}
// LLM 判定:声纹候选 + 字幕文本 + 模板(背景、说话人线索、出演者)→ 每组的名字、每句的说话人
let spkJudging = false;
async function spkJudge() {
  const ss = curSess;
  if (!spk || spkJudging || !ss) return;
  applySettings();
  if (!cfg.hasKey) return spkMsg(t("spk.needKey"));
  spkJudging = true; renderSpk(); spkBar(null);
  const t0 = Date.now(), tick = () => spkMsg(t("spk.judging", { s: Math.round((Date.now() - t0) / 1000), n: lines.length })), timer = setInterval(tick, 1000); tick();
  try {
    const g = cfg.glossary, tl = lines.filter((l) => l.ms != null && (l.src || l.raw));
    const jl = tl.map((l) => ({ id: l.id, s: l.ms / 1000, e: l.endMs / 1000, text: l.src || l.raw, voice: l.spkV || [], near: l.spkNear }));
    const r = await judgeSpeakers({
      lines: jl,
      groups: (() => { const lm = spkLibMatch(); return spk.groups.map((gr, k) => ({ k, name: (spk.names[k] || "").trim(), dur: gr.dur, lib: lm[k] || undefined })); })(),
      description: cfg.tpl.description || "", spkNotes: cfg.tpl.spkNotes || "", people: g.people,
      share: SPK_SHARE,
    }, async (system, user, schema) => {
      const res = await fetch(cfg.apiBase + "/chat/completions", { method: "POST", headers: apiHeaders(), body: JSON.stringify({
        model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "speakers", strict: true, schema } } }) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json(); addMtCost(cfg.ctModel, data.usage);
      return JSON.parse(data.choices[0].message.content);
    });
    if (curSess !== ss) return;
    const names = reconcileGroupNames(jl, r, SPK_SHARE, spk.groups.length); // 组名和逐句判定对齐,重名且没句子支持的清空
    spk.llm = { names, lines: [...r.lines].map(([id, v]) => [id, v.who, v.basis]), at: Date.now() };
    spkVote(); spkSave();
  } catch (e) { console.error(e); clearInterval(timer); spkJudging = false; spkMsg(t("spk.err", { m: e.message || String(e) })); renderSpk(false); return; }
  finally { spkJudging = false; clearInterval(timer); spkBar(null); }
  if (curSess === ss) renderSpk();
}
// 开着说话人识别时自动跑完两步:本机声纹分析(没做过才做)→ GPT 判定(没判过或已作废才判)
let spkAutoP = null;
function spkAuto(ss = curSess) {
  if (!ss || ss !== curSess || !spkOn() || !isFileSess() || fileJob.active || !ss.done || spkAutoP) return spkAutoP;
  return (spkAutoP = (async () => {
    try {
      await spkLoad();
      if (!spk) { if (!mediaBlob) return spkMsg(t("spk.needMedia")); await spkAnalyze(); }
      if (spk && curSess === ss && !spk.llm) await spkJudge();
    } finally { spkAutoP = null; if (curSess === ss) { if (!$("#spkPanel").hidden) renderSpk(); fileProgress(); } }
  })());
}
async function spkAfterFile(ss) {
  if (curSess !== ss) return;
  if (await spkLoad()) { spk.llm = null; spkVote(); spkSave(); } // 字幕重新生成了,旧的 GPT 判定对不上
  spkAuto(ss);
}
// 面板里的进度同步到主进度条(spkNow 记下当前这一步)
const spkNow = { msg: "", p: null };
function spkRunning() { return spkBusy || spkJudging || !!spkAutoP; }
function spkMsg(m) { $("#spkMsg").textContent = m; spkNow.msg = m; fileProgress(); }
function spkBar(p) { $("#spkBar").hidden = p == null; if (p != null) $("#spkBar i").style.width = Math.round(p * 1000) / 10 + "%"; spkNow.p = p; fileProgress(); }
function spkPanel(on) { $("#spkPanel").hidden = !on; document.body.classList.toggle("spkopen", on); }
function renderSpk(msg = true) {
  const on = spkOn(), busy = spkBusy || spkJudging || !!spkAutoP;
  $("#spkIntro").textContent = t(on ? "spk.introOn" : "spk.introOff");
  $("#spkRun").textContent = t(!on ? "spk.enable" : spk ? "spk.rerun" : "spk.start"); $("#spkRun").disabled = busy || (on && !(curSess && curSess.done));
  const list = $("#spkList"); list.replaceChildren(); $("#spkVoices").hidden = true;
  if (!on) { if (!busy) spkMsg(""); return; }
  if (!spk) { if (!busy) spkMsg(t(!(curSess && curSess.done) ? "spk.wait" : mediaBlob ? "spk.none" : "spk.needMedia")); return; }
  if (!busy && msg) spkMsg(t("spk.done", { k: spk.groups.length, a: spk.tagged, b: spk.timed }) + (spk.llm ? " " + t("spk.judged", { n: lines.filter((l) => l.spkBy).length }) : ""));
  const libM = spkLibMatch(), libN = Object.keys((cfg.tpl && cfg.tpl.voices) || {});
  $("#spkVoices").hidden = false; $("#spkSaveVoices").disabled = busy || !spk.groups.some((_, k) => spkName(k) !== t("spk.n", { n: k + 1 }));
  $("#spkLib").textContent = libN.length ? t("spk.lib", { names: libN.join("、") }) : t("spk.libNone"); $("#spkClearVoices").hidden = !libN.length;
  spk.groups.forEach((g, k) => {
    const ai = spk.llm && spk.llm.names[k], lm = libM[k];
    const inp = el("input", { type: "text", value: spk.names[k] || "", placeholder: ai ? ai + " · AI" : t("spk.n", { n: k + 1 }) });
    inp.onchange = () => { spk.names[k] = inp.value.trim(); spkVote(); spkSave(); renderSpk(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    const play = el("button", { className: "btn i-play", textContent: t("spk.play"), onclick: () => { const i = g.sample; if (i < 0) return; seekTo(spk.segs[2 * i] * 1000); spkStopAt = spk.segs[2 * i + 1] * 1000 + 200; } });
    list.append(el("div", { className: "spkItem" }, el("i", { className: "dot", style: "--c:" + SPK_COLORS[k % SPK_COLORS.length] }), inp, el("span", { className: "meta", textContent: t("spk.meta", { dur: fmtClock(g.dur * 1000), n: g.n }) + (lm ? " · " + t("spk.libMatch", { name: lm.name }) : "") }), play));
  });
}
$("#spkOpen").onclick = async () => { spkPanel(true); renderSpk(); await spkLoad(); renderSpk(); };
$("#spkClose").onclick = () => spkPanel(false);
$("#spkRun").onclick = () => {
  if (!spkOn()) return spkAskEnable();
  if (spk) { spk.llm = null; spkVote(); spkSave(); } // 重新识别:保留声纹分组和你起的名字,GPT 重新判定
  spkAuto(); renderSpk();
};
$("#spkSaveVoices").onclick = spkSaveVoices;
$("#spkClearVoices").onclick = () => {
  const b = $("#spkClearVoices");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = t("spk.clearVoicesSure"); setTimeout(() => { delete b.dataset.armed; b.textContent = t("spk.clearVoices"); }, 3000); return; }
  delete b.dataset.armed; b.textContent = t("spk.clearVoices");
  const tp = getTemplate(cfg.tpl.id); if (tp) { putTemplate({ ...tp, voices: {} }); renderSpk(); }
};
$("#spkSettings").onclick = () => { openSettings(); $("#secSpk").scrollIntoView({ block: "start" }); };
// 第一次开启先确认(要下载约 40 MB 组件、GPT 判定消耗 API),确认过一次就不再问
function spkAskEnable() {
  if (store.get("spkConsent", "") === "1") return spkSetOn(true);
  $("#spkOn").checked = false; $("#spkConfirm").hidden = false;
  if ($("#settings").hidden) openSettings();
  $("#secSpk").scrollIntoView({ block: "start" });
}
$("#spkConfirmOk").onclick = () => { store.set("spkConsent", "1"); $("#spkConfirm").hidden = true; spkSetOn(true); };
$("#spkConfirmNo").onclick = () => { $("#spkConfirm").hidden = true; };
$("#spkOn").onchange = () => { if ($("#spkOn").checked) spkAskEnable(); else { $("#spkConfirm").hidden = true; spkSetOn(false); } };
function spkSetOn(on) {
  $("#spkOn").checked = on;
  sset("spkOn", on ? "1" : null); document.body.classList.toggle("nospk", !spkOn());
  for (const l of lines) paintSpk(l);
  if (!$("#spkPanel").hidden) renderSpk();
  spkAuto();
};

// ---------- 会话列表 ----------
function sessTranscript(arr) { return arr.filter((l) => l.src || l.tgt).map((l) => `[${new Date(l.t).toTimeString().slice(0, 8)}] ${l.tgt}\n           ${l.src}`).join("\n"); }
function fileName(name) { return (name || "subs").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60); }
function renderSessions() {
  $("#noKey").hidden = cfg.hasKey;
  const list = $("#sessList");
  list.replaceChildren();
  if (!sessions.length) { list.append(el("div", { className: "emptyList", textContent: t("home.noSessions") })); return; }
  for (const ss of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const tp = sessTemplate(ss), cur = curSess && curSess.id === ss.id;
    const h = el("h3", { textContent: ss.name });
    h.append(el("span", { className: "tag", textContent: t(ss.kind === "file" ? "sess.file" : "sess.live") }));
    if (cur) h.append(el("span", { className: "tag", textContent: t("card.current") }));
    const btn = (key, fn, primary, icon) => el("button", { className: "btn" + (primary ? " primary" : "") + " i-" + icon, textContent: t(key), onclick: fn });
    const rename = () => {
      const inp = el("input", { type: "text", value: ss.name });
      const done = () => { const v = inp.value.trim(); if (v && v !== ss.name) { ss.name = v; saveSessions(); if (cur) refreshTemplate(); } renderSessions(); };
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = ss.name; inp.blur(); } };
      inp.onblur = done; h.replaceChildren(inp); inp.focus(); inp.select();
    };
    const del = btn("sess.del", () => {
      if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = t("sess.delSure"); setTimeout(() => { delete del.dataset.armed; del.textContent = t("sess.del"); }, 3000); return; }
      deleteSession(ss.id); renderSessions();
    }, false, "trash");
    list.append(el("div", { className: "card" + (cur ? " current" : "") }, h,
      el("div", { className: "meta", textContent: t("sess.meta", { tpl: tp ? tp.name : t("sess.tplMissing"), src: srcName(ss.source), tgt: tgtName(ss.target) }) }),
      el("div", { className: "when", textContent: t("sess.when", { time: fmtWhen(ss.updatedAt), n: ss.count || 0 }) + (ss.kind === "file" && ss.file && ss.file.duration ? " · " + fmtClock(ss.file.duration) : "") }),
      el("div", { className: "btns" },
        btn("sess.continue", () => { useSession(ss.id); show("live"); }, true, "play"),
        btn("sess.rename", rename, false, "edit"),
        btn("sess.export", () => download(fileName(ss.name) + ".txt", sessTranscript(store.json("slines." + ss.id, []))), false, "download"),
        del)));
  }
}

// ---------- 模板列表 ----------
function renderHome() {
  $("#noKey").hidden = cfg.hasKey;
  const list = $("#tplList");
  list.replaceChildren();
  for (const tp of allTemplates()) {
    const g = parseGlossary(tp.glossary);
    const h = el("h3", { textContent: tp.name });
    if (tp.builtin) h.append(el("span", { className: "tag", textContent: t(tp.modified ? "card.modified" : "card.builtin") }));
    if (curSess && curSess.tplId === tp.id) h.append(el("span", { className: "tag", textContent: t("card.current") }));
    const btn = (key, fn, primary, icon) => el("button", { className: "btn" + (primary ? " primary" : "") + " i-" + icon, textContent: t(key), onclick: fn });
    const btns = el("div", { className: "btns" },
      btn("card.open", () => { newSession(tp.id); show("live"); }, true, "play"),
      btn("card.file", () => pickMedia(tp.id), false, "film"),
      btn("card.edit", () => openCreator(tp), false, "edit"),
      btn("card.dup", () => { putTemplate({ ...tp, id: newId(), name: tp.name + t("card.copy") }); renderHome(); }, false, "copy"),
      btn("card.export", () => exportTemplate(tp), false, "download"));
    if (!tp.builtin || tp.modified) {
      const del = btn(tp.builtin ? "card.reset" : "card.del", (e) => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = t("card.delSure"); setTimeout(() => { delete del.dataset.armed; del.textContent = t(tp.builtin ? "card.reset" : "card.del"); }, 3000); return; }
        removeTemplate(tp.id); renderHome();
      }, false, tp.builtin ? "restore" : "trash");
      btns.append(del);
    }
    list.append(el("div", { className: "card" + (curSess && curSess.tplId === tp.id ? " current" : "") },
      h, el("div", { className: "meta", textContent: t("card.meta", { src: srcName(tp.source), tgt: tgtName(tp.target), p: g.people.length, n: g.terms.length }) }),
      tp.description ? el("div", { className: "meta desc", textContent: tp.description.slice(0, 120) + (tp.description.length > 120 ? "…" : "") }) : null, btns));
  }
}
function download(name, text, type = "text/plain") {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function exportTemplate(tp) {
  const { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, voices } = tp;
  download((name || "template").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) + ".json",
    JSON.stringify({ format: "tsuji-template", version: 1, template: { id, name, source, target, description, style, asrPrompt, spkNotes, glossary, ...(voices ? { voices } : {}) } }, null, 2), "application/json");
}
$("#importTpl").onclick = () => $("#importFile").click();
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text()), tp = d.template || d;
    if (!tp.name || typeof tp.glossary !== "string") throw new Error();
    putTemplate({ ...tp, id: getTemplate(tp.id) ? newId() : tp.id || newId(), source: LANGS[tp.source] ? tp.source : "auto", target: TARGETS[tp.target] ? tp.target : "zh-Hans" });
    renderHome();
  } catch { alert(t("home.importFail")); }
};
$("#newTpl").onclick = () => openCreator(null);

// ---------- 创建 / 编辑模板(和 GPT 对话) ----------
// creator = { editId, draft: 模板字段, msgs: [{role, text}], prevId: 上一轮 Responses id };存本地,刷新不丢
let creator = store.json("creator", null) || { editId: null, draft: null, msgs: [], prevId: null };
let creatorBusy = false, glossTextMode = false;
function saveCreator() { store.set("creator", JSON.stringify(creator)); }
function blankDraft() { return { name: "", source: "ja", target: uiLang === "zh" ? "zh-Hans" : "en", description: "", style: "", asrPrompt: "", spkNotes: "", glossary: "" }; }
function openCreator(tp) {
  const d = tp ? { name: tp.name, source: tp.source, target: tp.target, description: tp.description || "", style: tp.style || "", asrPrompt: tp.asrPrompt || "", spkNotes: tp.spkNotes || "", glossary: tp.glossary || "" } : blankDraft();
  creator = { editId: tp ? tp.id : null, draft: d, msgs: [{ role: "note", text: tp ? t("create.welcomeEdit", { name: tp.name }) : t("create.welcome") }], prevId: null };
  attachments = []; renderAttachments();
  saveCreator(); glossTextMode = false; setTab("chat"); show("create");
}
function setTab(tab) { $("#panes").dataset.tab = tab; $("#tabChat").classList.toggle("on", tab === "chat"); $("#tabDraft").classList.toggle("on", tab === "draft"); }
$("#tabChat").onclick = () => setTab("chat");
$("#tabDraft").onclick = () => setTab("draft");
function linkify(text) {
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
  const d = creator.draft;
  $("#dName").value = d.name; $("#dSource").value = d.source; $("#dTarget").value = d.target;
  $("#dDesc").value = d.description; $("#dStyle").value = d.style; $("#dAsr").value = d.asrPrompt; $("#dSpkNotes").value = d.spkNotes || ""; $("#dGlossText").value = d.glossary;
  renderGlossTable();
}
function renderGlossTable() {
  const g = parseGlossary(creator.draft.glossary);
  $("#gTitle").textContent = t("draft.gloss", { p: g.people.length, n: g.terms.length });
  $("#tabDraft").textContent = t("create.tabDraft", { n: g.people.length + g.terms.length });
  const tr = (e, sp) => el("tr", {}, el("td", {}, e.src, sp ? el("span", { className: "tag", textContent: t("draft.speaker") }) : null), el("td", { textContent: e.reading }), el("td", { textContent: e.tgt }), el("td", { textContent: e.notes }));
  $("#gBody").replaceChildren(...g.people.map((e) => tr(e, true)), ...g.terms.map((e) => tr(e, false)));
  $("#gTableBox").hidden = glossTextMode; $("#dGlossText").hidden = !glossTextMode;
  $("#gToggle").textContent = t(glossTextMode ? "draft.viewTable" : "draft.editText");
}
function renderCreator() { if (!creator.draft) creator.draft = blankDraft(); renderChat(); renderDraft(); }
$("#gToggle").onclick = () => { glossTextMode = !glossTextMode; renderGlossTable(); };
// 草稿手动修改随时存;下一轮对话会把当前草稿一起发给 GPT
for (const [sel, key] of [["#dName", "name"], ["#dSource", "source"], ["#dTarget", "target"], ["#dDesc", "description"], ["#dStyle", "style"], ["#dAsr", "asrPrompt"], ["#dSpkNotes", "spkNotes"], ["#dGlossText", "glossary"]]) {
  $(sel).addEventListener("input", () => { creator.draft[key] = $(sel).value; saveCreator(); if (key === "glossary") renderGlossTable(); });
  $(sel).addEventListener("change", () => { creator.draft[key] = $(sel).value; saveCreator(); });
}
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
- reply: a short message to the user written in ${uiLang === "zh" ? "Simplified Chinese" : "English"}: what you found or changed, key sources as plain URLs, and at most two questions. Plain text only, no Markdown. Do not repeat the whole glossary in reply.`;
function draftForGPT() {
  const d = creator.draft, g = parseGlossary(d.glossary);
  const ent = (e) => ({ text: e.src, reading: e.reading, translation: e.tgt, notes: e.notes });
  return { name: d.name, source: d.source, target: d.target, description: d.description, style: d.style, asrPrompt: d.asrPrompt, spkNotes: d.spkNotes || "", speakers: g.people.map(ent), terms: g.terms.map(ent) };
}
// 附件:课件、论文等随本轮消息发给 Responses API(PDF/Office 用 input_file,图片用 input_image,纯文本直接读出)
const ATTACH_MAX_MB = 40;
let attachments = []; // {name, size, part}
const TEXT_EXT = /\.(txt|md|csv|srt|vtt|tex|html|json)$/i;
function readFile(f, asText) {
  return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => bad(r.error); asText ? r.readAsText(f) : r.readAsDataURL(f); });
}
async function addAttachments(files) {
  for (const f of files) {
    const total = attachments.reduce((a, x) => a + x.size, 0) + f.size;
    if (total > ATTACH_MAX_MB * 1048576) { creator.msgs.push({ role: "note", text: t("create.attachTooBig", { m: ATTACH_MAX_MB }) }); renderChat(); break; }
    try {
      let part;
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
$("#chatAttach").onclick = () => $("#attachFile").click();
$("#attachFile").onchange = async (e) => { await addAttachments([...e.target.files]); e.target.value = ""; };
// 读 Responses API 的 SSE 流,返回最终的 response 对象(和非流式时 res.json() 一样)
async function readResponseStream(res, onEvent) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let pending = "", text = "", final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += dec.decode(value, { stream: true });
    let i;
    while ((i = pending.indexOf("\n\n")) >= 0) {
      const chunk = pending.slice(0, i); pending = pending.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "response.output_text.delta") text += ev.delta || "";
      if (ev.type === "response.completed") final = ev.response;
      if (ev.type === "response.failed" || ev.type === "response.incomplete") throw new Error((ev.response && ev.response.error && ev.response.error.message) || ev.type);
      if (ev.type === "error") throw new Error(ev.message || (ev.error && ev.error.message) || "stream error");
      try { onEvent(ev, text); } catch (e) { console.error(e); }
    }
  }
  if (!final) throw new Error("stream ended early");
  return final;
}
// 从还没收完的 JSON 里取出某个字符串字段已到达的部分
function partialJsonString(buf, key) {
  const m = buf.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (!m) return "";
  let raw = m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  try { return JSON.parse('"' + raw + '"'); } catch { return ""; }
}
async function creatorSend() {
  const typed = $("#chatInput").value.trim();
  if ((!typed && !attachments.length) || creatorBusy) return;
  const text = typed || t("create.attachOnly");
  const files = attachments; 
  applySettings();
  if (!cfg.hasKey) { creator.msgs.push({ role: "note", text: t("create.noKey") }); renderChat(); return; }
  creator.msgs.push({ role: "user", text, files: files.map((a) => a.name) }); $("#chatInput").value = ""; saveCreator();
  attachments = []; renderAttachments();
  creatorBusy = true; renderChat();
  const t0 = performance.now();
  let status = t("create.stStart");
  const showStatus = () => { const n = $("#thinking"); if (n) n.textContent = t("create.thinking", { st: status, s: Math.round((performance.now() - t0) / 1000) }); };
  const tick = setInterval(showStatus, 1000);
  // 流式:边收边显示检索进度、回复正文和已整理的条目数
  const onStream = (ev, buf) => {
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
  const call = async (prevId) => {
    const body = {
      model, reasoning: { effort: "medium" }, instructions: CREATOR_SYSTEM(), tools: [{ type: "web_search" }],
      input: [{ role: "user", content: [
        { type: "input_text", text: `${text}${files.length ? `\n\n(Attached: ${files.map((a) => a.name).join(", ")})` : ""}\n\n---\nCurrent draft (JSON; may include the user's manual edits):\n${JSON.stringify(draftForGPT())}` },
        ...files.map((a) => a.part),
      ] }],
      text: { format: { type: "json_schema", name: "template_turn", strict: true, schema: CREATOR_SCHEMA } },
    };
    if (prevId) body.previous_response_id = prevId;
    body.stream = true;
    const res = await fetch(cfg.apiBase + "/responses", { method: "POST", headers: apiHeaders(), body: JSON.stringify(body) });
    if (!res.ok) { const err = new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`); err.status = res.status; throw err; }
    return readResponseStream(res, onStream);
  };
  try {
    let d;
    try { d = await call(creator.prevId); }
    catch (e) { if (creator.prevId && e.status === 400) d = await call(null); else throw e; } // 上一轮记录过期就不带历史重来(草稿本身已经带上了)
    const searches = (d.output || []).filter((o) => o.type === "web_search_call").length;
    addMtCost(model, d.usage, searches * WEB_SEARCH_PER_CALL);
    const msg = (d.output || []).find((o) => o.type === "message");
    const out = JSON.parse(((msg && msg.content) || []).map((c) => c.text || "").join(""));
    const tp = out.template;
    creator.prevId = d.id;
    creator.draft = { name: tp.name, source: tp.source, target: tp.target, description: tp.description, style: tp.style, asrPrompt: tp.asrPrompt, spkNotes: tp.spkNotes, glossary: glossaryText(tp.speakers, tp.terms) };
    creator.msgs.push({ role: "ai", text: out.reply });
    creator.msgs.push({ role: "note", text: t("create.updated", { p: tp.speakers.length, n: tp.terms.length }) });
  } catch (e) {
    console.error(e);
    creator.msgs.push({ role: "note", text: t("create.err", { m: e.message }) });
    if (files.length && !attachments.length) { attachments = files; renderAttachments(); } // 失败时把附件放回去,方便重发
  } finally {
    clearInterval(tick);
    creatorBusy = false; saveCreator();
    if (view === "create") { renderChat(); renderDraft(); }
  }
}
$("#chatSend").onclick = creatorSend;
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) creatorSend(); });
function saveDraft() {
  const d = creator.draft;
  if (!d.name.trim()) { setTab("draft"); $("#dName").focus(); flashBtn($("#dSave"), t("draft.needName")); return null; }
  const id = creator.editId || newId();
  putTemplate({ ...d, name: d.name.trim(), id });
  creator.editId = id; saveCreator();
  return id;
}
function flashBtn(b, text) { const old = b.textContent; b.textContent = text; setTimeout(() => (b.textContent = old), 2000); }
$("#dSave").onclick = () => { if (saveDraft()) show("tpl"); };
$("#dSaveStart").onclick = () => { const id = saveDraft(); if (id) { newSession(id); show("live"); } };
$("#dDiscard").onclick = (e) => {
  const b = e.target;
  if (!b.dataset.armed) { b.dataset.armed = "1"; flashBtn(b, t("draft.discardSure")); setTimeout(() => delete b.dataset.armed, 2000); return; }
  attachments = []; renderAttachments();
  creator = { editId: null, draft: null, msgs: [], prevId: null }; store.set("creator", null); show("tpl");
};

// ---------- 设置面板 ----------
function openSettings() { showCost(); listMics(); $("#settings").hidden = false; }
// 麦克风列表:授权前浏览器不给设备名,只能显示「麦克风 1/2…」
async function listMics() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && !["default", "communications"].includes(d.deviceId)); } catch {}
  const sel = $("#micDev"), cur = store.get("micId", "");
  sel.replaceChildren(el("option", { value: "", textContent: t("opt.micDefault") }), ...devs.map((d, i) => el("option", { value: d.deviceId, textContent: d.label || t("opt.micN", { n: i + 1 }) })));
  if (cur && !devs.some((d) => d.deviceId === cur)) sel.append(el("option", { value: cur, textContent: t("opt.micMissing") }));
  sel.value = cur;
  $("#micDevHint").textContent = t(devs.length && devs.every((d) => d.label) ? "set.micDevHint" : "set.micDevNoLabel");
}
$("#micDev").onchange = () => { store.set("micId", $("#micDev").value || null); cfg.micId = $("#micDev").value; if (running) restartMic(); };
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listMics);
$("#openSettings").onclick = openSettings;
$("#closeSettings").onclick = () => {
  applySettings();
  // 语言只改当前会话,不动模板
  if (curSess && ($("#srcLang").value !== curSess.source || $("#tgtLang").value !== curSess.target)) { curSess.source = $("#srcLang").value; curSess.target = $("#tgtLang").value; saveSessions(); refreshTemplate(); }
  $("#settings").hidden = true;
  if (running && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "session.update", session: sessionConfig() }));
  if (view === "home") renderSessions();
  if (view === "tpl") renderHome();
  if (view === "live") showEmptyHint();
};
$("#uiLang").onchange = () => {
  uiLang = $("#uiLang").value; store.set("uiLang", uiLang);
  applyI18n(); applySettings(); listMics(); setStatus(statusKey, statusKind, statusExtra); setFollow(follow); showLat();
  $("#go").textContent = t(running ? "live.stop" : "live.start");
  refreshTemplate(); if (view === "home") renderSessions(); if (view === "tpl") renderHome();
};
["#asrModel", "#mtModel", "#ctModel"].forEach((s) => $(s).addEventListener("change", showModelHints));
$("#editCurTpl").onclick = () => { $("#settings").hidden = true; openCreator(sessTemplate(curSess) || cfg.tpl); };
["#showSrc", "#tgtSize"].forEach((s) => $(s).addEventListener("input", applySettings));
["#maxGain", "#agcTarget", "#vad", "#silence", "#prefix", "#maxTurn", "#gain"].forEach((s) => $(s).addEventListener("input", applySettings));
$("#resetAudio").onclick = () => { for (const [id, d] of Object.entries(AUDIO_DEFAULTS)) { const e = $("#" + id); if (e.type === "checkbox") e.checked = d; else e.value = d; } applySettings(); };

function transcriptText() {
  return lines.filter((l) => l.src || l.tgt).map((l) => `[${l.ms != null ? fmtClock(l.ms) : l.t.toTimeString().slice(0, 8)}] ${l.tgt}\n           ${l.src}`).join("\n");
}
$("#copyAll").onclick = async (e) => {
  try { await navigator.clipboard.writeText(transcriptText()); flashBtn(e.target, t("rec.copied")); }
  catch { flashBtn(e.target, t("rec.copyFail")); }
};
$("#saveAll").onclick = () => download(fileName(curSess ? curSess.name : cfg.tpl.name) + ".txt", transcriptText());
$("#memoClear").onclick = (e) => { setMemo([]); flashBtn(e.target, t("rec.memoCleared")); };
$("#resetCost").onclick = (e) => { cost.asr = cost.mt = 0; cost.save(); showLat(); flashBtn(e.target, t("rec.costCleared")); };
let clearArmed = false;
$("#clearAll").onclick = (e) => {
  if (!clearArmed) { clearArmed = true; e.target.textContent = t("rec.clearSure"); setTimeout(() => { clearArmed = false; e.target.textContent = t("rec.clear"); }, 3000); return; }
  lines.length = 0; history.length = 0; $("#log").replaceChildren(); clearArmed = false; e.target.textContent = t("rec.clear"); setMemo([]);
  clearTimeout(saveLinesTimer); store.set(linesKey(), null); if (curSess) { curSess.count = 0; saveSessions(); } showEmptyHint();
};
$("#recap").onclick = async (e) => {
  applySettings();
  const body = lines.filter((l) => l.src).map((l) => `${l.t.toTimeString().slice(0, 5)} | ${l.src} | ${l.tgt}`).join("\n");
  if (!body) { $("#recapOut").textContent = t("rec.recapEmpty"); return; }
  e.target.disabled = true; $("#recapOut").textContent = t("rec.recapBusy");
  const tgt = tgtName(cfg.tpl.target, "en");
  try {
    const res = await fetch(cfg.apiBase + "/chat/completions", {
      method: "POST", headers: apiHeaders(),
      body: JSON.stringify({ model: cfg.ctModel, reasoning_effort: "medium", messages: [{ role: "user", content:
        `Below is a live subtitle log of "${cfg.tpl.name}" (ASR + live correction; may still contain recognition errors). Write in ${tgt}, plain text:\n1. Summary (about 300 words or 300 characters): what happened, segments, highlights and important announcements (events, merchandise, release dates — list dates exactly).\n2. Section by section: split by segment/topic, give each a short heading, and rewrite the content as clear, complete prose.\n3. Uncertain points: places where the ASR may have misheard or that cannot be determined.\n\nTemplate context:\n${glossaryForLLM()}\n\nLog (time | original | live translation):\n${body}` }] }),
    });
    if (!res.ok) throw new Error(res.status + " " + (await res.text()).slice(0, 200));
    const rd = await res.json(); addMtCost(cfg.ctModel, rd.usage);
    $("#recapOut").textContent = rd.choices[0].message.content;
  } catch (err) { $("#recapOut").textContent = t("rec.recapFail") + err.message; }
  e.target.disabled = false;
};

// ---------- 启动 ----------
// 旧版(单一节目,subs.html)的字幕记录复制到内置模板下。旧版页面和这里同源、共用存储,所以只复制不删除
if (store.get("lines", null) && !store.get("lines.hoooope-2026", null)) store.set("lines.hoooope-2026", store.get("lines", null));
buildTicks();
applyI18n();
migrateToSessions();
useSession(store.get("curSession", null));
setFollow(true);
setStatus("status.idle");
showLat();
show(["home", "tpl", "live", "create"].includes(store.get("view", "")) ? store.get("view", "") : "home");
// 收音中离开页面先确认(iOS 不一定弹,字幕反正已存本地)
window.addEventListener("beforeunload", (e) => { if (running) { e.preventDefault(); e.returnValue = ""; } });
// 给端到端测试用的观察口(模块作用域里的状态外面看不到)
Object.assign(window, { __t: { get lines() { return lines; }, get spk() { return spk; }, setPickFor: (v) => (pickFor = v), subtitleFile, fileConfig, sessionConfig } });
