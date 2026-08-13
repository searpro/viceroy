---
name: new-feature
description: Turn a plain-language feature description into an implementation-requirements document that complies with Viceroy's Build Plan, Architecture Decisions, and Findings, then file it in Notion. Use when the user says "new feature <description>", invokes /new-feature, or asks for requirements/guidelines to implement something new before any code gets written. This skill writes requirements only — it never implements the feature itself.
---

# New feature

Usage: `new feature <description>` (or `/new-feature <description>`).

Takes a feature description in the user's own words and produces an
implementation-requirements document — grounded in the actual codebase and
compliant with the project's settled decisions — then files it in Notion so
it's visible alongside everything else in the **Progress Tracker**. The
analysis itself is delegated to the `feature-requirements-writer` subagent
so it runs in a focused context; this skill's job is context-gathering,
dispatch, and filing the result.

## 1. Get the description

If the user invoked this with a description attached ("new feature: allow
users to reorder scenes after generation"), use it as given. If they
invoked it bare, ask what feature they want requirements for — don't guess
at scope.

## 2. Gather Notion context for the subagent

The subagent doesn't have Notion access — it starts cold and only sees what
you pass it. Before dispatching, fetch:

- **Build Plan** and **Current State** (always — they're the baseline for
  any feature).
- **Findings** database — query for entries whose `Area` plausibly overlaps
  the feature (Audio/Image/LLM/Render/Environment/Networking). If the
  feature touches captions, audio, or image sizing, do not skip this — per
  `AGENTS.md` these are the recurring traps.
- **Architecture Decisions** database — query for entries whose subject
  plausibly overlaps the feature (e.g. character consistency, data model
  choices, pipeline structure).

URLs and database ids are in [`docs/notion.md`](../../../docs/notion.md).
Pull full page content, not just titles — the subagent needs the actual
reasoning to check compliance, not a list of headings.

## 3. Dispatch to the feature-requirements-writer subagent

Invoke the Agent tool with `subagent_type: "feature-requirements-writer"`.
The prompt must be self-contained and include, in this order:

1. The feature description, verbatim, in the user's own words.
2. The Notion context gathered in step 2: relevant excerpts from Build
   Plan, Current State, and any Findings/ADRs that plausibly apply. Paste
   the actual content, not just a pointer — the subagent has no tool access
   to fetch it itself.
3. An explicit instruction that its only output is the requirements
   document in the structure its own instructions define — no code, no
   Notion writes, no implementation.

## 4. File the result in Notion

The subagent returns a markdown requirements document. You file it:

1. **Find or create the parent page.** Search Notion for a page titled
   "Feature Requirements". If it doesn't exist yet, create one as a child
   of the **Build Plan** page (URL in `docs/notion.md`) — this becomes the
   standing index for every feature requirements doc going forward, so
   future runs of this skill find it instead of creating duplicates.
2. **Create the requirements page** as a child of that index page, titled
   `Feature: <short name>` (matching the subagent's own document heading).
   Body content is the subagent's markdown, converted to Notion blocks.
3. **Add a Progress Tracker row**: `Item` = `"Feature reqs — <short name>"`,
   `Type: Doc`, `Milestone` = the closest current milestone from Current
   State (ask if genuinely ambiguous), `Status: Open` (requirements filed,
   not yet implemented), `Objective` = one sentence from the doc's Summary,
   `Description` = one sentence on what the doc covers, `Date` = today,
   `Reference` = the URL of the page created in step 2. Check for an
   existing row with the same `Item` before creating — this skill may be
   re-run to refine a doc, in which case update the existing row rather
   than duplicating it.

## 5. Confirm

Tell the user, in a few lines: the requirements page link, a one-sentence
summary of what it covers, and anything the subagent flagged in its Open
Questions section — surface those verbatim, don't bury them. Then stop;
implementing the feature is a separate, later step the user chooses to
start, same discipline as `bug-report` → `fix-bug`.

## What this skill does not do

- It does not implement the feature. Requirements only.
- It does not decide feature scope beyond what the user described — if the
  description is ambiguous on scope, ask, don't assume.
- It does not skip the Notion compliance context to save time. A
  requirements doc written without checking Findings/ADRs is exactly the
  kind of plausible-but-wrong guidance `AGENTS.md` warns about (see Finding
  F11) — gather it every time, even for a small-looking feature.
- It does not fold Bug Tracker or Progress Tracker bugfix workflow into
  this — that's `bug-report`/`fix-bug`'s job. This is for new features,
  not defects.
