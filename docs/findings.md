# Findings worth not rediscovering

Measured facts about the local inference stack. Everything here cost real
debugging time somewhere — most of it in
[`story-platform`](https://github.com/searpro/story-platform), whose
`docs/status.md` is the original source for F1–F7.

Add to this file whenever something behaves differently from how its
documentation reads.

---

## F1 — ASR word offsets are in the model's sample rate, not the file's

`POST /v1/audio/transcriptions` with `words_out: true` returns
`{word, start_sample, end_sample}`. **parakeet-tdt resamples to 16 kHz
internally**, so those indices are 16 kHz regardless of what the source file
is.

Verified on a real 24 kHz / 13.92 s narration whose last word ended at sample
221440:

- `221440 / 16000 = 13.84 s` ✅ matches
- `221440 / 24000 = 9.23 s` ❌ 4.7 s short

Dividing by the file's own rate is the obvious thing to reach for — the WAV
header parser already extracts it — and it compresses every caption to ~66% of
its correct time. Own the rate in **one** constant with a drift guard that
fails the alignment rather than shipping desynced subtitles.

## F2 — sd-api's OpenAI-shaped audio endpoints silently drop advanced fields

This has bitten twice. It is the first thing to suspect when an sd-api audio
feature "doesn't work": the request is accepted and forwarded, audiocpp_server's
OpenAI-shaped handler ignores the field, and a perfectly normal response comes
back.

Only the generic task runner — `POST /v1/audio/tasks/run` with
`{model, request: {task, ...}}` — applies them.

- `words_out` on `/v1/audio/transcriptions`: sd-api works around this
  internally, so callers never see it.
- `instruct` on `/v1/audio/speech`: **no workaround**, and sd-api's own README
  documents the non-working form. Measured with `qwen3-tts-voicedesign`:

  | Instruction | via `/audio/speech` | via task runner |
  | ----------- | ------------------- | --------------- |
  | "a high-pitched young girl" | ~130 Hz median F0 | 419 Hz |
  | "a deep, gravelly older man" | ~130 Hz median F0 | 88 Hz |

  Roughly 10% of `/audio/speech` calls against a `vdes` model also returned
  noise rather than speech.

**All voice design goes through the task runner.** Its gotchas:

- the text field is `text`, not `input`
- the task enum is the short form (`vdes`, `asr`, `clon`), not the friendly
  name in the model's own metadata
- it **persists nothing** — it returns base64 inline with
  `timing.audio_duration_ms`, so the caller stores the bytes itself

## F3 — `words_out` needs a server-local path

A bare output name resolves against sd-api's working directory and 404s, and
the multipart upload form ignores `words_out` entirely.

Upload the audio via `POST /v1/audio-voice-refs`, which returns an absolute
path, and transcribe that. This also means viceroy never needs to share a
filesystem with sd-api or know where it stores anything.

## F4 — Image dimensions must be multiples of 16

stable-diffusion.cpp **rounds up** to the next multiple instead of refusing, so
360 silently becomes 368 and the frame is no longer 9:16. The obvious "360p"
choice of 360×640 is therefore wrong, and a hardcoded 1080 was never honoured —
1080 is not a multiple of 16, so those images had been generating at 1088×1920
all along.

Reject non-conforming sizes at the boundary rather than letting frames land on
the renderer's letterbox path.

The *ratio* is fixed by the video. The *size* is environment configuration,
because how large a frame a machine can produce is a property of that machine:
1080×1920 is routine on a GPU and fails outright on a CPU-only box. Default
432×768, upscaled by the renderer to 1080×1920.

## F5 — Word-aligned captions display the ASR transcript, not the authored text

Cue bodies taken straight from ASR are what the model *heard*, not what the
writer *wrote*. Verified on "The 3:17 Call": the segment reads _"Right at three
seventeen."_ and the burned-in caption read _"Right at317,"_ — spoken numbers
normalised to digits, colon lost, curly apostrophes straightened.

Timing is accurate; wording is not authoritative.

This is inherent to deriving cues from ASR, and the fix is **not** to stop using
them — the timing is the whole point. Align the ASR words *against* the written
text and keep the written wording with the ASR timings. story-platform left this
untouched; viceroy treats it as part of the subtitle-alignment stage, not a
later polish item.

## F6 — Verify audio changes acoustically, not by file size

Generation is stochastic and clip sizes overlap heavily between conditions. An
early pass at F2 looked like `instruct` was working on `/audio/speech` purely
from durations — and an "extremely fast" instruction produced *longer* audio
than "extremely slow". Median F0 separated the conditions cleanly where
duration and byte count could not.

## F7 — Encoder output is not byte-reproducible

Assert on `ffprobe`-probed properties, never file hashes.

## F8 — sd-api's checked-in `dist/` goes stale, and it fails as a 404

`npm start` runs `dist/`, not `src/`. The tree as found had a `dist/` built on
2026-08-01 against `src/` last touched 2026-08-10, so the server booted
happily, served `/v1/models`, and returned
`NOT_FOUND: Route not found` for **every** LLM and audio route — the whole
surface viceroy depends on.

Nothing in the logs says "stale build". It looks exactly like the feature
isn't implemented.

Run `npm run build` before `npm start`, or use `npm run dev`. If an sd-api
route documented in its README 404s, check the build date before checking
anything else.

## F9 — `SD_ACCEL=cpu` applies to image generation only; LLM and audio get Metal

The three backends are accelerated independently, and the single `SD_ACCEL`
setting is misleading about it. Confirmed from sd-api's own startup log:

| Backend | Binary chosen | Acceleration |
| ------- | ------------- | ------------ |
| stable-diffusion.cpp | `sd-…-Darwin-macOS-26.5.2-arm64.zip` with `accel: cpu` | **CPU** |
| llama.cpp | system `llama-server`, default GPU layers | **Metal** |
| audio.cpp | `audiocpp-server-macos-arm64-**metal**.zip` — selected while logging `accel: cpu` | **Metal** |

Measured: `smolvlm2-2.2b-instruct` served **141 tokens/sec**, which is not a
CPU number for this box.

So image generation is the only CPU-bound stage, and it is the pipeline's
bottleneck. This also softens the concern behind choosing a dense 12B writer:
memory-bandwidth scaling puts Mistral Nemo Q4_K_M in the ~25–30 tok/s range on
Metal, or roughly 15 s for a 320-word story, which is negligible next to eight
CPU-generated frames.

## F10 — llama-server runs at a 4096-token context regardless of the model

sd-api spawns it as:

```
llama-server --models-dir … --host 127.0.0.1 --port 8090 -c 4096 --jinja
```

`-c 4096` is fixed, so Mistral Nemo's 128K context is unreachable through
sd-api. Prompt **and** completion share those 4096 tokens.

This is a real design constraint, not a nuisance:

- A 320-word story is ~430 tokens, so story-level prompts are comfortable.
- **Element extraction is not.** Sending the whole story and asking for eight
  scenes — each with a description, storyboard, image prompt and voiceover
  script — plus a character roster can plausibly exceed the remaining budget,
  and llama.cpp truncates rather than refusing.
- Plan extraction as **per-scene or batched calls**, not one whole-story call,
  and check `usage.total_tokens` against the limit rather than assuming.

Raising it means changing how sd-api spawns llama-server, which is an upstream
change to that repo, not something viceroy can configure.

## F11 — ~~`ref_images` only works on edit models~~ **WRONG — see ADR 0001**

**This finding was incorrect and is retained only so the mistake is not
repeated.** `ref_images` works fine on `flux2-klein-4b`, and character
consistency now uses it. See
[`docs/adr/0001-character-consistency.md`](adr/0001-character-consistency.md).

What it originally claimed: that `-r` is an edit-model feature, that sd-api's
catalog flags edit models with `edit: true`, and that since every installed
bundle reports `edit: false`, references were unavailable.

Why it was wrong, in two parts:

1. **sd-api never enforces the `edit` flag.** `src/sd/args.ts` does
   `for (const ref of images?.refs ?? []) args.push('-r', ref)` — unconditional,
   on any model. `edit` is catalog metadata for the web UI.
2. **FLUX.2 supports reference images.** stable-diffusion.cpp's
   `docs/flux2.md` documents `-r` workflows for FLUX.2 dev and both klein
   variants. The `sd-cli --help` line calling `-r` "reference image for Flux
   Kontext or MiniMax-H3 Ref2VA" is out of date, and was the source of the
   error.

Measured after correcting it: a reference portrait plus a prompt for an
entirely different setting returns the same recognisable person — and costs
about **+11 s per frame** (76 s vs ~65 s).

**The transferable lesson:** this was inferred from a metadata flag and a help
string, and not one command was run to check. Both sources were stale. A
capability question that can be settled by one generation should be settled by
one generation.

## F12 — image generation timings, measured (M0 step 3)

One 432×768 frame, CPU, cold:

| Bundle | Time | Notes |
| ------ | ---- | ----- |
| **flux2-klein-4b** | **51 s** | 4 steps at cfg 1 (its manifest defaults). The pick — faster *and* a generation newer than SSD-1B. |
| ssd-1b | 55 s | Distilled SDXL, sd-api's default step count |
| ernie-image-turbo | — | **Broken bundle:** `Model "ernie-image-turbo" has no checkpoint file in checkpoint/`. Its `model.json` names `ernie-image-turbo-Q8_0.gguf`, which is not there. |
| flux2-klein-9b | not measured | 9B; slower than the 4B for no benefit at this frame size |

At ~51 s a frame, an 8-scene video spends roughly **7 minutes** in image
generation, which dominates everything else in the pipeline and is the number
to optimise if M1 feels slow.

FLUX.2 klein is distilled to 4 steps at cfg 1. Raising either costs time
without improving the image.

## F13 — the dev server keeps an open handle to a deleted database

`getDb()` caches one better-sqlite3 connection per process. Deleting
`data/viceroy.db` while `next dev` is running leaves that connection pointing
at the unlinked inode: the server keeps answering, reads succeed against a file
nothing else can see, and every project 404s because the *new* database it was
reseeded into is a different file.

Nothing errors. It looks like the seed failed or the routing broke.

**Restart the dev server after any `rm -rf data`.** The worker is immune by
accident — it is restarted per run — and this only bites the long-lived Next
process.

## F14 — a name in an image prompt gets painted into the picture

FLUX.2 renders text well, which is a problem when the text was never meant to
be text. A scene prompt reading `Hal Griffin packing bag` produced a frame with
a holdall stencilled **"HAL GRIFFIN"** across it. The image style's negative
prompt already said `text, watermark`; the name in the positive prompt won.

Scene prompts must describe people by appearance and never by name. The names
belong in the extraction's `characters` array, which is what resolves them to
reference portraits.

## F15 — a diffusion prompt has no "not"

Narrative-style visual guidance for the crime type ended with *"No stylisation,
no fantasy elements."* The scene-visualisation model copied it into a generated
prompt as `no stylisation, fantasy elements` — which, in a positive prompt,
asks for fantasy elements.

Anything destined for a positive prompt states only what **is** in frame.
Exclusions go in the image style's `negativePrompt`, which is passed
separately and does support them. `lib/db/seed.test.ts` guards the built-in
styles against negations, since this leaked from seed data rather than from
model behaviour.

## F16 — the second reference image is weaker than the first

With two characters in one frame and `increase_ref_index: true`, FLUX.2 klein
**does keep them as two separate people** — no blending, which was the open
question in ADR 0001. But the two references are not equally strong.

Across two frames sharing the same reference pair, the first reference (Hal)
transferred faithfully every time — build, hair, uniform all matching his
portrait. The second (Martha) did not: she appeared as a man in one frame,
matching her portrait, and as a woman in the other, matching the *name* in the
prompt text rather than the portrait.

That confound — a wrong-gender portrait fighting a gendered first name — makes
this one run weak evidence about ordering specifically. What it does establish
is that multi-reference frames are **not** as reliable as single-reference
ones, and that the text can override the second reference. Worth a controlled
re-test once portraits are correct: same scene, references swapped.

## F17 — `pkill -f "tsx worker/index.ts"` matches nothing

The worker's actual command line is

```
node .../tsx/dist/cli.mjs worker/index.ts
```

so a pattern containing `tsx worker/index.ts` never matches, `pkill` exits
quietly, and the "restart" **adds** a worker instead of replacing one. Five
accumulated before it was noticed, and a stale one holding pre-PR4 code won the
race for a job and failed it three times with "No handler registered".

Kill on `worker/index.ts` alone.

The queue itself came out of this well: with five workers contending, no job
was ever claimed twice — the transactional claim does what it says. The bug was
entirely stale code winning a race it should not have been in.

## F18 — TTS runs at ~1.1s per word, and sd-api's 300s guard wedges the model

`qwen3-tts-voicedesign` on this machine, measured through the task runner:

| Words | Generation | Audio out | Implied delivery |
| ----- | ---------- | --------- | ---------------- |
| 15 | 20 s | 7.8 s | 116 wpm |
| 40 | 50 s | 24.8 s | 97 wpm |
| 60 | 76 s | 34.7 s | 104 wpm |
| 80 | 57–83 s | 27.0–37.4 s | 128–178 wpm |
| 120 | 131 s | 62.0 s | 116 wpm |

**Generation costs roughly 1.0–1.3 s per word** — about twice real time — and
scales linearly. A 328-word story therefore needs ~350–430 s.

sd-api caps audio inference at `busy_timeout_ms`, default **300000**. Past
that it returns

```
model 'qwen3-tts-voicedesign' is busy: current inference has run 349392 ms
(busy_timeout_ms=300000); the previous request has likely wedged and cannot
be cancelled
```

and it means it: the model stayed blocked, rejecting every subsequent request
with 503, until sd-api was restarted. The narration was never going to arrive.

**Fix:** `SD_AUDIO_REQUEST_TIMEOUT_MS=900000` in sd-api's `.env` (a value of 0
disables the guard entirely, which is worse — a genuinely stuck inference
would then block forever). This preserves the one-shot narration the
requirements call for. Budget ~6 minutes of narration on top of ~9 minutes of
images for a 330-word video.

**Also note the variance.** The same 80-word input produced 27.0 s of audio on
one run and 37.4 s on another — 178 wpm against 128 wpm. Duration is a noisy
signal at this scale, which is finding F6 restated: judge audio acoustically,
not by length. The `assertPlausibleDuration` guard in `voiceover.ts` is
deliberately banded 60–260 wpm so this variance does not trip it, while real
truncation still does.

## F19 — Node's `fetch` gives up after 300 s, and blames the server

**This is the one that cost the most time, and it was entirely client-side.**

Node's global `fetch` (undici) defaults `headersTimeout` and `bodyTimeout` to
**300000 ms**. Any inference that takes longer than five minutes to produce
response headers is abandoned by the client with a bare `fetch failed`.

What makes it genuinely deceptive is the second-order effect. The client gives
up; **sd-api keeps generating**. The retry then arrives while the first
request is still running and is rejected with

```
model 'qwen3-tts-voicedesign' is busy ... the previous request has likely
wedged and cannot be cancelled
```

so every symptom points at the server: a wedged model, a busy engine, an
unreachable audio backend. Raising sd-api's own `busy_timeout_ms` (F18) was
necessary and changed nothing on its own, because the client was still quitting
first.

**The tell was in the timings, not the errors.** Four separate attempts across
two sd-api configurations failed at **301 s, 301 s, 301 s and 301 s**. Nothing
under memory pressure fails on a stopwatch. A concurrent 5 GB LM Studio process
and near-full swap made a plausible-looking culprit, and it was a coincidence —
the constant was the giveaway.

Fixed by giving `SdApiHttp` an undici `Agent` with `headersTimeout`,
`bodyTimeout` and `keepAliveMaxTimeout` set from `SD_API_TIMEOUT_MS`
(default 30 minutes). `keepAliveTimeout` matters too: a long generation is idle
on the wire while the model works, and the connection is otherwise reaped as
stale mid-inference.

`SdApiHttp.request` now also unwraps `error.cause`, so a transport failure
reports `UND_ERR_HEADERS_TIMEOUT` instead of `fetch failed`. That one line
would have made this a five-minute diagnosis.

**Rule of thumb:** any sd-api call that can exceed five minutes — one-shot
narration, a large image batch, a video model — needs this dispatcher. It is
set once on the client, so new call sites inherit it.

## F20 — sd-api's own proxy had the same 300 s cap, making F18's fix unreachable

F19 fixed viceroy's client. It changed nothing, because sd-api's proxy to its
engines used bare global `fetch` too — same undici default, same 300 s, one
layer further in.

The consequence is worth stating plainly: **`audio_request_timeout_ms` was
settable to any value but could never take effect above 300000.** The engine
kept generating and the proxy had already given up, so raising it to 900000
(F18) was correct and inert. The symptom was a 502
`AUDIO_SERVER_UNAVAILABLE` — "could not reach audiocpp_server" — while
audiocpp_server was alive and working.

Four call sites were affected: three in `src/routes/audio.ts` and one in
`src/routes/llm.ts`. The LLM one had never fired only because no completion
had yet run past five minutes.

**Patched in sd-api** (`~/projects/sd-api`), with the user's agreement:

- `src/util/upstream-fetch.ts` — undici `fetch` with an `Agent` cached per
  timeout, so pooling survives.
- Each proxy now bounded by its engine's own guard: `audioRequestTimeoutMs`,
  and a new `llmRequestTimeoutMs` following the existing config convention
  (zod schema, `config/default.json`, `SD_LLM_REQUEST_TIMEOUT_MS`).
- `undici` added as a dependency; `test/upstream-fetch.test.ts` pins the
  behaviour at millisecond scale.

All 210 existing sd-api tests still pass.

**The general lesson.** This default sits at *every* Node hop, and it fails in
the most misleading way available: the caller reports the callee unreachable
while the callee is working normally. When a long inference fails, check each
hop between the model and the caller — and check the elapsed time first. Four
consecutive failures at 301 s were the entire diagnosis; the error messages
pointed at memory, at the engine, and at the model, and were wrong every time.

## F21 — TypeScript 7 breaks Remotion's bundler

`@remotion/bundler` 4.0.508 reads the project's tsconfig through the
TypeScript 5 API:

```js
const tsConfig = typescript.readConfigFile(tsConfigPath, typescript.sys.readFile);
```

TypeScript **7.0.2** — the native port, which `pnpm add -D typescript`
installs by default now — exports neither:

```
typescript version: 7.0.2   has sys: undefined   has readConfigFile: undefined
```

so bundling dies with `TypeError: Cannot read properties of undefined
(reading 'readFile')` after the 93 MB Chrome download, several minutes into
the stage.

**Viceroy pins `typescript@^5.9`.** Nothing here needs TypeScript 7, and the
whole project typechecks unchanged on 5.9.3. Revisit only when Remotion
supports the new API.

Worth knowing generally: this is the second time a default that arrived
*silently* with a fresh install has cost time (Node's 300 s fetch was the
first). When a toolchain package spans the ecosystem, pin it rather than
taking whatever `add` resolves to.

## F22 — a Remotion composition's zod schema does not fill defaults into `inputProps`

The `schema` passed to `<Composition>` documents and validates props for the
Studio, and it is easy to assume `renderMedia` parses `inputProps` through it
too. It does not.

Handing over `captionStyle: {}` therefore reached the component as `undefined`
for every field, and **nothing threw**. The video rendered perfectly, with a
16 px serif caption welded to the bottom edge — `fontSize` undefined fell back
to the browser default, `WebkitTextStroke` became the string
`"undefinedpx undefined"` and was discarded, and
`paddingBottom: height * undefined` was `NaN` and ignored, so the text sat
flush against the frame edge instead of 17% up.

Cost: a full 8-minute render to discover, because the failure is only visible
in the output.

**Materialise defaults before handing props over** —
`captionStyleSchema.parse(value)` in the render stage — and keep a test that
every field is defined after parsing `{}`, so a field added to the schema
later without a default fails loudly instead of silently rendering wrong.

The general shape of this: a prop that is `undefined` in CSS is not an error,
it is a default. Anything driving layout or typography from data needs its
defaults resolved on the way in, not hoped for.

---

## Local environment

| Thing | Value |
| ----- | ----- |
| sd-api | `~/projects/sd-api`, port **3004**, `SD_ACCEL=cpu` |
| Writer LLM | `mistral-nemo-12b` — Mistral Nemo Instruct 2407, Q4_K_M, 7.48 GB |
| Image bundles | `ernie-image-turbo`, `flux2-klein-4b`, `flux2-klein-9b`, `ssd-1b` |
| LLM bundles | `glm-4.6v-flash`, `smolvlm2-2.2b-instruct` (both VLMs — no writer yet) |
| Audio bundles | `parakeet-tdt`, `pocket-tts`, `qwen3-tts`, `qwen3-tts-voicedesign` |

**Unmeasured, and M0 exists to measure them:** per-frame wall-clock at 432×768
on CPU for each image bundle, peak RSS with a writer LLM plus an image model
resident, and Remotion render time for a ~60 s 1080×1920 composition.
