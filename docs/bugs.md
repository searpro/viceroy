# Bug tracker

M5's tracker — see [`docs/PLAN.md`](PLAN.md#m5--beta-hardening) for the
process. Every bug found during manual beta testing gets an entry here when
it's reported, before it's fixed. Fixed bugs stay in this file (moved to the
Fixed section) rather than being deleted, so the history of what beta testing
actually found is not lost.

**Workflow:**

1. User reports a bug from real use of the running app.
2. It's logged below under Open, with an ID, the flow that triggers it, and
   expected vs. actual behaviour — captured before root-causing, so the
   report reflects what was actually observed.
3. Fixed one at a time, oldest open first unless the user reprioritises.
   Each fix is its own PR/commit.
4. On fix, the entry moves to Fixed with the commit hash and a one-line note
   on the actual cause — worth recording since "what actually broke" is
   often more informative than "what screen it was on."

Numbering is sequential and never reused, even if a report turns out to be
invalid — BUG-003 being absent means it was reported and dropped, not that
numbering is broken.

## Open

_None yet._

## Fixed

_None yet._
