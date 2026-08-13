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

**Entry format**, under Open:

```
### BUG-<id> — <short title>

**Reported:** <date>
**Status:** Open

**Flow:** <the screen, action, and sequence that triggers it>

**Expected:** <what should have happened>

**Actual:** <what happened instead>

**Error text:** <verbatim error message shown, if any — omit this line if none>
```

On fix, move the entry to Fixed and append:

```
**Fixed:** <date> — commit `<short hash>`
**Cause:** <one-line root cause>
```

## Open

### BUG-002 — Redo Story with direction prompt not updating scene captions

**Reported:** 2026-08-13
**Status:** Open

**Flow:** Go to any story → enter a direction prompt to alter the story → click on redo story → wait for the redo to complete → check the scene caption

**Expected:** The scene caption should be updated with the new story's corresponding scene caption. The system should compare the previous and current scene captions and suggest whether a new image generation is required.

**Actual:** The scene caption is the same as before, even though the story is getting updated according to the direction prompt

## Fixed

### BUG-001 — Saved preferences not applied to new idea screen

**Reported:** 2026-08-13
**Status:** Fixed

**Flow:** Go to Preferences → select Voice/Caption/Style settings and mark as default → Save → go to home screen and create a new idea → check dropdowns

**Expected:** The default voice, caption, and style settings should be populated in the new idea dropdowns

**Actual:** The default settings are not reflected in the new idea dropdowns

**Fixed:** 2026-08-13 — commit `d022581`
**Cause:** `listPreferences()` result in `page.tsx` was only partially consumed — the four style preference fields were never extracted or forwarded to `NewProjectForm`, so its `<select>` elements had no `defaultValue`
