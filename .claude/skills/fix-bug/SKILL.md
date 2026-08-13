---
name: fix-bug
description: Fix a single open bug from the Notion Bug Tracker database by delegating diagnosis and repair to the bug-fixer subagent. Use this when the user says "fix BUG-042", "let's tackle the next bug", "work on the caption timing bug", or invokes /fix-bug — anything that means "pick a bug from the tracker and actually fix it." This skill dispatches; the subagent does the diagnosis, code reading, and edits, then reports back so the user can review and commit.
---

# Fix bug

Companion to `bug-report`. That skill logs bugs into the Notion **Bug
Tracker** database without touching code; this one takes one entry from that
queue and fixes it. The work itself — reading docs, tracing the flow,
editing code — is delegated to the `bug-fixer` subagent so the main
conversation stays clean and the fix is done in a focused context. Your job
here is dispatch, not diagnosis.

The Bug Tracker's URL and schema are in
[`docs/notion.md`](../../../docs/notion.md) — fetch it if you don't already
have the database id cached in this session.

## 1. Pick the bug

You need a specific Bug ID to hand to the subagent.

- If the user named one ("/fix-bug BUG-2", "fix BUG-14", "the redo-story
  one"), fetch the Bug Tracker data source and confirm a row with that Bug ID
  exists and has `Status: Open` before proceeding.
- If they said "the next one" or "oldest open", query the Bug Tracker for
  rows with `Status: Open`, sorted by `Reported` ascending, and pick the
  first.
- If they said "fix a bug" with no id, query the Bug Tracker for `Open` rows
  and ask the user which one to take, listing their Bug IDs and titles.
  Don't guess.
- If the referenced id is `Fixed` or doesn't exist, say so and stop — don't
  silently pick a different one.

## 2. Extract the entry

Fetch the full page for that row — properties (`Bug ID`, `Title`, `Status`,
`Reported`) and body content (Flow/Expected/Actual/Error text). You need
every field the reporter captured; the subagent will start cold and only sees
what you pass it.

## 3. Dispatch to the bug-fixer subagent

Invoke the Agent tool with `subagent_type: "bug-fixer"`. The prompt must be
self-contained — the subagent has none of this conversation's context. It
must include, in this order:

1. The verbatim bug entry (all fields) from the Notion page.
2. A pointer to the project's key docs it should read first: `AGENTS.md`,
   then (per `docs/notion.md`) the **Build Plan**, **Current State**,
   **Findings**, and any relevant **Architecture Decisions** entries in
   Notion. The agent definition already tells it to do this; restating it in
   the prompt reinforces the sequence.
3. An explicit instruction to fix only this bug — no adjacent cleanup, no
   opportunistic refactors — and to report back rather than commit.

Do **not** paraphrase the bug entry or drop fields; the reporter chose those
words deliberately and the subagent's diagnosis depends on them.

## 4. Relay the result

When the subagent returns, surface its report to the user faithfully — root
cause, files touched, validation run, and any follow-ups it flagged. Don't
editorialise, don't re-diagnose, don't hide caveats it raised.

Then remind the user of the next steps *they* own:

- Review the diff.
- If satisfied, commit the fix.
- After commit, update the row in the Bug Tracker: set `Status` to `Fixed`,
  `Fixed Date` to today, `Commit` to the short hash, and append a `**Cause:**
  <one-line root cause>` line to the page body.

Do not do these steps yourself unless the user explicitly asks — the
tracker's workflow puts them deliberately after human review.

## What this skill does not do

- It does not commit, push, or update the Bug Tracker itself. Those are
  post-review actions the user takes (or explicitly asks for).
- It does not fix multiple bugs in one run. One id, one dispatch, one fix.
  If the user wants a batch, run the skill multiple times.
- It does not diagnose in the main conversation. If you find yourself
  reading source files here to "help" the subagent, stop — hand the bug
  over and let the subagent do its job in its own context.
