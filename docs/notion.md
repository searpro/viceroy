# Notion

Notion is the source of truth for Viceroy's project documentation — the
build plan, milestone status, measured findings, architecture decisions, and
the bug tracker all live here now, not as markdown in this repo. This file
is the map. Read it first, every session, before anything else in
`AGENTS.md`'s reading list.

The only thing that stays local is `AGENTS.md` itself — the agent harness
reads it directly, and it can't live only in Notion.

## Pages and databases

| Item | URL | Purpose |
| ---- | --- | ------- |
| Story Video Generator (root) | https://app.notion.com/p/3b90755fb9988023b924f171e52a5afb | Original requirements doc |
| **Build Plan** | https://app.notion.com/p/3bb0755fb998817484efc2d57f2cf092 | Decisions, stack, data model, pipeline, sd-api integration, risks, working agreement. Replaces `docs/PLAN.md` |
| **Current State** | https://app.notion.com/p/3c30755fb998819c951fd9fce06bcfa5 | Point-in-time status snapshot (2026-08-21 baseline). Replaces `docs/status.md`'s "where things stand" section |
| **Phases & Milestones** | https://app.notion.com/p/3bb0755fb99881d9a9a2ea9e2b5ce87e | M0–M6 status, PR-level summary tables. Has 5 child pages (below) carrying the full PR-by-PR narrative |
| ↳ M0 detail | https://app.notion.com/p/3bb0755fb99881b787aef2cc4cef6cd8 | Environment gate — full detail |
| ↳ M1 detail | https://app.notion.com/p/3bb0755fb9988142b304c11dd314a7a7 | Thin end-to-end slice — full detail |
| ↳ M2 detail | https://app.notion.com/p/3bb0755fb99881788b6af2684c76cf8f | Manual mode and review surfaces — full detail |
| ↳ M3 detail | https://app.notion.com/p/3bb0755fb99881b8b4eccecf1507b5d3 | Management screens — full detail |
| ↳ M4 detail | https://app.notion.com/p/3bb0755fb99881198dc5d8ed8a733f97 | Output control — full detail |
| ↳ M7 detail | https://app.notion.com/p/3c30755fb998810a9f93fe753a5a8e87 | Development & Preproduction (Movie Engine) — the first major version, currently documentation/research. Format taxonomy, 21-artifact stage chain, data model, style/provider strategy, PR sequence |
| ↳ M8 detail | https://app.notion.com/p/3c20755fb99881f7a46ac1b013a8c538 | Production (Film pipeline / LTX shots), renumbered from M7 — planned, not started. Data model, stage chain, pod lifecycle, PR sequence |
| **Findings** (database) | https://app.notion.com/p/3567948e711844818d55765a3bb18a73 | F1–F22, measured local-stack behaviour that contradicts its own docs. Replaces `docs/findings.md` |
| **Architecture Decisions** (database) | https://app.notion.com/p/3a83993f25f94730bc13594332565a81 | ADRs — decisions whose reasoning is worth more than a line. Replaces `docs/adr/` |
| **Bug Tracker** (database) | https://app.notion.com/p/7aa66b802429405e834ad7953f9acd12 | M5 beta-hardening tracker. Replaces `docs/bugs.md` |
| **Progress Tracker** (database) | https://app.notion.com/p/20a4b70b74a141f7a8135d1512512835 | One row per delivered PR/milestone/bugfix/decision. Updated by `log-progress` |
| **Prompt & Flow Audit** | https://app.notion.com/p/3bd0755fb99881ce9f88ce566594eac4 | 2026-08-15 audit of the prompt engine and redo/advance flow. Holds the reasoning spanning BUG-007–BUG-021; the per-item detail is in the Bug Tracker |
| **LTX Long-Video Feasibility** | https://app.notion.com/p/3c20755fb99881d4b587d1e566a063b3 | 2026-08-20 desk analysis of generating 3–5 min videos with LTX 2.5/2.3 through ComfyUI and LTX Director — model/VRAM ladder, projected generation time and cost, long-form chaining strategies, the unknowns that need measuring, and a phased plan |

## Database schemas

**Findings** — `Finding` (title), `Area` (select: Audio/Image/LLM/Render/
Environment/Networking), `Summary` (one-line text), `Status` (select: Active/
Superseded). Full write-up is the page body, not a property — these run
long.

**Architecture Decisions** — `Decision` (title), `Status` (select: Proposed/
Accepted/Superseded), `Date`, `Supersedes` (text). Context/Decision/
Consequences/Alternatives is the page body.

**Bug Tracker** — `Title` (title), `Bug ID` (auto-incrementing, prefixed
`BUG`), `Status` (select: Open/Fixed), `Reported` (date), `Fixed Date`
(date), `Commit` (text). Flow/Expected/Actual/Error/Cause is the page body —
see the `bug-report` and `fix-bug` skills for the exact fields to capture.

**Progress Tracker** — `Item` (title), `Type` (select: Milestone/PR/Bugfix/
Decision/Doc), `Milestone` (select: M0–M6), `Status` (select: Done/In
Progress/Open/Blocked), `Objective` (text), `Description` (text), `Date`,
`Commit` (text), `Reference` (url).

## The post-commit hook

A git hook can't call the Notion MCP tools — those only exist inside an agent
session. So `.githooks/post-commit` (tracked in the repo, wired in via `git
config core.hooksPath .githooks`) doesn't talk to Notion directly. It appends
every commit's hash, date, and subject to `docs/.notion-pending.log`
(gitignored) and prints a reminder. The handoff to Notion happens later, in an
agent session: `AGENTS.md`'s session-start check reads that file and invokes
`log-progress` to drain it, then clears it. The hook guarantees nothing gets
committed without being *queued*; it does not guarantee every queued commit
becomes a Notion row — the skill still decides what's loggable versus routine.

A fresh clone needs `git config core.hooksPath .githooks` run once (the repo
setting isn't itself versioned by git); if `docs/.notion-pending.log` isn't
growing after commits, that's the first thing to check.

## The repo-side stub files

`docs/PLAN.md`, `docs/findings.md`, `docs/status.md`, `docs/bugs.md`, and
`docs/adr/0001-character-consistency.md` are one-paragraph stubs pointing
back to this file. They exist so an old link or an old habit doesn't 404 or
land on a confusing empty diff — they are not read for content, and nothing
should be written into them again. If you find yourself about to add
substance to one of these files, stop and add it to the corresponding Notion
page or database instead.

## When to update

The `log-progress` skill handles the Progress Tracker. The `bug-report` and
`fix-bug` skills handle the Bug Tracker directly. Current State, Build Plan,
Phases & Milestones, Findings, and Architecture Decisions are updated
directly by whichever agent turn produces the change they describe — same
discipline as the old `docs/status.md`, just written to Notion instead of a
file.
