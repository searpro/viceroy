---
name: dev-feature
description: Implement a feature in the Viceroy codebase by delegating the actual coding to the feature-implementer subagent. Use when the user says "dev feature <name/description>", invokes /dev-feature, or asks to actually build/implement a feature (as opposed to writing requirements for one). Prefers an existing requirements doc filed by new-feature if one exists; otherwise implements straight from the description. This skill dispatches and files the result; the subagent does the reading, coding, and testing.
---

# Dev feature

Companion to `new-feature`. That skill turns a description into a
requirements document and files it in Notion without touching code; this
one takes a feature — ideally one that already has a requirements doc —
and actually implements it. The coding itself is delegated to the
`feature-implementer` subagent so it runs in a focused context; this
skill's job is context-gathering, dispatch, and filing the result.

Usage: `/dev-feature <feature name or description>`.

## 1. Find or confirm the spec

The subagent works best from a requirements doc, but doesn't require one.

- Search Notion for the **Feature Requirements** index page (child of
  **Build Plan**, per `docs/notion.md`) for a child page whose title
  matches `Feature: <name>` against what the user typed.
- If found, fetch its full content — this is the spec.
- If not found, and the user's input reads as a short name rather than a
  full description (e.g. "/dev-feature scene reorder" with no detail), tell
  them no requirements doc exists for that name and ask whether to (a)
  proceed straight from their description as-is, or (b) run `new-feature`
  first to get a reviewed spec. Don't silently pick one.
- If the user gave a full plain-language description (not just a name),
  proceed directly from it — treat it as the spec and note in your dispatch
  that no formal requirements doc was filed.

## 2. Gather Notion context for the subagent

Same as `new-feature` step 2 — the subagent starts cold with no Notion
access:

- **Build Plan** and **Current State** (always).
- **Findings** database — entries whose `Area` plausibly overlaps the
  feature. Don't skip this for anything touching audio, captions, or image
  sizing (per `AGENTS.md`, these are the recurring traps).
- **Architecture Decisions** database — entries whose subject plausibly
  overlaps the feature.

Pull full page content, not just titles.

## 3. Dispatch to the feature-implementer subagent

Invoke the Agent tool with `subagent_type: "feature-implementer"`. The
prompt must be self-contained and include, in this order:

1. The requirements doc content (if one was found), or the user's
   description verbatim (if not) — labeled clearly which one it is.
2. The Notion context gathered in step 2, pasted in full.
3. An explicit instruction that it should implement, test, and validate
   the feature per its own instructions, but must not commit, push, or
   touch Notion.

## 4. Relay the result

When the subagent returns, surface its report to the user faithfully:
files added/changed, tests added, validation run and results, and any
compliance conflicts or open questions it flagged. Don't editorialize,
don't re-implement, don't hide caveats.

Then remind the user of next steps *they* own:

- Review the diff.
- Run the app / exercise the feature manually if it's UI-facing (offer to
  use the `run` skill if one exists for this).
- If satisfied, commit.
- After commit, invoke `log-progress` to record the delivery: if a
  requirements doc's Progress Tracker row exists (`Type: Doc`, `Item`
  `"Feature reqs — <short name>"`, filed by `new-feature`), update it to
  `Status: Done` with `Commit` and `Date` rather than creating a new row.
  If no such row exists (implemented straight from a description), create
  one now (`Type: Feature`, `Status: Done`).

Do not commit, push, or touch Notion yourself unless the user explicitly
asks — those steps come after human review, same discipline as
`bug-report` → `fix-bug`.

## What this skill does not do

- It does not write requirements docs — that's `new-feature`'s job. If no
  spec exists and the user's input is too thin to implement from, ask
  rather than guessing at scope.
- It does not implement multiple features in one run. One feature, one
  dispatch.
- It does not code in the main conversation. If you find yourself editing
  source files here to "help" the subagent, stop — hand the feature over
  and let the subagent do its job in its own context.
- It does not commit, push, or update Notion itself — those are
  post-review actions the user takes or explicitly asks for.
