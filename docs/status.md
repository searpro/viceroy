# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-12 — M1 PR4 shipped and verified end to end._

---

## Where things stand

Idea → synopsis → story → evaluation → scenes → cast → images → one-shot
narration → word-timed captions runs end to end against real models. **Only the
video render is left** before M1 is done.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **Complete** — both audio paths confirmed on real audio by PR4 |
| M1 — Thin end-to-end slice (idea → MP4) | **In progress** — PR4 of 5 shipped; only the render remains |
| M2 — Manual mode and review surfaces | Not started |
| M3 — Management screens | Not started |
| M4 — Output control | Not started |
| M5 — Packaging | Not started |

## M0 progress

**Step 1 — sd-api verified.** Running on `:3004`. All routes the plan depends
on are live: `/v1/llm/chat/completions`, `/v1/jobs`, `/v1/audio/tasks/run`,
`/v1/audio/transcriptions`, `/v1/audio-voice-refs`, `/v1/outputs/{name}`.

This took a rebuild to establish, and the failure mode is now recorded as
finding **F8**: the checked-in `dist/` was six weeks older than `src/`, so
every LLM and audio route 404'd on a server that otherwise looked healthy.

sd-api also auto-installed its stable-diffusion.cpp binary on first boot —
`sd-master-bfbef5b-bin-Darwin-macOS-26.5.2-arm64.zip`, a native arm64 build, so
`SD_ACCEL=cpu` here means NEON on the M4's own cores rather than anything
emulated.

**Step 2 — writer LLM chosen and downloading.** `mistral-nemo-12b`
(Mistral Nemo Instruct 2407, Q4_K_M, 7.48 GB, bartowski GGUF). Picked for
prose quality and a 128K context at half the RAM of the MoE alternatives,
accepting that a dense 12B on CPU generates more slowly than a 3–4B-active MoE
would. If tokens/sec proves to be the pipeline's bottleneck rather than image
generation, the ARM-repacked `Q4_0_4_8` / `Q4_0_8_8` variants of the same model
are the first thing to try.

## M1 PR1 — foundation (shipped)

| Piece | Where | Notes |
| ----- | ----- | ----- |
| Config | `lib/config.ts` | Enforces F4 (multiples of 16) and that the source frame's ratio matches the video's, at startup rather than at render time |
| Schema | `lib/db/schema.ts` | 16 tables, migration `0000_chunky_white_tiger.sql` |
| Queue | `lib/queue/index.ts` | Transactional claim, exponential backoff, abort, retry, delete, stale reclaim |
| sd-api client | `lib/sdapi/` | `llm`, `image`, `audio` — F1/F2/F3/F4 encoded in the code, with tests naming the findings |
| Worker | `worker/index.ts` | Poll loop, concurrency 1, graceful shutdown |
| App shell | `app/page.tsx` | System status page; replaced by the idea-entry screen in PR2 |

**Verified, not just typechecked:** 64 tests pass, `tsc --noEmit` is clean,
migrations apply to a real file in WAL mode, `next build` succeeds, and the
page renders with sd-api reachable. The queue was exercised against the real
worker — an enqueued `synopsis` job was claimed, failed, backed off 5s, retried
once, and gave up at its attempt limit, writing all four log lines.

Decisions that changed during the work:

- **Node 25, not 22.** Neither 22 nor 24 is installed (Homebrew's `node@24` is
  a symlink relinked to 25.7.0), and `better-sqlite3` 13.0.3 builds and runs
  clean on 25. Verified before committing to it.
- **Poll, don't stream, for image jobs.** `/v1/jobs/:id/stream` exists, but a
  poll every 2s against a job measured in minutes on CPU costs nothing and
  gives abort a natural checkpoint. An SSE reader would need unwinding
  separately to get the same property.

## M1 PR2 — story generation (shipped)

| Piece | Where |
| ----- | ----- |
| Prompt library + `{{var}}` rendering | `lib/prompts/` |
| Seed: 3 narrative, 3 voice, 2 image styles, 4 providers | `lib/db/seed.ts` |
| Stages 1–3 + revision loop | `lib/pipeline/story.ts` |
| Project service | `lib/projects.ts` |
| API: projects, project detail, job abort/retry/delete | `app/api/` |
| UI: idea entry, project view with live polling | `app/page.tsx`, `app/projects/[id]/` |

**Verified against a live model.** With the LLM provider temporarily pointed at
`smolvlm2-2.2b-instruct`, a project created through the UI ran
synopsis → story → evaluation on the real worker. The synopsis and story were
written and stored; the evaluation failed three times and gave up, because a
2.2B model cannot hold a five-key checklist vocabulary. That is the guard
working, not a bug — and it is direct evidence for risk R1.

Decisions and fixes from that run:

- **The evaluator is held to its style's own checklist keys.** A response
  naming none of them fails the stage rather than being recorded as a judgement
  of something else.
- **Scores beat the stated verdict.** Models say `"pass"` while scoring a
  dimension at 2; the checklist is the contract, so any dimension at ≤2 forces
  a revision.
- **A job that exhausts its retries now parks its project for review** with the
  reason. Before this the project kept its old stage and looked like it was
  still working.
- **No shadcn/ui yet.** PR2's surface is a form, a list and a detail view;
  hand-rolled Tailwind covers it. It earns its place in M3, where the
  management screens need real primitives.

## M1 PR3 — scenes, cast and images (shipped)

| Piece | Where |
| ----- | ----- |
| Sentence splitting + span repair | `lib/pipeline/segment.ts` |
| Stage 4 — cast, scene split, per-scene visualisation | `lib/pipeline/elements.ts` |
| Stages 5–6 — portraits, scene images | `lib/pipeline/images.ts` |
| Asset storage | `lib/assets.ts` |
| Asset serving, scene grid, cast panel | `app/api/assets/`, `app/projects/[id]/` |

Three decisions worth not re-deriving:

- **Scenes carry verbatim spans of the narration, not separately written
  text.** The voiceover is generated once from the whole story, so
  concatenating the scene scripts has to reproduce it exactly. Asking the model
  to copy text out invites paraphrase, so it is asked for sentence *indices*
  instead — which also costs a handful of tokens rather than a second copy of
  the story, and that matters under F10's ceiling.
- **The model's grouping is repaired, not trusted.** `normaliseSpans` forces a
  covering partition: a gap silently drops narration out of the video and an
  overlap plays the same words under two images. It fails only when there is
  nothing usable to repair.
- **Extraction runs in three passes and is resumable.** One whole-story call
  asking for eight fully-specified scenes exceeds the 4096-token context and
  truncates silently. Rows are written as they are known, so a failure at scene
  six resumes instead of restarting — worth minutes on this hardware.

**Character consistency uses reference images** —
[ADR 0001](adr/0001-character-consistency.md). PR3 originally shipped a
textual-only approach on the belief that `ref_images` needed an edit model;
that belief was wrong, and finding F11 records the error. Portraits are now
generated before scenes and passed as `ref_images`, which is what the plan
called for all along. The `appearanceTag` remains as the fallback.

### Verified end to end on real models

One idea — "a man stole one hundred million dollars from a community" — run in
full auto with Mistral Nemo writing and flux2-klein-4b illustrating. Every job
succeeded on its **first attempt**, no retries:

| Stage | Result |
| ----- | ------ |
| synopsis → story | 1987 savings-and-loan embezzlement, named characters, dated beats |
| story_eval | pass, 4.8/5, all five checklist keys returned — but see the leniency note below |
| elements | 2 characters with appearance tags, 7 scenes |
| scene_images | 7/7 frames, ~65 s each, ~8 min total |

**Wall clock: about 12 minutes** from idea to seven finished frames, and image
generation is ~65% of it.

Two things worth knowing that only a real run could show:

- **The verbatim-span invariant holds in practice.** The seven scene scripts
  concatenated back to the narration exactly, which is what PR4's one-shot
  voiceover depends on.
- **Textual character consistency worked better than expected but not
  exactly.** The same man was recognisably the same across all seven frames —
  sandy hair parted the same way, the same wire glasses, the same grey
  button-down — with no reference image involved. Recognisably similar people,
  though, rather than the same person, which is what prompted ADR 0001 and the
  switch to reference images.

The chain is now `elements → character_images → scene_images`, and the timings
above predate that: expect roughly **+3 minutes** for a 7-scene, 2-character
video (one extra generation per character, ~+11 s per frame).

### The evaluator is probably lenient — do not read a pass as quality

On the first Mistral Nemo run the story passed at a mean of 4.8/5 with no
issues, and the per-dimension comments echoed the checklist descriptions almost
word for word ("The prose never editorializes or reaches for shock" against a
checklist reading "The prose never editorialises or reaches for shock").

That is a model agreeing with a prompt, not a model judging a story. It means
the QC loop currently almost never fires, so its threshold logic is largely
untested against real disagreement, and a "pass" is weak evidence.

This is exactly the calibration problem story-platform's Phase 4 was blocked
on, and it is worth doing properly once there are stories a human has actually
accepted and rejected: run the evaluator repeatedly over identical input to see
whether its issue set is even stable, then check whether what it flags
correlates with what gets rejected. `evaluations` records the model and the
per-dimension scores specifically so that can be measured later.

Cheap thing to try first: have the evaluator quote the phrase it is judging
before scoring it, which makes echoing the checklist harder than engaging with
the text.

## M0 — environment gate (complete)

Steps 3 and 4 both landed. Timings are in finding F12; the headline is
**flux2-klein-4b at 51 s per 432×768 frame**, which beat `ssd-1b` on speed
*and* quality, so it replaced it as the seeded default. `ernie-image-turbo`
turned out to be a broken bundle.

Mistral Nemo (Q4_K_M, 7.48 GB) finished downloading and sd-api serves it.
Remaining from step 4 is the acoustic confirmation of the two audio paths,
which PR4 does as its first act since it is building on them.

## Operational requirements

**sd-api needs `SD_AUDIO_REQUEST_TIMEOUT_MS=900000` in its `.env`.** The
default 300 s cap is shorter than a one-shot narration of a full story, and
exceeding it does not fail cleanly — it wedges the TTS model uncancellably
until sd-api is restarted. See finding F18 for the measurements behind the
number. This is a requirement of running viceroy, not a preference.

## M1 PR4 — narration and captions (shipped)

| Piece | Where |
| ----- | ----- |
| Number expansion for matching | `lib/pipeline/numbers.ts` |
| ASR-to-authored alignment | `lib/pipeline/align.ts` |
| Stages 7–8 | `lib/pipeline/voiceover.ts` |
| Narration player, cue list, voice redirection | `app/projects/[id]/` |

### Verified on real audio

328-word narration, `qwen3-tts-voicedesign` through the task runner, aligned
against `parakeet-tdt`. Both stages succeeded on their first attempt:

| Measure | Result |
| ------- | ------ |
| Audio | 178.96 s, 24 kHz mono, 8.2 MB (ffprobe-confirmed) |
| Delivery | 110 wpm — inside the plausibility guard |
| Cues | 90, spanning 0.16 s → 178.88 s |
| Anchored to real ASR words | 89 / 90 |
| Caption text vs authored narration | **identical, all 328 words** |
| Scene timeline | 8 scenes tiling 0.2 s → 178.9 s with no gaps or overlaps |

**F5 is fixed, and the transcript shows exactly why it mattered.** 8 of 90 cues
differ from what ASR heard, and in every case the authored text is the correct
one:

| Caption shows | ASR heard |
| ------------- | --------- |
| `holding one hundred and four` | `holding104` |
| `2015,` | `October12,2015,` |
| `at 9:01 AM,` | `at9.01` |
| `largest heist in U.S.` | `largest in U.S.` (dropped a word) |
| `Henry freeze-frames, his` | `Henry frames, his` |

The first of those is the POC's exact failure — it shipped `Right at317,` over
an authored "Right at three seventeen." Here the timing comes from the
transcript and the wording from the writer, which is the whole point.

## Known gaps

- **Editing a built-in prompt template has no upgrade path.** `seed()` uses
  `onConflictDoNothing`, deliberately, so a re-seed never clobbers a template
  someone has tuned. The cost is that improving a *built-in* template does not
  reach an existing database — during development the fix is to wipe `data/`
  and re-seed, which is not a fix for a real install. M3's prompt-template
  editor needs a "reset this template to the built-in" action, and probably a
  record of whether a row has been edited at all.

## What to pick up next

**M1 PR5 — the Remotion render.** Images + narration + cues → a 1080×1920 MP4.
That is the last piece of M1, and M1's definition of done is an actual file,
not a passing test.

What it can rely on, all now measured rather than assumed:

- `voiceovers.durationMs` and a 24 kHz mono WAV on disk
- `subtitle_cues` with authored text and start/end in ms, one row per caption
- `scenes.startMs` / `scenes.endMs` tiling the timeline with no gaps
- source frames at 432×768, to be upscaled to 1080×1920 (F4)
- assertions must use `ffprobe`, never file hashes (F7)

Budget for a full run on this hardware, from the two real end-to-end runs:
**~9 min images + ~3 min narration + ~4 min story and extraction ≈ 16 minutes**
for a 330-word, 8-scene video.

## Environment as found (2026-08-11)

| Thing | State |
| ----- | ----- |
| sd-api | `~/projects/sd-api`, `SD_PORT=3004`, `SD_ACCEL=cpu`. Not running. |
| Image bundles | `ernie-image-turbo`, `flux2-klein-4b`, `flux2-klein-9b`, `ssd-1b` |
| LLM bundles | `glm-4.6v-flash`, `smolvlm2-2.2b-instruct` (both VLMs), plus `mistral-nemo-12b` as of M0 step 2 |
| Audio bundles | `parakeet-tdt` (ASR), `pocket-tts`, `qwen3-tts`, `qwen3-tts-voicedesign` |
| Toolchain | Node 25.7.0, pnpm 10.18.0, Docker 29.1.3. Node 20.20.2 also present; 22 and 24 are not |
| POC | `~/projects/story-platform`, last commit `8ec951d` |

## Decisions taken since the plan

None yet.

## Drift

No drift. There are no commits to compare against.
