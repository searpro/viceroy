# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-11 — M1 PR2 shipped._

---

## Where things stand

Idea → synopsis → story → evaluation runs end to end, in the browser, against
a real model. Images, voiceover, captions and render are not built yet.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **Complete** except the audio-path confirmation, which PR4 does as it builds on it |
| M1 — Thin end-to-end slice (idea → MP4) | **In progress** — PR3 of 5 shipped |
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

**Character consistency is textual, not `ref_images`** — see finding F11. That
was a plan assumption that turned out to be wrong: `ref_images` needs an edit
model and none is installed.

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
- **Textual character consistency works better than expected.** The same man is
  recognisably the same across all seven frames — sandy hair parted the same
  way, the same wire glasses, the same grey button-down — with no reference
  image involved. Good enough that installing an edit model is an improvement
  to want, not a gap to fill.

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

## What to pick up next

**M1 PR4** — the one-shot voiceover and subtitle alignment. This is the part
the POC never got working, so read findings **F1, F2, F3, F5 and F6** before
writing any of it. Specifically:

- speech through `POST /v1/audio/tasks/run` only, never `/v1/audio/speech`
- ASR offsets divided by `ASR_SAMPLE_RATE`, with the drift guard
- align ASR words *against* the authored text and keep the authored wording —
  F5 is the one the POC left unfixed, and it is a stage-8 requirement here
- verify acoustically (median F0), never by file size

**Numbers are the hard part of that alignment, and there is a real tension in
it.** `story.write` asks for numbers written as spoken words, because that is
what makes TTS pronounce them correctly. But ASR normalises spoken numbers
*back* to digits, so the authored "nineteen eighty-seven" meets a transcript
saying "1987" and a naive word-by-word match fails exactly there.

Observed on the first Nemo run: the narration came back with `1987`, `$50,000`
and `1992` as digits, so the instruction is only partly obeyed today. Both
forms will occur in practice. The alignment therefore has to match words to
digits rather than assume either form — do not "fix" this by dropping the
spoken-words instruction, which would trade a solvable alignment problem for an
unsolvable pronunciation one.

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
