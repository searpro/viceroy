---
name: log-progress
description: Log a delivered unit of work — a shipped PR, a completed milestone, a fixed bug, or a settled decision — as a row in the Notion Progress Tracker database (linked from docs/notion.md), so the user has one place to see delivery history. Use this at the end of any PLAN → EXECUTE → VALIDATE cycle per AGENTS.md once Current State / Phases & Milestones / Build Plan in Notion has been updated, when draining docs/.notion-pending.log at session start, when a bug fix lands via fix-bug, or when the user says things like "log this to Notion", "update the tracker", "mark it done", or "that's shipped". The Bug Tracker database (owned by bug-report/fix-bug) stays the detailed record of a bug; this skill keeps the matching Type:Bugfix row here in sync with it rather than duplicating its content.
---

# Log progress to Notion

Notion is the source of truth for Viceroy now (see `docs/notion.md`), so
"logging progress" here means keeping the **Progress Tracker** database
current as the terse, cross-cutting index over everything else: Current
State, Phases & Milestones, Build Plan, Findings, Architecture Decisions. A
detailed page update to one of those (e.g. adding a PR's narrative to a
milestone detail page) is a separate, direct edit made in the same turn as
the work — this skill's job is specifically the tracker row that indexes it.

The tracker's URL, schema, and column meanings, plus every other Notion page
this project uses, are in
[`docs/notion.md`](../../../docs/notion.md) — read that file first if this is
a fresh session.

## 0. If you're draining the pending-commit queue

`.githooks/post-commit` appends every commit to `docs/.notion-pending.log`
(tab-separated: hash, date, subject) because the hook itself can't reach
Notion. If that's why you're running — `AGENTS.md`'s session-start check
found a non-empty file — read it, then treat each line as a candidate rather
than an automatic row: most individual commits (a fix-up, a doc tweak, a
follow-on refinement within a PR you already logged) aren't their own unit of
work per step 1 below. Group consecutive commits that belong to the same
PR/milestone/bugfix into one row, same as you would working from `git log`
directly. Once you've logged (or deliberately skipped) everything in the
file, clear it — `: > docs/.notion-pending.log` — so the next session isn't
re-shown commits already handled. Don't clear it if you stopped partway
through; leave the undrained lines so the next check picks them up.

## 1. Work out what actually needs a row

One row per delivered *unit* — a shipped PR, a milestone flipping to
complete, or a decision worth recording (the kind that would otherwise get an
Architecture Decisions entry). Don't log intermediate commits or in-flight
work as new rows; a milestone or PR that isn't finished yet doesn't get
logged at all, unless it's the kind of multi-session effort where an `In
Progress` row genuinely helps the user see what's being worked on right now
(e.g. M5 itself).

Bug fixes get a `Type: Bugfix` row here too, alongside their entry in the
**Bug Tracker** — the two databases are different views (detailed
flow/expected/actual vs. the terse cross-cutting index) and both need to
stay current. `bug-report` creates the Bugfix row (`Status: Open`) when it
files the bug; `fix-bug` is responsible for flipping it to `Status: Done`
with `Commit`/`Date`/`Description` once the fix lands — don't create a
second row for the same Bug ID, update the existing one by matching `Item`
against the Bug ID. If you're draining the pending-commit queue and find a
bugfix commit whose Bug Tracker row is already `Fixed` but whose Progress
Tracker `Bugfix` row is still `Open`, that's a dropped update — close the
loop by updating it here rather than skipping it. The exception to creating
a *new* row is a PR that closes a bug as part of larger scope: that PR still
gets its own `Type: PR` row, same as any other PR, rather than a `Bugfix`
row.

For each row you need:

- **Item** — short title. Match the naming already used on the relevant
  Notion page where one exists (e.g. "M4 PR3 — resolution selection").
- **Type** — `Milestone`, `PR`, `Decision`, or `Doc`.
- **Milestone** — which `M0`–`M6` this belongs to, if any.
- **Status** — `Done`, `In Progress`, `Open`, or `Blocked`.
- **Objective** — one sentence: what this was trying to achieve. Pull from
  the Build Plan item, don't invent one.
- **Description** — one to two sentences: what actually shipped. Pull from
  the relevant Notion page or the fix commit — don't pad it with
  implementation detail that belongs on that page, not in this row.
- **Date** — today's date (or the date the item was opened, for `Open` rows).
  Never fabricate a date for historical backfill; use the real commit date
  from `git log --pretty=format:'%ad' --date=short -1 <hash>` if you're
  logging something after the fact.
- **Commit** — short hash, when there is one. Get it from `git log`, don't
  guess.
- **Reference** — a URL, only if there's something to link: a related Notion
  page (e.g. the Architecture Decisions entry for a Decision-type row) or an
  external doc. Leave blank rather than forcing a link.

## 2. Check for an existing row before creating one

If this update is flipping something already tracked (most commonly: a
milestone going `In Progress` → `Done`), fetch the Progress Tracker data
source and search for the existing row by title rather than creating a
second one for the same item. Update that row's `Status`, `Description`
(append what changed), `Date`, and `Commit` in place.

If nothing matching exists, create a new row instead.

## 3. Write it

Use the Notion tools against the Progress Tracker's data source (its
`collection://` id is in the database's own state — fetch the database URL
from `docs/notion.md` if you don't have the id cached in this session).
Create rows as pages under that data source with the properties above;
update existing rows with the page-update tool rather than create-then-orphan
the old one.

## 4. Confirm

Tell the user, in one line, what got logged or updated — item name, status,
and a link to the row if the tool returns one. Don't narrate the schema or
re-explain the tracker; they already know it's there.

## What this skill does not do

- It does not decide *whether* something is done — that judgment (tests
  pass, user confirmed, commit landed) happens before this skill is invoked,
  not inside it.
- It does not edit Current State, Phases & Milestones, Build Plan, Findings,
  or Architecture Decisions — those are updated directly, in the same turn as
  the work that changes them, per `AGENTS.md`.
- It does not touch the Bug Tracker itself — `bug-report` and `fix-bug` own
  that database directly. It does own the matching `Bugfix` row in the
  Progress Tracker, per above.
- It does not log every commit. Granularity is PR/milestone/decision, matching
  what would earn its own heading on a Notion status page.
