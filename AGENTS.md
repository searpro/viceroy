# AGENTS.md

Instructions for any coding agent working in this repo.

## What this is

**Viceroy** — a story-to-video generator. A user gives a one-line idea; the
system writes a synopsis, elaborates it into a story, breaks it into scenes and
characters, generates images and a single continuous voiceover, aligns
word-timed captions, and renders a short-form video.

All inference runs through [`sd-api`](https://github.com/searpro/sd-api) on
`http://localhost:3004` — LLM, image, TTS and ASR alike.

## Read before changing anything

1. [`docs/status.md`](docs/status.md) — **start here.** What is built, what is
   next, what is deliberately absent.
2. [`docs/PLAN.md`](docs/PLAN.md) — decisions, stack, data model, pipeline,
   milestones. These are settled; don't re-derive or re-litigate them.
3. [`docs/findings.md`](docs/findings.md) — measured behaviour of the local
   inference stack that contradicts its own documentation. Read this before
   touching audio, captions or image sizing. It will save you a day.
4. [`docs/adr/`](docs/adr/) — decisions taken during the build whose reasoning
   is worth more than a line.

## Check the capability, don't infer it

Finding F11 is a worked example of getting this wrong: a capability was ruled
out from a metadata flag and a `--help` string, both stale, when a single
generation would have shown it working. sd-api's docs, its catalog flags and
its binary's help text all drift from what the code does. When the question is
"can it do X", run X.

## At session start

Diff the commit log against `docs/status.md` and report any drift to the user.
Development is always agent-driven, so there should never be any.

## Working pattern

`PLAN → docs/PLAN.md → EXECUTE → VALIDATE`, for every unit of work.

`docs/status.md` is updated as part of the change that ships, not afterwards.

## Model usage

Build with Haiku or Sonnet. Use Opus or Fable only when the user explicitly
configures it.

If a skill would help with the task at hand, tell the user it exists and let
them decide whether to install it.

## Code style

- TypeScript strict. No `any` without a comment explaining why it is
  unavoidable.
- Comments explain *why* — a workaround, a hidden constraint. Never *what*.
- Two-space indentation, Prettier-formatted. Don't hand-format.
- Zod schemas are the single source of truth for external shapes; Drizzle
  schema is the single source of truth for the data model.
- Migrations are append-only once landed. Never edit one that has shipped.
- No new dependency unless it earns its place.

## Testing

- Vitest, colocated as `*.test.ts` next to the code under test.
- **Tests never call real models or spend money.** Pipeline stages take
  injected providers; the sd-api client is tested against recorded fixtures.
- Playwright for one golden-path E2E, not exhaustive per-screen coverage.
- Video/audio assertions probe with `ffprobe` — encoder output is not
  byte-reproducible (finding F7).

## The one thing not to get wrong

Caption timing. The POC this replaces shipped desynced subtitles twice, for two
different reasons, both documented as F1 and F5. A render whose captions drift
is worse than one with no captions, because it looks finished.
