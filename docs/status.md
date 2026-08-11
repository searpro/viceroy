# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-11 — M1 PR1 shipped._

---

## Where things stand

The foundation is in and verified: config, schema, migrations, job queue and
the sd-api client. There is no pipeline yet — every job type fails with "no
handler registered" by design, so an enqueued job says so rather than silently
succeeding and advancing the stage.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **In progress** — steps 1–2 done, 3–4 outstanding |
| M1 — Thin end-to-end slice (idea → MP4) | **In progress** — PR1 of 5 shipped |
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

## What to pick up next

**M0, steps 3 and 4** — both are measurement, and both need the download
finished first:

3. Wall-clock one 432×768 frame on each installed image bundle
   (`ernie-image-turbo`, `flux2-klein-4b`, `flux2-klein-9b`, `ssd-1b`) on CPU.
   At ~8 frames per video a turbo model may be the only viable pick.
4. Confirm `qwen3-tts-voicedesign` through the task runner (finding F2) and
   `parakeet-tdt` with `words_out` (F3) — plus a first tokens/sec reading for
   Mistral Nemo.

Then M1 PR1: scaffold, schema, queue, sd-api client.

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
