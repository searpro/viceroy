---
name: bug-report
description: Capture a bug the user just found while manually testing the running Viceroy app and log it into docs/bugs.md, the project's M5 "beta hardening" tracker. Use this whenever the user reports something broken, unexpected, or wrong in the app — phrases like "this is broken", "I found a bug", "log this", "add this to the tracker", "that shouldn't happen", or a plain description of a screen misbehaving — even if they don't say "bug report" or name the skill. Also trigger on the explicit /bug-report command. This skill only records the report; it never diagnoses the cause or fixes anything.
---

# Bug report

Viceroy is in M5 (beta hardening — see `docs/PLAN.md`): the user tests the
running app by hand, and every bug they hit gets logged in `docs/bugs.md`
*before* anyone looks at why it happened. Fixing is a separate, later step —
its own PR, one bug at a time. This skill's entire job is steps 1–2 of that
process: capture the report accurately and get it into the tracker. Stop
there. Do not read the source code, do not speculate about the cause, do not
start fixing it in the same turn — even if the cause seems obvious. Mixing
capture and diagnosis is exactly what this workflow is designed to keep
separate, and jumping ahead defeats the point of having a queue at all.

## 1. Gather the report

You need five things. If the user's message already gives you enough to fill
one in confidently, use it as given — don't interrogate someone who clearly
already told you. Ask about whatever's actually missing or ambiguous, in one
combined question rather than a one-at-a-time back-and-forth:

- **Title** — a short summary you can usually write yourself once you have
  the rest; confirm it rather than asking for it outright.
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

## 2. Find the next id

Read `docs/bugs.md`. Ids are sequential and never reused, so scan **both**
the Open and Fixed sections for the highest `BUG-<n>` and use `n + 1` — a
fixed bug still consumes its id. If the file is empty of entries, start at
`BUG-001`.

## 3. Append the entry

Add the entry under `## Open`, following the exact format documented in that
file (there's a template right above the `## Open` heading — use it
verbatim, don't improvise a different structure). If `## Open` currently
holds only the `_None yet._` placeholder, replace it; otherwise append after
the existing open entries, immediately before the `## Fixed` heading.

Use today's date for `**Reported:**`. Omit the `**Error text:**` line
entirely if there wasn't one — don't write "N/A".

## 4. Confirm

Tell the user the assigned id and a one-line recap of what was logged.
Don't offer to start fixing it — that's a deliberate later step, chosen by
the user from the open list, not an automatic next action here.
