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
| `src/spk/engine.ts` | UI-free core: load model, `embed(pcm16k) → Float32Array(192)` (normalised), `match(vec, library)`, `cluster(vecs)`. Wraps `spk/core.ts`. |
| `src/spk/engine.worker.ts` | Runs CAM++ (onnxruntime-web) in a Web Worker. `engine.ts` talks to it via postMessage and falls back to the main thread if Workers fail. |
| `src/live-audio.ts` | Rolling buffer of live mic PCM (24 kHz), the session audio clock, and segment timing for live lines. |
| `src/spk/live.ts` | Live speaker pipeline: segments → embed → library match (A) / online clustering (B) → per-line vote → display. |
| `src/spk/live-schedule.ts` | Pure: when to call GPT (adaptive schedule) and name-source precedence. |
| `src/spk/live-eval.ts` | Pure: scores live labels against reference labels (from C or from a test script). |
| `src/live-record.ts` | C: MediaRecorder recording, storage, and conversion to a file session. |

## Shared contracts

### Voice library (template `voices`)
Existing format: `{ [name]: { v: base64(Float32[192]), d: seconds } }`. It stays readable.
New, backward compatible: an entry may also carry `alts?: { v: string; d: number; src: "file" | "live" }[]`. These are extra voiceprints for the same person, for example studio and live. Matching uses the best of `v` and all `alts`. Saving from a live session adds or merges into an `alts` entry with `src: "live"`. Saving from a file session keeps updating `v`.

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
type NameSrc = "manual" | "library" | "gpt-evidence" | "gpt-guess";
// per line: line.lspk = { g: groupId | null, name: string | null, src: NameSrc | null, conf: number }
```
Lines are shown with a coloured chip: the name if named, otherwise the letter. A line with `g === null` gets no chip.

### GPT judge (adaptive)
`live-schedule.ts` exports `nextJudgeDelay(stats) → ms | null` (`null` means don't call). Its rules:
- **Cold start.** While some group has at least 20 s of speech and no name: call every 30–60 s. Call immediately when a new group appears or when a self-introduction or name-calling cue is detected locally.
- **Back-off.** When consecutive judgments change nothing, the delay grows 1 min → 2 min → 5 min.
- **Reset to fast** on any of these: a new group, a merge or split after reclustering, or a rise in uncertain lines.
- **Skip** when there is no new text since the last call. A per-hour call cap applies.

The judge request sends only the lines since the last call, plus a summary of each group. It reuses `spk/judge.ts` prompts where possible.

## Validation
- **Test audio.** ffmpeg's `flite` filter provides four distinct English voices: `kal`, `awb`, `rms` and `slt`. A script concatenates a scripted multi-speaker conversation into a WAV. The same script records who speaks when, which serves as the reference labels.
- **E2E.** Chromium's `--use-file-for-fake-audio-capture=<wav>` makes that WAV the microphone. The fake Realtime WebSocket emits transcripts with `audio_start_ms`/`audio_end_ms` taken from the script. The tests assert on labels.
- **Evaluation.** `live-eval.ts` scores accuracy (correct labels among labelled lines), coverage (labelled lines among all lines) and churn (label changes after first shown).

## Phase 2 decisions (from the feasibility measurements)
Measured with real CAM++ on 4 flite voices. Full report from the engine agent: within one recording condition, same-speaker similarity is ≥ 0.81 and different-speaker similarity is ≤ 0.65. Clean voiceprints against room-degraded speech of the same voice drop to 0.54–0.81. Short 1.5 s clips still rank the right voice first against a centroid, at 0.55–0.84. In the worker, embedding takes about 0.1× real time: ~400 ms for a 4 s segment, ~150 ms for 1.5 s.

**A and B form one pipeline.** Segments are clustered online (B). Each group's *centroid*, never a single segment, is matched against the template library (A). A library match names the group with `src: "library"`. The live pipeline's constants live in one exported `LIVE_SPK` object. Defaults:
- cluster distance `0.38`, i.e. join if the cosine similarity to a group centroid is ≥ 0.62;
- a group becomes visible at ≥ 3 s of speech or ≥ 2 segments;
- segments shorter than 1.0 s are not clustered; they take the nearest visible group if its similarity is ≥ 0.55, otherwise no label;
- library match per entry source: a `live` alt needs ≥ 0.80; a file `v` / `file` alt needs ≥ 0.70. Both need a margin of ≥ 0.08 over the second-best entry and a mutual best against the other groups' centroids. A group is matched only once it has ≥ 4 s of speech;
- full recluster of all retained segment vectors (the last 400) every 30 s or every 10 new segments. New clusters map to old group ids by membership overlap (Hungarian), so letters and names stay stable. The recluster reports `merge` / `split` events.

### `spk/live.ts` API (consumed by `spk/live-judge.ts` and the UI)
```ts
export interface LiveGroup { id: number; letter: string; name: string | null; src: NameSrc | null; cent: Float32Array; dur: number; n: number; visible: boolean }
export interface LiveSpkApi {
  groups(): LiveGroup[];                                  // visible groups only
  linesSince(at: number): { id: number; text: string; g: number | null; aStart: number }[]; // live lines with aStart >= at
  uncertain(): number;                                   // live lines with speech but no group label
  events(): { kind: "new-group" | "merge" | "split" | "cue"; at: number }[]; // last hour, wall-clock ms
  propose(p: { id: number; name: string; src: NameSrc }[]): { changed: boolean }; // goes through applyNames precedence
}
export function liveSpk(): LiveSpkApi | null;            // null while live speaker id is off / not running
```
`NameSrc`, `applyNames`, `canOverride` and `detectCue` live in `spk/live-schedule.ts`. `live.ts` calls `detectCue` on every new live line, and a hit adds a `cue` event.

### `spk/live-judge.ts`
This module owns the GPT loop for live sessions. It is started and stopped with live listening. It uses `nextJudgeDelay` and sends only the lines since the previous call, plus a summary of each group (letter, current name and source, seconds of speech) and the template people and speaker notes. The reply contains, for each group, a name and evidence (`intro`, `called` or `context`, mapped to `gpt-evidence` or `gpt-guess`) or no name. It calls `propose()` and records `{at, changed}` per call. It uses `cfg.ctModel`, `apiHeaders()` and `addMtCost()`, all injected.
