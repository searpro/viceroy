---
name: fix-bug
description: Fix a single open bug from docs/bugs.md by delegating diagnosis and repair to the bug-fixer subagent. Use this when the user says "fix BUG-042", "let's tackle the next bug", "work on the caption timing bug", or invokes /fix-bug — anything that means "pick a bug from the tracker and actually fix it." This skill dispatches; the subagent does the diagnosis, code reading, and edits, then reports back so the user can review and commit.
---

# Fix bug

Companion to `bug-report`. That skill logs bugs into `docs/bugs.md` without
touching code; this one takes one entry from that queue and fixes it. The
work itself — reading docs, tracing the flow, editing code — is delegated to
the `bug-fixer` subagent so the main conversation stays clean and the fix is
done in a focused context. Your job here is dispatch, not diagnosis.

## 1. Pick the bug

You need a specific `BUG-<id>` to hand to the subagent.

- If the user named one (`/fix-bug BUG-002`, "fix BUG-014", "the redo-story
  one"), use that. Confirm the id matches an entry under `## Open` in
  `docs/bugs.md` before proceeding.
- If they said "the next one" or "oldest open", read `docs/bugs.md` and pick
  the first entry under `## Open`.
- If they said "fix a bug" with no id, read `docs/bugs.md` and ask them
  which open bug to take, listing the open ids with their one-line titles.
  Don't guess.
- If the referenced id is under `## Fixed` or absent, say so and stop —
  don't silently pick a different one.

## 2. Extract the entry

Read the full entry from `docs/bugs.md` — the `### BUG-<id> — <title>`
heading through to (but not including) the next `###` or `##` heading. You
need every field the reporter captured (Flow, Expected, Actual, Error text
if present); the subagent will start cold and only sees what you pass it.

## 3. Dispatch to the bug-fixer subagent

Invoke the Agent tool with `subagent_type: "bug-fixer"`. The prompt must be
self-contained — the subagent has none of this conversation's context. It
must include, in this order:

1. The verbatim bug entry from `docs/bugs.md` (all fields).
2. A pointer to the project's key docs it should read first: `CLAUDE.md`,
   `docs/PLAN.md`, `docs/status.md`, `docs/findings.md`, and any relevant
   `docs/adr/` entries. The agent definition already tells it to do this;
   restating it in the prompt reinforces the sequence.
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
- After commit, move the entry in `docs/bugs.md` from `## Open` to
  `## Fixed`, appending `**Fixed:** <date> — commit `<short hash>`` and
  `**Cause:** <one-line root cause>` per the format at the top of that file.

Do not do these steps yourself unless the user explicitly asks — the
tracker's workflow puts them deliberately after human review.

## What this skill does not do

- It does not commit, push, or update `docs/bugs.md`. Those are post-review
  actions the user takes.
- It does not fix multiple bugs in one run. One id, one dispatch, one fix.
  If the user wants a batch, run the skill multiple times.
- It does not diagnose in the main conversation. If you find yourself
  reading source files here to "help" the subagent, stop — hand the bug
  over and let the subagent do its job in its own context.
