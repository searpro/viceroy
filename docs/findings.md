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
