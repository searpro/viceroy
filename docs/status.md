# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-11 — M0 in progress._

---

## Where things stand

The repository contains planning documents and nothing else — no application
code, no schema, no dependencies installed. Work so far has been on M0, the
environment gate.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **In progress** — steps 1–2 done, 3–4 outstanding |
| M1 — Thin end-to-end slice (idea → MP4) | Not started |
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
| Toolchain | Node 25.7.0 on PATH (plan pins 22 LTS), pnpm 10.18.0, Docker 29.1.3 |
| POC | `~/projects/story-platform`, last commit `8ec951d` |

## Decisions taken since the plan

None yet.

## Drift

No drift. There are no commits to compare against.
