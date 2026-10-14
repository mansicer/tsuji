# Tsuji

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmansicer%2Ftsuji&project-name=tsuji&repository-name=tsuji) [![License](https://img.shields.io/github/license/mansicer/tsuji)](LICENSE)

English | [简体中文](README.zh-CN.md)

**Live bilingual subtitles in your browser.** Open the page on your phone or laptop, start the microphone, and Tsuji turns continuous speech into line-by-line bilingual subtitles: OpenAI Realtime transcribes, then GPT corrects the transcript against your glossary and translates it.

No app to install. Every request goes straight from the browser to OpenAI, and your API key stays in your browser's local storage.

*Tsuji (通事) were the official interpreters of Edo-period Japan.*

## Features

- **Templates**: background notes, people and terminology glossary, and translation style for a show or event. The same glossary feeds both recognition (prompt / keywords) and translation (fixing misheard names by their reading, keeping translations consistent). Create one by chatting with GPT and uploading material such as slides, or import / export them as JSON.
- **Sessions**: each translation is a session with its own languages, models, audio and display settings, and subtitle history. Sessions survive page reloads and discarded tabs.
- **File translation**: upload a video or audio file. The audio track is extracted in the browser with ffmpeg.wasm and processed at 4× speed. Subtitles are overlaid on the player in sync and can be exported as SRT / VTT.
- **Speaker identification** (experimental, file sessions): a CAM++ speaker-embedding model runs locally in the browser to group voices, then GPT works out who each group is from the subtitles and the template's people and speaker cues. Each line is tagged with its speaker, at a cost of a few cents per episode. Confirmed voices can be saved into the template so people are recognized automatically next time.
- Languages: Chinese, English, Japanese, Korean, French, German and Spanish for both source and target. The interface is available in Chinese and English.

## Usage

Open the deployed page → enter your OpenAI API key in **Settings** → create a session → **Start**. Mobile browsers only grant microphone access over HTTPS.

At live events: keep the screen on, don't switch to another app (iOS stops the microphone in the background), and point the phone toward the speakers. Check the venue rules first, since many events prohibit recording.

### Built-in templates

- **MyGO!!!!!の迷子集会**: BanG Dream! MyGO!!!!! radio show (characters, voice actors, songs, speaker cues)
- **EXTEND STEP HOOOOPE! 番組イベント2026**: live event of a rookie voice-actor radio show by Bunka Hoso Extend

## Development

```bash
npm install
npm run dev        # dev server (the first run downloads the 28 MB speaker model to public/models/)
npm test           # unit tests
npm run build      # output in dist/
```

Code layout:

| Path | Contents |
|---|---|
| `index.html` | Page skeleton |
| `src/main.ts` | Main application |
| `src/spk/core.ts` | Speaker identification math: resampling, energy-based segmentation, Kaldi-compatible fbank, clustering, smoothing |
| `src/spk/judge.ts` | GPT speaker judgment |
| `src/config.ts` | Default models, built-in templates, deployment config |
| `src/builtin/` | Built-in templates |

All large assets are served from the same origin with no external CDN: ffmpeg.wasm (32 MB) and the onnxruntime-web wasm (14 MB) come from npm dependencies, and the CAM++ model is downloaded and sha256-verified by `scripts/fetch-model.mjs` before the build. Each is loaded only when needed.

## Deployment

### Vercel (or any static host)

Tsuji is a static site: build command `npm run build`, output directory `dist`. The included `vercel.json` is ready to use: click **Deploy with Vercel** above, or import the repository on Vercel. No environment variables are needed.

### Self-hosted with a server-side key (optional)

To let users skip entering a key, reverse-proxy a same-site path (for example `/openai/v1`) to `api.openai.com` on your own server, add the `Authorization` header there, and put a login in front of it. Then:

```bash
cp .env.selfhost.example .env.selfhost   # fill in VITE_SERVER_API, VITE_BASE, DEPLOY_HOST, DEPLOY_DIR
npm run deploy:selfhost                  # deploys committed code only; pre-compresses large files and swaps the whole directory
```

Endpoints the proxy must allow: `/realtime` (WebSocket), `/chat/completions` and `/responses`. Users who enter their own key in Settings still connect to OpenAI directly.

## Acknowledgements

- Speaker model: [3D-Speaker](https://github.com/modelscope/3D-Speaker) CAM++ (`speech_campplus_sv_zh-cn_16k-common`), ONNX export from [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), [onnxruntime-web](https://github.com/microsoft/onnxruntime)

## License

[Apache-2.0](LICENSE)
