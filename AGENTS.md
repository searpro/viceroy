# AGENTS.md

Instructions for any coding agent working in this repo.

## What this is

**Viceroy** — a story-to-video generator. A user gives a one-line idea; the
system writes a synopsis, elaborates it into a story, breaks it into scenes and
characters, generates images and a single continuous voiceover, aligns
word-timed captions, and renders a short-form video.

All inference runs through [`sd-api`](https://github.com/searpro/sd-api) on
`http://localhost:3004` — LLM, image, TTS and ASR alike.

## Source of truth is Notion, not markdown

This file is the one document that stays local — the agent harness reads it
directly, so it has to. Everything else that used to live under `docs/` —
the build plan, milestone status, measured findings, ADRs, and the bug
tracker — now lives in Notion. The map is
[`docs/notion.md`](docs/notion.md); read it first, every session, before
anything else in this list. The files that used to hold this content
(`docs/PLAN.md`, `docs/findings.md`, `docs/status.md`, `docs/bugs.md`,
`docs/adr/*`) are now short stubs pointing at `docs/notion.md`. Don't write
to them — they aren't read back.

This trades something real away: those files used to be instant, offline,
git-diffable reads. They're now a network call away, and git no longer
tracks their history. Budget for that — fetch what you need at the start of
a session rather than assuming it's still in context from last time.

## Read before changing anything

1. [`docs/notion.md`](docs/notion.md) — the map of every Notion page and
   database this project uses, plus what each one is for. Fetch this first.
2. **Current State** (Notion) — what is built, what is next, what is
   deliberately absent. Start here after the map.
3. **Build Plan** (Notion) — decisions, stack, data model, pipeline,
   milestones. These are settled; don't re-derive or re-litigate them.
4. **Findings** (Notion database) — measured behaviour of the local
   inference stack that contradicts its own documentation. Read this before
   touching audio, captions or image sizing. It will save you a day.
5. **Architecture Decisions** (Notion database) — decisions taken during the
   build whose reasoning is worth more than a line.

## Check the capability, don't infer it

Finding F11 is a worked example of getting this wrong: a capability was ruled
out from a metadata flag and a `--help` string, both stale, when a single
generation would have shown it working. sd-api's docs, its catalog flags and
its binary's help text all drift from what the code does. When the question is
"can it do X", run X.

## At session start

Diff the commit log against the **Current State** page in Notion and report
any drift to the user. Development is always agent-driven, so there should
never be any.

Also check `docs/.notion-pending.log` (gitignored). A tracked post-commit
hook (`.githooks/post-commit`, active via `core.hooksPath`) appends every
commit here, since a git hook has no way to call the Notion MCP tools itself
— only an agent session can. If the file exists and isn't empty, invoke the
`log-progress` skill to drain it before starting new work, then clear it. Do
not treat a queued commit as automatically worth its own Notion row — the
skill still exercises judgment about what's a loggable unit (PR/milestone/
bugfix/decision) versus routine commits, per its own instructions.

## Working pattern

`PLAN → Build Plan (Notion) → EXECUTE → VALIDATE`, for every unit of work.

The **Current State** page and the **Progress Tracker** database are updated
as part of the change that ships, not afterwards — via the `log-progress`
skill. See "Progress tracking (Notion)" below.

## Progress tracking (Notion)

Every delivered unit of work — a shipped PR, a completed milestone, a fixed
bug, a settled decision — gets a row in the **Progress Tracker** database,
linked from [`docs/notion.md`](docs/notion.md). Invoke the `log-progress`
skill for this at the end of the same `PLAN → EXECUTE → VALIDATE` cycle that
would previously have updated `docs/status.md` — not as a separate,
easily-forgotten follow-up.

Bugs are tracked the same way but in their own place: the **Bug Tracker**
database, read and written by the `bug-report` and `fix-bug` skills directly
— there is no `docs/bugs.md` to keep in sync with it anymore.

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
  byte-reproducible (finding F7, in the Findings database).

## The one thing not to get wrong

Caption timing. The POC this replaces shipped desynced subtitles twice, for two
different reasons, both documented as findings F1 and F5. A render whose
captions drift is worse than one with no captions, because it looks finished.
