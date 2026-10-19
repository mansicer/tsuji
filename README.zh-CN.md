<h1 align="center">Tsuji(通事)</h1>

<p align="center"><b>浏览器里的实时双语字幕翻译</b></p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmansicer%2Ftsuji&project-name=tsuji&repository-name=tsuji"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mansicer/tsuji?color=blue" alt="License"></a>
  <a href="https://github.com/mansicer/tsuji/commits/main"><img src="https://img.shields.io/github/last-commit/mansicer/tsuji" alt="Last commit"></a>
  <a href="https://github.com/mansicer/tsuji/stargazers"><img src="https://img.shields.io/github/stars/mansicer/tsuji?style=flat" alt="Stars"></a>
  <br>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/OpenAI-Realtime%20%2B%20GPT-412991?logo=openai&logoColor=white" alt="OpenAI Realtime + GPT">
  <img src="https://img.shields.io/badge/ONNX%20Runtime-Web-005CED?logo=onnx&logoColor=white" alt="ONNX Runtime Web">
  <img src="https://img.shields.io/badge/FFmpeg-wasm-007808?logo=ffmpeg&logoColor=white" alt="ffmpeg.wasm">
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

手机或电脑浏览器直接开麦,连续收音 → OpenAI Realtime 语音识别 → GPT 按模板词表校正并翻译,一句一句出双语字幕。
不用装 App,所有请求都从浏览器直接发给 OpenAI,API 密钥只保存在本机浏览器里。

- **模板**:节目或活动的背景说明、出演者和专有名词表、译文风格。同一份词表同时给识别(提示词 / 关键词)和翻译(按读音纠正听错的人名、统一译名)。可以和 GPT 对话、上传课件等资料新建模板,也可以导入导出。
- **翻译记忆**:翻译时模型可以把对后续翻译有用的信息(谁在场、当前话题、昵称、某个词指什么)记成简短笔记,之后每批翻译都会带上;按会话保存,在「记录」里查看。
- **摘要**:按会话生成字幕摘要;记录太长时按模型上下文分段整理再合并。
- **会话**:每次翻译是一个会话,单独保存语言、模型、收音和显示设置以及字幕记录,刷新或标签页被回收后自动恢复。
- **文件翻译**:上传视频或音频,浏览器内用 ffmpeg.wasm 提取音轨后按 4 倍速识别翻译,播放器上同步叠加字幕,可导出 SRT / VTT。
- **说话人**(实验功能,文件会话):浏览器本地用 CAM++ 声纹模型把声音分组,再由 GPT 结合字幕、模板里的出演者和说话人线索认出每组是谁,每句字幕标上说话人(每集约几美分 API 费用)。确认过的声音可以存进模板,下次自动认人。
- 识别语言 / 目标语言:中、英、日、韩、法、德、西;界面中英文。

## 使用

打开部署好的页面 →「设置」里填 OpenAI API 密钥 → 新建会话 →「开始收音」。手机浏览器只在 HTTPS 下给麦克风权限。

现场注意:屏幕保持常亮、不要切到别的 App(iOS 切后台会停麦),手机朝向音箱。另外请先确认会场规定,很多活动禁止录音录像。

## 开发

```bash
npm install
npm run dev        # 本地开发(首次会下载 28 MB 的声纹模型到 public/models/)
npm test           # 单元测试
npm run build      # 输出到 dist/
npm run e2e        # 端到端测试:在 Chromium 里跑 dist/,OpenAI 接口是假的,不花钱
```

大文件都和页面同源发布,不依赖外部 CDN:ffmpeg.wasm(32 MB)和 onnxruntime-web 的 wasm(14 MB)来自 npm 依赖,CAM++ 模型构建前由 `scripts/fetch-model.mjs` 下载并校验 sha256。三者都只在用到时才加载。

## 部署

### Vercel(或任意静态托管)

纯静态站点:构建命令 `npm run build`,输出目录 `dist`。仓库里的 `vercel.json` 已写好,点上面的 **Deploy with Vercel** 或在 Vercel 导入仓库即可,不需要环境变量。

### 自托管 + 服务器代填密钥(可选)

想让用户不填密钥也能用,可以在自己的服务器上把同站路径(例如 `/openai/v1`)反代到 `api.openai.com` 并加上 `Authorization` 头,前面挡一层登录,然后:

```bash
cp .env.selfhost.example .env.selfhost   # 填 VITE_SERVER_API、VITE_BASE、DEPLOY_HOST、DEPLOY_DIR
npm run deploy:selfhost                  # 只发布已提交的代码;大文件预压缩 .gz,整体替换上线
```

需要放行的接口:`/realtime`(WebSocket)、`/chat/completions`、`/responses`。用户在设置里填了自己的密钥时仍然直连 OpenAI。

## 致谢

- 声纹模型:[3D-Speaker](https://github.com/modelscope/3D-Speaker) CAM++(`speech_campplus_sv_zh-cn_16k-common`),onnx 版本来自 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)、[onnxruntime-web](https://github.com/microsoft/onnxruntime)

## 许可证

[Apache-2.0](LICENSE)
