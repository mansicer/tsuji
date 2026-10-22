# Live speaker identification: design

Speaker identification used to work only in file sessions: it analysed the whole file after processing. This feature extends it to live sessions (the microphone).

- **A, known voices.** Each speech segment is matched against the template's voice library and labelled with a name.
- **B, unknown voices.** Segments are clustered online into anonymous groups (A, B, C…). The groups are named over time by GPT on an adaptive schedule, by the user, or from the library.
- **C, record and re-analyse.** This is an opt-in recording of the live session. Afterwards the recording becomes a new file session, which goes through the existing file pipeline: transcription, translation and speaker analysis. The result is the most accurate one available, and it serves as the reference for evaluating A/B.

Every path feeds the template voice library. A group whose name the user confirmed can be saved, so the next session with the same template recognises that person immediately.

## Principles
- **Prefer no label over a wrong one.** An uncertain line gets no speaker. An unnamed group shows as a letter, never a guessed name.
- **Subtitles never wait for speaker identification.** Names are attached to a line later.
- **A and B store no audio.** They keep a rolling buffer of the last 60 s in memory. Only C records, and it is off by default, enabled per session after a warning that many events prohibit recording.
- **Precedence of name sources**, from highest to lowest: `manual` > `library` > `gpt-evidence` (self-introduction or being addressed by name) > `gpt-guess`. A lower source never overrides a higher one. A `manual` name is locked.

## Modules (all strict TypeScript)
| File | Role |
|---|---|
| `src/spk/engine.ts` | UI-free core: load model, `embed(pcm16k) → Float32Array(192)` (normalised), library matching, `cluster(vecs, dist)`. Wraps `spk/core.ts`. See "Speaker engine API" below. |
| `src/spk/engine.worker.ts` | Runs CAM++ (onnxruntime-web) in a Web Worker. `engine.ts` talks to it via postMessage and falls back to the main thread if Workers fail. |
| `src/spk/infer.ts` | The CAM++ inference itself: `createModel(buf)` and `runEmbed(model, pcm16k)` (fbank, ONNX, normalise). The worker imports it, and `engine.ts` loads it lazily for the main-thread fallback. |
| `src/live-audio.ts` | Rolling buffer of live mic PCM (24 kHz), the session audio clock, and segment timing for live lines. |
| `src/spk/live.ts` | Live speaker pipeline: segments → embed → library match (A) / online clustering (B) → per-line vote → display. |
| `src/spk/live-schedule.ts` | Pure: when to call GPT (adaptive schedule), name-source precedence (`NameSrc`, `canOverride`, `applyNames`) and cue detection (`detectCue`). |
| `src/spk/live-eval.ts` | Pure: scores live labels against reference labels (from C or from a test script). |
| `src/live-record.ts` | C: MediaRecorder recording, storage, and conversion to a file session. |

## Shared contracts

### Voice library (template `voices`)
Existing format: `{ [name]: { v: base64(Float32[192]), d: seconds } }`. It stays readable.
New, backward compatible: an entry may also carry `alts?: { v: string; d: number; src: "file" | "live" }[]`. These are extra voiceprints for the same person, for example studio and live. Matching uses the best of `v` and all `alts`. Saving from a live session adds or merges into an `alts` entry with `src: "live"`. Saving from a file session keeps updating `v`.

### Speaker engine API (`spk/engine.ts`)
- `loadModel(onPct?)` loads CAM++ once. The promise is shared, and a failed load can be retried. `embed(pcm16k)` loads the model on demand.
- `engineKind(): Promise<"worker" | "main" | null>` says where the model runs (`null` before loading). `resetEngine(main = false)` unloads it; with `main = true` the next load is forced onto the main thread. Both are for tests and benchmarks.
- `libEntries(voices) → LibEntry[]` decodes a template voice library once into `{ name, vecs }`, with `v` first and then every `alts[].v`. `libScore(vec, entry)` is the best cosine over an entry's `vecs`.
- `match(vec, library, { min?, margin?, others? }) → { name, sim, second } | null`. `library` is either `LibEntry[]` or the raw `voices` record. The defaults are `LIB_MIN` (0.88) and `LIB_MARGIN` (0.05), which are the file-session rules; the live pipeline passes its own `min`/`margin` from `LIVE_SPK`. `others` holds the other vectors being matched at the same time, such as the other groups' centroids. If any of them scores at least as high on the winning entry, the match is rejected (mutual best).
- `matchAll(vecs, library, { min?, margin? })` matches each vector with `others` set to the rest of `vecs`.

### Live audio clock (`live-audio.ts`)
- The audio time `at` is the number of milliseconds of mic audio captured since the session's mic was started in this page. It is counted from samples, not wall time. It keeps increasing across reconnects and mic restarts. On `stop()` it resets.
- `liveAudio.push(pcm24k: Int16Array)` is called from `onSamples` for every 100 ms chunk, whether or not the WebSocket is open.
- `liveAudio.now(): number` returns the current `at`.
- `liveAudio.slice(fromAt, toAt): Float32Array | null` returns 16 kHz mono audio for that range, or `null` if it has already fallen out of the 60 s buffer.
- The Realtime session reports `audio_start_ms`/`audio_end_ms` relative to the first audio appended on that WebSocket connection. `live-audio.ts` records `connAt` when each connection starts sending, and maps `at = connAt + audio_*_ms`.
- A live line gets `line.aStart` / `line.aEnd` (audio-clock ms). These are **separate from** `line.ms` / `line.endMs`, which are file-session media times and drive seek, overlay and SRT export. Live lines must keep `ms` undefined.
- Streaming ASR models (`gpt-live-transcribe`, `gpt-realtime-whisper`) have no VAD events. For them, the times come from local energy segmentation (`spkSegments`) of the buffer around the moment the line was emitted.
- `onLineAudio(cb: (line: Line) => void): () => void` (returns an unsubscribe) fires right after a new live line gets `aStart`/`aEnd`, before translation. It fires again for the earlier line when a short line is merged into it and its `aEnd` grows. Lines restored from storage keep their saved `aStart`/`aEnd` (keys `as`/`ae`), but those belong to an earlier clock and must not be passed to `slice()`; `onLineAudio` never fires for them.
- Also exported for the pipeline: `liveAudio.pcm(fromAt, toAt): Int16Array | null` (raw 24 kHz) and `liveAudio.oldest()` (earliest `at` still buffered). `begin()`, `forced()`, `event(m)` and `guess()` are only for `main.ts`.

### Live speaker state (`spk/live.ts`)
```ts
interface LiveGroup { id: number; letter: string; name: string | null; src: NameSrc | null; cent: Float32Array; dur: number; n: number }
type NameSrc = "manual" | "library" | "gpt-evidence" | "gpt-guess"; // exported from spk/live-schedule.ts
// per line: line.lspk = { g: groupId | null, name: string | null, src: NameSrc | null, conf: number }
```
Lines are shown with a coloured chip: the name if named, otherwise the letter. A line with `g === null` gets no chip.

### GPT judge (adaptive)
`live-schedule.ts` exports `nextJudgeDelay(stats) → ms | null` (`null` means don't call). Its rules:
- **Cold start.** While some group has at least 20 s of speech and no name: call every 30–60 s. Call immediately when a new group appears or when a self-introduction or name-calling cue is detected locally.
- **Back-off.** When consecutive judgments change nothing, the delay grows 1 min → 2 min → 5 min.
- **Reset to fast** on any of these: a new group, a merge or split after reclustering, or a rise in the *share* of uncertain (unlabelled) lines among the new lines since the last call, compared with the previous call's window (`uncertainRose`: +0.2 or more, both windows ≥ 5 lines). A running count is not used: in lively talk it rises on almost every call.
- **Skip** when there is no new text since the last call, or when every group is locked (named by the user or the library). A per-hour call cap of 40 applies.

In practice that is about 15–40 calls an hour, roughly $0.05–0.20 per hour with the default model. The `lspk.onHint` and `spk.confirm` texts tell the user so.

The judge request sends the lines since the last call, plus a summary of each group and the last 5 already-sent lines marked as context. A line sent as `[?]` (no group yet) is sent again once it gets a group, if it is still within 60 s of audio clock. A cue-triggered call waits until the cue line has a group, at most 15 s. It reuses `spk/judge.ts` prompts where possible.

### Live recording (C, `live-record.ts`)
- **Session fields (`state.ts`).** `Session.rec?: RecInfo`, where `RecInfo = { on: boolean; bytes: number; parts: RecPart[] }` and `RecPart = { t0: number; t1: number; at?: number; mime: string; bytes: number }`.
  - `on` is per session and off by default. Turning it on asks for confirmation every time.
  - A new part starts whenever listening starts, the mic restarts, or recording is turned on while listening.
  - `t0`/`t1` are wall-clock ms. `at` is the audio clock at the start of the part, present when `live-audio.ts` is. `mime` is the format MediaRecorder actually used: webm/opus first, mp4 on Safari.
- **Chunk keys.** About every 10 s a chunk goes to IndexedDB under `rec:<sid>:<ppp>:<nnnnnn>`. The part and chunk numbers are zero-padded, so key order is recording order. The value is a `Blob`, or `{ buf: ArrayBuffer, type }` where Blobs can't be stored. The part entry is saved before its first chunk. Helpers: `recKey`, `recPrefix(sid)`, `recPartOf(key)` and `partBlobs(rec, entries)`.
- **Storage.** `idb.entries(prefix)` reads all chunks of a session, and `idb.delPrefix(prefix)` deletes a key range. Deleting a session calls `idb.delPrefix(recPrefix(id))`. If storage is full, recording stops and `rec.on` turns off, but listening continues.
- **Conversion.** A single part is used as is; several parts are joined with ffmpeg.wasm (`concatAudio`). The result becomes a new file session with the same template and languages.
  - The two sessions point at each other: the live session's `recSession` holds the file session id, and the file session's `fromLive` holds the live session id.
  - While the `recSession` file session still exists, the button reads "Open the converted file session" and just switches to it. No new session is created.
  - Deleting the file session clears `recSession` on the live session (`deleteSession` in `sessions.ts`), so the recording can be converted again.

## Validation
- **Test audio (`e2e/tts.ts`).** ffmpeg's `flite` filter provides four distinct English voices: `kal`, `awb`, `rms` and `slt`. This file is the only generator. WAVs are generated in test setup and never committed.
  - `ttsConversation(turns, opts) → { path, timeline, durationMs, rate }`, where `turns` is `{ voice, text, gapMs? }[]`. Each sentence is synthesised, trimmed of leading and trailing silence, and preceded by `gapMs` of silence (default `opts.gapMs`, 600). The WAV ends with `opts.tailMs` of silence (default 1000).
  - `timeline[i].startMs` / `endMs` mark the voiced part of each sentence. They serve as the reference labels.
  - `opts.trim` sets when a 10 ms frame counts as silent. With `"peak"` (default), its peak is below 1 % of full scale. With `"rms"`, its RMS is below 1 % of full scale instead, which trims tighter.
  - Other options: `opts.rate` (default 24000), `opts.af` (an extra ffmpeg `-af` chain such as `ROOM_AF`) and `opts.out` (default: a content-addressed file in the OS temp dir).
  - Also exported: `synth(voice, text)`, `readWav`/`writeWav` (mono 16-bit PCM), `ROOM_AF` and `addNoise(src, out, noiseDb)`. Files are written atomically (temp file, then rename), so parallel workers never read half a WAV.
  - CLI: `node e2e/tts.ts out.wav` writes a four-voice demo conversation and prints its timeline as JSON.
- **Fake microphone.** Chromium's `--use-file-for-fake-audio-capture=<abs wav>` makes that WAV the microphone. It plays in real time from when `getUserMedia` opens, and loops every `durationMs`. Set it per test file only, so other files keep the default fake device:
  ```ts
  // per-pid path: workers don't share the file
  const WAV = ttsConversation(turns, { out: join(tmpdir(), `tsuji-x-${process.pid}.wav`) }).path;
  test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=" + WAV] } });
  ```
  The audio clock's 0 is not exactly the start of the WAV. `e2e/live-audio.e2e.ts` measures the offset from the first onset in the buffer (`clockOffset`, within ±150 ms in practice) before it maps the timeline to clock times.
- **E2E.** The fake Realtime WebSocket emits transcripts with `audio_start_ms`/`audio_end_ms` taken from the timeline. The tests assert on labels.
- **Evaluation.** `live-eval.ts` scores accuracy (correct labels among labelled lines), coverage (labelled lines among all lines) and churn (label changes after first shown).

## Phase 2 decisions (from the feasibility measurements)
Measured with real CAM++ on 4 flite voices. Full report from the engine agent: within one recording condition, same-speaker similarity is ≥ 0.81 and different-speaker similarity is ≤ 0.65. Clean voiceprints against room-degraded speech of the same voice drop to 0.54–0.81. Short 1.5 s clips still rank the right voice first against a centroid, at 0.55–0.84. In the worker, embedding takes about 0.1× real time: ~400 ms for a 4 s segment, ~150 ms for 1.5 s.

**A and B form one pipeline.** Segments are clustered online (B). Each group's *centroid*, never a single segment, is matched against the template library (A). A library match names the group with `src: "library"`. The live pipeline's constants live in one exported `LIVE_SPK` object. Defaults:
- cluster distance `0.38`, i.e. join if the cosine similarity to a group centroid is ≥ 0.62;
- a group becomes visible at ≥ 3 s of speech or ≥ 2 segments;
- segments shorter than 1.0 s are not clustered; they take the nearest visible group if its similarity is ≥ 0.55, otherwise no label;
- library match per entry source: a `live` alt needs ≥ 0.80; a file `v` / `file` alt needs ≥ 0.70. Both need a margin of ≥ 0.08 over the second-best entry and a mutual best against the other groups' centroids. A group is matched only once it has ≥ 4 s of speech;
- full recluster of all retained segment vectors (the last 400) every 30 s or every 10 new segments. New clusters map to old group ids by membership overlap (Hungarian), so letters and names stay stable. The recluster reports `merge` / `split` events.
- *major groups*: a visible group is major when it holds ≥ 10 % of all visible speech, was named by the user or the library, or was confirmed by the user (below). When the major groups hold ≥ 30 % of the speech, lines in a minor group and short segments without a group are shown as the nearest major group (cosine ≥ 0.3). Otherwise the groups are too fragmented and nothing is remapped. Only major groups are sent to the GPT judge.
  - Different voices are often above 0.3 too, so a person who speaks under 10 % is shown as someone else until the user corrects one of their lines ("Someone else", below). After that their group is confirmed and keeps its own label.
  - Tried and dropped: a bar that adapts to each major group's spread (25th percentile of member-to-centroid cosine − 0.2). Members only join a group at cosine ≥ 0.62, so groups are always tight (0.78–0.89 on the MyGO clip) and the bar measured the clustering threshold, not how separable the voices are. On MyGO it landed at 0.61–0.68, left 5–9 groups shown for 3 people, and averaged 70.8 % accuracy / 92.5 % coverage over 8 line segmentations, against 72.9 % / 98.6 % for the fixed 0.3. A single run varies between 57 % and 86 % with the line boundaries, so compare averages over several segmentations;
- *correcting one line* (tag picker, "Only this line is actually:"): the user moves a line to another shown group, or to "someone else". "Someone else" confirms the line's own minor group if it was remapped; otherwise it starts a new group from that line. The target group is marked confirmed (`ok`, saved with the groups): it counts as major and is never remapped. The line is pinned (`seg.pin`): reclustering and remapping never move it, and its voiceprint joins the target group's centroid, so later lines from that voice are grouped with it. Pins live with the segments and are not saved; after a reload the line keeps its saved label and the group keeps `ok`.
- *GPT names*: a name that another group already holds at the same or a higher source is not given to a second group, unless the same batch also renames that holder (a swap). A higher-ranked GPT name takes the name from a lower-ranked holder, and the holder loses it. Without this rule, GPT moved one name back and forth between two groups, and every move relabelled all of their lines.

Re-measured on 10 minutes of a real three-person radio show with background music (MyGO!!!!!「迷子集会」#200; all three are young female voices). Here CAM++ separates the voices far less than on flite: 2 s windows of the same speaker have a median similarity of 0.56, different speakers 0.37. An offline replay of the recorded line boundaries scores one-to-one accuracy as follows. Major groups raise streaming `gpt-live-transcribe` from 70.7 % (coverage 72 %) to 80.6 % (coverage 98 %). Simulated pause cuts on the `gpt-transcribe` run raise it from 67 % to 86 %, at coverage ≥ 99 %. Some things did not help on this audio:
- splitting lines into 1.5–3 s windows and clustering those;
- detecting speaker changes from adjacent windows;
- mean-centering the embeddings;
- padding short lines to 1.5 s.

### `spk/live.ts` API (consumed by `spk/live-judge.ts` and the UI)
```ts
export interface LiveGroup { id: number; letter: string; name: string | null; src: NameSrc | null; cent: Float32Array; dur: number; n: number; visible: boolean }
export interface LiveSpkApi {
  groups(): LiveGroup[];                                  // major groups (all visible groups when too fragmented)
  linesSince(at: number): { id: number; text: string; g: number | null; aStart: number }[]; // live lines with aStart >= at
  uncertain(): number;                                   // live lines with speech but no group label
  events(): { kind: "new-group" | "merge" | "split" | "cue"; at: number }[]; // last hour, wall-clock ms
  propose(p: { id: number; name: string; src: NameSrc }[]): { changed: boolean }; // goes through applyNames precedence
}
export function liveSpk(): LiveSpkApi | null;            // null while live speaker id is off / not running
```
Notes on the implementation (`spk/live.ts`, pure parts in `spk/live-core.ts`):
- `liveSpk()` is non-null only while listening with speaker identification on. `linesSince` and `uncertain` cover the lines of the current listening run (the audio clock restarts with each run). A group's `letter` follows from its id (0 → A).
- Group ids are assigned when a group becomes visible, so letters have no gaps. Before that a group is internal and its lines have `g: null`.
- Saving a live voice for a person who is not in the library yet creates `{ v: <live centroid>, d: 0, alts: [{ src: "live", … }] }`. `d: 0` marks `v` as a placeholder: live matching ignores it, and the next file-session save overwrites it (it merges with weight `d`).

`NameSrc`, `applyNames`, `canOverride` and `detectCue` live in `spk/live-schedule.ts`. `live.ts` calls `detectCue` on every new live line, and a hit adds a `cue` event.

### `spk/live-judge.ts`
This module owns the GPT loop for live sessions. It is started and stopped with live listening. It uses `nextJudgeDelay` and sends the lines since the previous call (with the context and resend rules above), plus a summary of each group (letter, current name and source, seconds of speech) and the template people and speaker notes. The reply contains, for each group, a name and evidence (`intro`, `called` or `context`, mapped to `gpt-evidence` or `gpt-guess`) or no name. It calls `propose()` and records `{at, changed}` per call. It uses `cfg.ctModel`, `apiHeaders()` and `addMtCost()`, all injected.
