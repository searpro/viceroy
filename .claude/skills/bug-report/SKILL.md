---
name: bug-report
description: Capture a bug the user just found while manually testing the running Viceroy app and log it into the Notion Bug Tracker database, the project's M5 "beta hardening" tracker. Use this whenever the user reports something broken, unexpected, or wrong in the app — phrases like "this is broken", "I found a bug", "log this", "add this to the tracker", "that shouldn't happen", or a plain description of a screen misbehaving — even if they don't say "bug report" or name the skill. Also trigger on the explicit /bug-report command. This skill only records the report; it never diagnoses the cause or fixes anything.
---

# Bug report

Viceroy is in M5 (beta hardening — see the **Build Plan** page in Notion):
the user tests the running app by hand, and every bug they hit gets logged
in the Notion **Bug Tracker** database *before* anyone looks at why it
happened. Fixing is a separate, later step — its own PR, one bug at a time.
This skill's entire job is steps 1–2 of that process: capture the report
accurately and get it into the tracker. Stop there. Do not read the source
code, do not speculate about the cause, do not start fixing it in the same
turn — even if the cause seems obvious. Mixing capture and diagnosis is
exactly what this workflow is designed to keep separate, and jumping ahead
defeats the point of having a queue at all.

The Bug Tracker's URL and schema are in
[`docs/notion.md`](../../../docs/notion.md) — fetch it if you don't already
have the database id cached in this session.

## 1. Gather the report

You need four things, matching the Bug Tracker's page-body fields. If the
user's message already gives you enough to fill one in confidently, use it as
given — don't interrogate someone who clearly already told you. Ask about
whatever's actually missing or ambiguous, in one combined question rather
than a one-at-a-time back-and-forth:

- **Title** — a short summary you can usually write yourself once you have
  the rest; confirm it rather than asking for it outright. This becomes the
  row's `Title` property.
- **Flow** — the concrete steps that trigger it: which screen, which action,
  in what order. "The styles page is broken" isn't a flow; "on /styles,
  clicked the Voice tab, then clicked edit on Warm Storyteller" is.
- **Expected** — what should have happened.
- **Actual** — what happened instead.
- **Error text** — any error message, toast, or console output shown
  verbatim, if there was one. It's fine if there wasn't.

Capture what was *observed*, not a theory about what's wrong. If the user
volunteers a guess at the cause, that's fine to include as a note, but don't
let it substitute for the actual flow/expected/actual description — the
person fixing this later may be a different session with none of this
context, and a guess presented as fact can send them down the wrong path.

## 2. Create the row

Use the Notion tools to create a page under the Bug Tracker's data source
with:

- **Title** — the short summary from step 1.
- **Status** — `Open`.
- **Reported** — today's date.
- **Bug ID** — leave unset; it's an auto-incrementing property Notion
  assigns on creation.

Page content (the body, not a property) follows this structure:

```
**Flow:** <the screen, action, and sequence that triggers it>

**Expected:** <what should have happened>

**Actual:** <what happened instead>

**Error text:** <verbatim error message shown, if any — omit this line if none>
```

## 3. Confirm

Tell the user the assigned Bug ID (from the created page's properties) and a
one-line recap of what was logged. Don't offer to start fixing it — that's a
deliberate later step, chosen by the user from the open list, not an
automatic next action here.
