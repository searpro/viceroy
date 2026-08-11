# Viceroy — Build Plan

Story-to-video generator. A trimmed rewrite of
[`story-platform`](https://github.com/searpro/story-platform), using
[`sd-api`](https://github.com/searpro/sd-api) as the inference backend for
everything: LLM, image, TTS, ASR.

This document is the durable plan. `docs/status.md` records what has actually
shipped. `docs/findings.md` records measured facts about the local stack that
are expensive to rediscover.

---

## 1. Decisions taken

Recorded here so they are not re-litigated later.

| # | Decision | Rationale |
| - | -------- | --------- |
| D1 | **Milestone 1 is a thin end-to-end slice**, not a foundation | The POC reached scene generation and stalled at subtitle alignment / render. Proving idea → MP4 first means the riskiest integration is de-risked while the codebase is still small enough to reshape. Management screens are configuration over a pipeline that works. |
| D2 | **Port prompts and pipeline logic; rewrite the structure** | The hard-won parts of the POC are its prompt templates, narrative-style modelling, scene/character extraction and voice-design cues. Its monorepo, Postgres, pg-boss and four-app split are cost, not value, for a single-user app. |
| D3 | **LLM is sd-api-local only** | Zero API cost and fully offline. Accepted trade-off: story quality is bounded by what a <30B GGUF produces on a 24 GB M4 Air. See Risk R1 — the provider layer stays pluggable so a cloud provider is a config change, not a refactor. |
| D4 | **Single Next.js app + a separate worker process, one repo, no monorepo tooling** | Remotion renders drive headless Chromium and image jobs are minutes long on CPU; neither belongs in the request path of the Next server. Two processes over one SQLite file is the smallest thing that works. |
| D5 | **SQLite is the queue** | One machine, one user, jobs measured in minutes. A `jobs` table with a transactional claim gives status, logs, retry, abort and delete — the stated requirement — with no broker to operate. |
| D6 | **Voiceover is generated in one shot for the whole story** | Stated requirement, and the reason the scene scripts are concatenated before TTS rather than after: per-scene TTS produces audible voice drift between scenes. Subtitle alignment is what maps the single track back onto scenes. |
| D7 | **Captions are rendered by Remotion, not burned in by libass** | Stated requirement, and it makes caption style a data-driven, previewable thing rather than an ASS-format string. Remotion's licence is free for individual use. |

Decisions taken *during* the build, where the reasoning is longer than a table
row, live as ADRs in [`docs/adr/`](adr/):

- [0001 — Character consistency uses reference images](adr/0001-character-consistency.md)
  — confirms stage 5's original design after PR3 briefly abandoned it on a
  wrong premise.

## 2. Stack

- **Next.js 15** (App Router) + TypeScript strict
- **SQLite** via `better-sqlite3`, **Drizzle ORM** + `drizzle-kit` migrations
- **shadcn/ui** + Tailwind
- **Remotion** (`@remotion/renderer`, `@remotion/captions`) for the video
- **Vitest** for unit/integration, **Playwright** for one golden-path E2E
- **pnpm**, Node 25 pinned in `.nvmrc`

The intent was to pin Node 22 LTS, on the theory that `better-sqlite3`
prebuilds lag new majors. Neither 22 nor 24 is actually installed — Homebrew's
`node@24` is a symlink that has been relinked to 25.7.0 — and `better-sqlite3`
13.0.3 compiles and runs clean on 25, verified before committing to it. So 25
it is, and no system change was needed.

The one known Node 25 hazard is the global `localStorage` shim that broke
story-platform's jsdom tests. Viceroy's tests are node-environment; when
component tests arrive, reach for happy-dom rather than jsdom.

## 3. Repo layout

```
app/                 Next.js App Router — screens + route handlers
  (studio)/          project workspace
  api/               route handlers (thin; call into lib/)
components/ui/       shadcn primitives
lib/
  db/                drizzle schema, client, seed
  sdapi/             sd-api client: llm, image, speech, asr, jobs
  pipeline/          one module per stage, worker-callable, provider-injected
  prompts/           template registry, {{var}} rendering, seeded defaults
  queue/             claim / complete / fail / retry / abort
worker/
  index.ts           poll loop
  handlers/          one per job type
remotion/            compositions: video, caption styles
drizzle/             generated migrations (append-only once landed)
docs/                PLAN.md, status.md, findings.md
data/                sqlite db, outputs, cache (gitignored)
```

## 4. Data model

Grouped by concern; every table has `id`, `created_at`, `updated_at`.

**Styles (user-managed, LLM-authorable)**
- `narrative_styles` — name, description, planner guidance, writing guidance,
  visual guidance, evaluation checklist (closed vocabulary, per type), pacing
- `voice_styles` — name, description, `tts_instruct` (the voice-design string
  sent to the model), delivery cues used by the writer
- `image_styles` — name, description, prompt prefix/suffix, negative prompt,
  model bundle + default params

**Project**
- `projects` — idea, synopsis, story, status, mode (`auto` | `manual`),
  narrative/voice/image style refs, target resolution
- `scenes` — project, index, description, storyboard, image_prompt,
  voiceover_script, voice_cues, image_asset, approved_at
- `characters` — project, name, description, image_prompt, image_asset
- `evaluations` — project, iteration, verdict, dimension scores, issues
- `voiceovers` — project, resolved script, audio_asset, duration_ms
- `subtitle_cues` — project, scene, word, text, start_ms, end_ms
- `renders` — project, resolution, caption_style, asset, status
- `assets` — kind, path, mime, bytes, meta

**System**
- `jobs` — type, project, payload, status, progress, attempts, error, log lines,
  timestamps
- `providers` — kind (`llm` | `image` | `audio` | `asr`), base_url, api_key,
  model, default_params, is_default
- `prompt_templates` — key, section, template, description, variable hints
- `preferences` — key/value

## 5. Pipeline

Each stage is a job type. Stages are resumable and individually re-runnable —
that is what makes manual mode (M2) a UI over the same machinery as auto mode.

| # | Stage | In → Out |
| - | ----- | -------- |
| 1 | `synopsis` | idea → synopsis |
| 2 | `story` | synopsis + narrative style → full story |
| 3 | `story_eval` | story → verdict + issues; loops to `story_revise` until pass or QC threshold |
| 4 | `elements` | story → scenes (description, storyboard, image prompt, voiceover script + voice cues) and characters (description, image prompt) |
| 5 | `character_images` | character prompts → portraits (generated **first**, used as `ref_images` so scene images stay character-consistent) |
| 6 | `scene_images` | scene image prompt + character refs + image style → 9:16 frame |
| 7 | `voiceover` | **all** scene scripts concatenated → one TTS call → one audio track |
| 8 | `subtitle_align` | audio + written text → word-timed cues mapped back to scenes |
| 9 | `render` | images + audio + cues + caption style → MP4 |

In auto mode the chain advances itself and notifies on completion or on
hitting a threshold. In manual mode each stage stops for review.

## 6. sd-api integration

Base URL `http://localhost:3004` (`SD_PORT=3004` in `~/projects/sd-api/.env`).

| Need | Endpoint |
| ---- | -------- |
| LLM | `POST /v1/llm/chat/completions` (OpenAI-shaped, streaming supported) |
| Image | `POST /v1/jobs` + `GET /v1/jobs/:id/stream` (SSE progress) |
| Image fetch | `GET /v1/outputs/:name` |
| TTS | `POST /v1/audio/tasks/run` — **not** `/v1/audio/speech`, see F2 |
| ASR | `POST /v1/audio/transcriptions` with `words_out` |
| Upload for ASR | `POST /v1/audio-voice-refs` → returns a server-local absolute path |

### Findings inherited from the POC — do not rediscover these

These cost real debugging time in story-platform. They are copied into
`docs/findings.md` as the authority; summarised here because they shape the
design rather than just the implementation.

- **F1 — ASR word offsets are in the model's sample rate (16 kHz), not the
  file's.** parakeet-tdt resamples internally. Dividing by the WAV header's
  rate — the obvious move — compresses every caption to ~66% of its correct
  time. Own this in one constant with a drift guard that fails the alignment
  rather than shipping desynced subtitles.
- **F2 — sd-api's OpenAI-shaped audio endpoints silently drop advanced
  fields.** `instruct` on `/v1/audio/speech` is accepted, forwarded, ignored,
  and returns a normal-looking response. Measured on `qwen3-tts-voicedesign`:
  via `/audio/speech` a "high-pitched young girl" and a "deep gravelly older
  man" both landed at ~130 Hz median F0; via the task runner, 419 Hz and 88 Hz.
  **All voice design must go through `POST /v1/audio/tasks/run`.** Its field is
  `text` not `input`, its task enum is the short form (`vdes`, `asr`, `clon`),
  and it persists nothing — the caller stores the bytes.
- **F3 — `words_out` needs a server-local path.** A bare output name resolves
  against sd-api's cwd and 404s; the multipart form ignores `words_out`
  entirely. Upload via `/v1/audio-voice-refs` to get an absolute path, then
  transcribe that. Bonus: viceroy never needs to share a filesystem with
  sd-api.
- **F4 — image dimensions must be multiples of 16.** stable-diffusion.cpp
  rounds up silently rather than refusing, so 360 becomes 368 and the frame is
  no longer 9:16. Reject non-conforming sizes at the boundary. Source frames at
  432×768, upscaled by the renderer to 1080×1920; make the source size config,
  because how large a frame a machine can produce is a property of that
  machine.
- **F5 — word-aligned captions display the ASR transcript, not the authored
  text.** parakeet normalises spoken numbers to digits, drops colons and
  straightens apostrophes: an authored "Right at three seventeen." came back as
  "Right at317,". Timing is accurate, wording is not. **Viceroy fixes this
  properly:** align ASR words *against* the written text and keep the written
  wording with the ASR timings. This is a stage-8 requirement, not a later
  polish item.
- **F6 — verify audio changes acoustically, not by file size.** Generation is
  stochastic and clip sizes overlap heavily between conditions. Median F0
  separates them; duration and byte count do not.
- **F7 — encoder output is not byte-reproducible.** Assert on `ffprobe`-probed
  properties, never file hashes.

## 7. Milestones

### M0 — Environment gate (prerequisite, no app code)

Blocking, because M1's validation is "a real MP4 came out".

1. Bring sd-api up on :3004, confirm `/docs` and `/v1/models`.
2. **Pull a writer LLM.** Currently installed are `glm-4.6v-flash` and
   `smolvlm2-2.2b-instruct` — both vision models, and the second is 2.2B.
   Neither is a story writer. Choose from `GET /v1/llm-catalog`.
3. Pick the image bundle. Installed: `ernie-image-turbo`, `flux2-klein-4b`,
   `flux2-klein-9b`, `ssd-1b`. `SD_ACCEL=cpu`, so measure wall-clock for one
   432×768 frame on each before committing — a turbo model may be the only
   viable choice at ~8 frames per video.
4. Confirm `qwen3-tts-voicedesign` through the task runner (F2) and
   `parakeet-tdt` with `words_out` (F3).

**Deliverable:** `docs/findings.md` with measured timings and chosen models.

### M1 — Thin end-to-end slice ← *the current milestone*

Idea → MP4, full auto, seeded defaults, minimal UI. Landed as five commits:

| PR | Contents |
| -- | -------- |
| 1 | Scaffold, Drizzle schema + migrations, job queue with claim/retry/abort, sd-api client with recorded-fixture tests |
| 2 | Stages 1–3 (synopsis, story, eval loop) + seeded prompt templates + one seeded narrative style. UI: enter an idea, watch jobs |
| 3 | Stages 4–6 (elements, character portraits, scene images) + seeded image style |
| 4 | Stages 7–8 (one-shot voiceover, subtitle alignment incl. F5 transcript-to-text alignment) + seeded voice style |
| 5 | Stage 9 Remotion render + result page |

**Validation:** one idea in, one watchable 1080×1920 MP4 out, captions in sync
with the authored wording, on this machine. Not a test-suite claim — an actual
file.

### M2 — Manual mode and review surfaces

Per-stage review/approve UI. The LLM-powered pattern (regenerate, or direct
with a prompt) applied to synopsis, story, scene scripts, image prompts, and
voice cues. Voiceover re-direction by editing voice-design cues.

### M3 — Management screens

Narrative / voice / image style CRUD with LLM authoring. Provider registry
(sd-api and cloud). Preferences. Prompt-template editor, sectioned per
generation task with variable hints.

### M4 — Output control

Caption style customisation with live Remotion preview. Resolution selection.
Job queue screen: status, logs, abort, retry, delete.

### M5 — Packaging

Containerise. Configurable output/cache storage location, S3 optional.

**Beyond M5** the requirements doc's priority list takes over: platform
publishing + analytics, storytelling quality, motion video via WAN/LTX, AI
influencers.

## 8. Risks

| # | Risk | Response |
| - | ---- | -------- |
| R1 | **No story-grade LLM is installed, and D3 rules out cloud.** A 2.2B VLM will not write a usable story, so M1's output quality is gated on M0 step 2. | Provider layer stays pluggable. If local writing quality blocks M1, that is a D3 revisit with measured evidence, not a silent fallback. |
| R2 | **`SD_ACCEL=cpu` on an M4 Air.** stable-diffusion.cpp has no Metal path in the accel list, so every frame is CPU. ~8 frames per video could dominate runtime. | Measure in M0. Favour turbo/small bundles, keep source frames at 432×768 and upscale. |
| R3 | **Memory contention.** A writer LLM, an image model, a TTS model and an ASR model on 24 GB, some resident. | Queue concurrency 1 across sd-api-bound jobs; let sd-api own model lifecycle. |
| R4 | **Caption/audio desync** — the failure the POC shipped. | F1's drift guard plus F5's align-against-authored-text, both covered by tests in M1 PR4. |
| R5 | **Remotion render cost** on the same box that just ran the models. | Render is worker-side and last; measure in M1 PR5. |

## 9. Working agreement

- `PLAN → docs/PLAN.md → EXECUTE → VALIDATE` for every unit of work.
- `docs/status.md` updated as part of the change that ships, not afterwards.
- Session start: diff commit log against `docs/status.md`, report drift.
- TypeScript strict. No `any` without a comment saying why it is unavoidable.
- Comments explain *why*, never *what*.
- Tests never call real models or spend money — pipeline stages take injected
  providers, stubbed in tests, with recorded fixtures for the sd-api client.
- Migrations are append-only once landed.
