# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-11 — repository initialised._

---

## Where things stand

Day 0. The repository contains planning documents and nothing else — no
application code, no schema, no dependencies installed.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **Not started** — blocking M1 |
| M1 — Thin end-to-end slice (idea → MP4) | Not started |
| M2 — Manual mode and review surfaces | Not started |
| M3 — Management screens | Not started |
| M4 — Output control | Not started |
| M5 — Packaging | Not started |

## What to pick up next

**M0, step 2** is the one that gates everything else: there is no story-grade
LLM installed on this machine. `~/projects/sd-api/data/llm-models` holds
`glm-4.6v-flash` and `smolvlm2-2.2b-instruct`, both vision models, the second
2.2B. Decision D3 rules out cloud LLMs, so M1's output quality depends on
pulling a usable writer from `GET /v1/llm-catalog` first.

The rest of M0 is measurement: image-model wall-clock at 432×768 on CPU, and
confirming the two audio paths behave as `docs/findings.md` says they do.

## Environment as found (2026-08-11)

| Thing | State |
| ----- | ----- |
| sd-api | `~/projects/sd-api`, `SD_PORT=3004`, `SD_ACCEL=cpu`. Not running. |
| Image bundles | `ernie-image-turbo`, `flux2-klein-4b`, `flux2-klein-9b`, `ssd-1b` |
| LLM bundles | `glm-4.6v-flash`, `smolvlm2-2.2b-instruct` — see above |
| Audio bundles | `parakeet-tdt` (ASR), `pocket-tts`, `qwen3-tts`, `qwen3-tts-voicedesign` |
| Toolchain | Node 25.7.0 on PATH (plan pins 22 LTS), pnpm 10.18.0, Docker 29.1.3 |
| POC | `~/projects/story-platform`, last commit `8ec951d` |

## Decisions taken since the plan

None yet.

## Drift

No drift. There are no commits to compare against.
