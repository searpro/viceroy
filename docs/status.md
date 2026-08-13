# Project status

**Read this first when picking the project back up.** It records what is
built, what is next, and what is deliberately not built yet. The plan lives in
[`docs/PLAN.md`](PLAN.md); measured facts about the local stack live in
[`docs/findings.md`](findings.md).

_Last updated: 2026-08-12 — **M4 PR3 shipped.** Resolution selection; M4 complete._

---

## Where things stand

**M1 is done.** A one-line idea becomes a finished 1080×1920 MP4 — synopsis,
story, evaluation, scenes, cast, reference-consistent images, one-shot
narration, word-timed captions, render — driven from the browser against local
models only.

Verified output: h264 1080×1920 @ 30fps, 5369 frames, AAC 48 kHz stereo,
179.03 s against a 178.96 s narration (inside one frame), 91.9 MB.

| Milestone | Status |
| --------- | ------ |
| M0 — Environment gate | **Complete** — both audio paths confirmed on real audio by PR4 |
| M1 — Thin end-to-end slice (idea → MP4) | **Complete** — a real 1080×1920 MP4 exists |
| M2 — Manual mode and review surfaces | PR1 + PR2 + PR3 shipped |
| M3 — Management screens | **Complete** — PR1 + PR2 + PR3 + PR4 |
| M4 — Output control | **Complete** — PR1 + PR2 + PR3 |
| M5 — Packaging | Not started |

## M0 progress

**Step 1 — sd-api verified.** Running on `:3004`. All routes the plan depends
on are live: `/v1/llm/chat/completions`, `/v1/jobs`, `/v1/audio/tasks/run`,
`/v1/audio/transcriptions`, `/v1/audio-voice-refs`, `/v1/outputs/{name}`.

This took a rebuild to establish, and the failure mode is now recorded as
finding **F8**: the checked-in `dist/` was six weeks older than `src/`, so
every LLM and audio route 404'd on a server that otherwise looked healthy.

sd-api also auto-installed its stable-diffusion.cpp binary on first boot —
`sd-master-bfbef5b-bin-Darwin-macOS-26.5.2-arm64.zip`, a native arm64 build, so
`SD_ACCEL=cpu` here means NEON on the M4's own cores rather than anything
emulated.

**Step 2 — writer LLM chosen and downloading.** `mistral-nemo-12b`
(Mistral Nemo Instruct 2407, Q4_K_M, 7.48 GB, bartowski GGUF). Picked for
prose quality and a 128K context at half the RAM of the MoE alternatives,
accepting that a dense 12B on CPU generates more slowly than a 3–4B-active MoE
would. If tokens/sec proves to be the pipeline's bottleneck rather than image
generation, the ARM-repacked `Q4_0_4_8` / `Q4_0_8_8` variants of the same model
are the first thing to try.

## M1 PR1 — foundation (shipped)

| Piece | Where | Notes |
| ----- | ----- | ----- |
| Config | `lib/config.ts` | Enforces F4 (multiples of 16) and that the source frame's ratio matches the video's, at startup rather than at render time |
| Schema | `lib/db/schema.ts` | 16 tables, migration `0000_chunky_white_tiger.sql` |
| Queue | `lib/queue/index.ts` | Transactional claim, exponential backoff, abort, retry, delete, stale reclaim |
| sd-api client | `lib/sdapi/` | `llm`, `image`, `audio` — F1/F2/F3/F4 encoded in the code, with tests naming the findings |
| Worker | `worker/index.ts` | Poll loop, concurrency 1, graceful shutdown |
| App shell | `app/page.tsx` | System status page; replaced by the idea-entry screen in PR2 |

**Verified, not just typechecked:** 64 tests pass, `tsc --noEmit` is clean,
migrations apply to a real file in WAL mode, `next build` succeeds, and the
page renders with sd-api reachable. The queue was exercised against the real
worker — an enqueued `synopsis` job was claimed, failed, backed off 5s, retried
once, and gave up at its attempt limit, writing all four log lines.

Decisions that changed during the work:

- **Node 25, not 22.** Neither 22 nor 24 is installed (Homebrew's `node@24` is
  a symlink relinked to 25.7.0), and `better-sqlite3` 13.0.3 builds and runs
  clean on 25. Verified before committing to it.
- **Poll, don't stream, for image jobs.** `/v1/jobs/:id/stream` exists, but a
  poll every 2s against a job measured in minutes on CPU costs nothing and
  gives abort a natural checkpoint. An SSE reader would need unwinding
  separately to get the same property.

## M1 PR2 — story generation (shipped)

| Piece | Where |
| ----- | ----- |
| Prompt library + `{{var}}` rendering | `lib/prompts/` |
| Seed: 3 narrative, 3 voice, 2 image styles, 4 providers | `lib/db/seed.ts` |
| Stages 1–3 + revision loop | `lib/pipeline/story.ts` |
| Project service | `lib/projects.ts` |
| API: projects, project detail, job abort/retry/delete | `app/api/` |
| UI: idea entry, project view with live polling | `app/page.tsx`, `app/projects/[id]/` |

**Verified against a live model.** With the LLM provider temporarily pointed at
`smolvlm2-2.2b-instruct`, a project created through the UI ran
synopsis → story → evaluation on the real worker. The synopsis and story were
written and stored; the evaluation failed three times and gave up, because a
2.2B model cannot hold a five-key checklist vocabulary. That is the guard
working, not a bug — and it is direct evidence for risk R1.

Decisions and fixes from that run:

- **The evaluator is held to its style's own checklist keys.** A response
  naming none of them fails the stage rather than being recorded as a judgement
  of something else.
- **Scores beat the stated verdict.** Models say `"pass"` while scoring a
  dimension at 2; the checklist is the contract, so any dimension at ≤2 forces
  a revision.
- **A job that exhausts its retries now parks its project for review** with the
  reason. Before this the project kept its old stage and looked like it was
  still working.
- **No shadcn/ui yet.** PR2's surface is a form, a list and a detail view;
  hand-rolled Tailwind covers it. It earns its place in M3, where the
  management screens need real primitives.

## M1 PR3 — scenes, cast and images (shipped)

| Piece | Where |
| ----- | ----- |
| Sentence splitting + span repair | `lib/pipeline/segment.ts` |
| Stage 4 — cast, scene split, per-scene visualisation | `lib/pipeline/elements.ts` |
| Stages 5–6 — portraits, scene images | `lib/pipeline/images.ts` |
| Asset storage | `lib/assets.ts` |
| Asset serving, scene grid, cast panel | `app/api/assets/`, `app/projects/[id]/` |

Three decisions worth not re-deriving:

- **Scenes carry verbatim spans of the narration, not separately written
  text.** The voiceover is generated once from the whole story, so
  concatenating the scene scripts has to reproduce it exactly. Asking the model
  to copy text out invites paraphrase, so it is asked for sentence *indices*
  instead — which also costs a handful of tokens rather than a second copy of
  the story, and that matters under F10's ceiling.
- **The model's grouping is repaired, not trusted.** `normaliseSpans` forces a
  covering partition: a gap silently drops narration out of the video and an
  overlap plays the same words under two images. It fails only when there is
  nothing usable to repair.
- **Extraction runs in three passes and is resumable.** One whole-story call
  asking for eight fully-specified scenes exceeds the 4096-token context and
  truncates silently. Rows are written as they are known, so a failure at scene
  six resumes instead of restarting — worth minutes on this hardware.

**Character consistency uses reference images** —
[ADR 0001](adr/0001-character-consistency.md). PR3 originally shipped a
textual-only approach on the belief that `ref_images` needed an edit model;
that belief was wrong, and finding F11 records the error. Portraits are now
generated before scenes and passed as `ref_images`, which is what the plan
called for all along. The `appearanceTag` remains as the fallback.

### Verified end to end on real models

One idea — "a man stole one hundred million dollars from a community" — run in
full auto with Mistral Nemo writing and flux2-klein-4b illustrating. Every job
succeeded on its **first attempt**, no retries:

| Stage | Result |
| ----- | ------ |
| synopsis → story | 1987 savings-and-loan embezzlement, named characters, dated beats |
| story_eval | pass, 4.8/5, all five checklist keys returned — but see the leniency note below |
| elements | 2 characters with appearance tags, 7 scenes |
| scene_images | 7/7 frames, ~65 s each, ~8 min total |

**Wall clock: about 12 minutes** from idea to seven finished frames, and image
generation is ~65% of it.

Two things worth knowing that only a real run could show:

- **The verbatim-span invariant holds in practice.** The seven scene scripts
  concatenated back to the narration exactly, which is what PR4's one-shot
  voiceover depends on.
- **Textual character consistency worked better than expected but not
  exactly.** The same man was recognisably the same across all seven frames —
  sandy hair parted the same way, the same wire glasses, the same grey
  button-down — with no reference image involved. Recognisably similar people,
  though, rather than the same person, which is what prompted ADR 0001 and the
  switch to reference images.

The chain is now `elements → character_images → scene_images`, and the timings
above predate that: expect roughly **+3 minutes** for a 7-scene, 2-character
video (one extra generation per character, ~+11 s per frame).

### The evaluator is probably lenient — do not read a pass as quality

On the first Mistral Nemo run the story passed at a mean of 4.8/5 with no
issues, and the per-dimension comments echoed the checklist descriptions almost
word for word ("The prose never editorializes or reaches for shock" against a
checklist reading "The prose never editorialises or reaches for shock").

That is a model agreeing with a prompt, not a model judging a story. It means
the QC loop currently almost never fires, so its threshold logic is largely
untested against real disagreement, and a "pass" is weak evidence.

This is exactly the calibration problem story-platform's Phase 4 was blocked
on, and it is worth doing properly once there are stories a human has actually
accepted and rejected: run the evaluator repeatedly over identical input to see
whether its issue set is even stable, then check whether what it flags
correlates with what gets rejected. `evaluations` records the model and the
per-dimension scores specifically so that can be measured later.

Cheap thing to try first: have the evaluator quote the phrase it is judging
before scoring it, which makes echoing the checklist harder than engaging with
the text.

## M0 — environment gate (complete)

Steps 3 and 4 both landed. Timings are in finding F12; the headline is
**flux2-klein-4b at 51 s per 432×768 frame**, which beat `ssd-1b` on speed
*and* quality, so it replaced it as the seeded default. `ernie-image-turbo`
turned out to be a broken bundle.

Mistral Nemo (Q4_K_M, 7.48 GB) finished downloading and sd-api serves it.
Remaining from step 4 is the acoustic confirmation of the two audio paths,
which PR4 does as its first act since it is building on them.

## Operational requirements

**sd-api needs `SD_AUDIO_REQUEST_TIMEOUT_MS=900000` in its `.env`.** The
default 300 s cap is shorter than a one-shot narration of a full story, and
exceeding it does not fail cleanly — it wedges the TTS model uncancellably
until sd-api is restarted. See finding F18 for the measurements behind the
number. This is a requirement of running viceroy, not a preference.

## M1 PR4 — narration and captions (shipped)

| Piece | Where |
| ----- | ----- |
| Number expansion for matching | `lib/pipeline/numbers.ts` |
| ASR-to-authored alignment | `lib/pipeline/align.ts` |
| Stages 7–8 | `lib/pipeline/voiceover.ts` |
| Narration player, cue list, voice redirection | `app/projects/[id]/` |

### Verified on real audio

328-word narration, `qwen3-tts-voicedesign` through the task runner, aligned
against `parakeet-tdt`. Both stages succeeded on their first attempt:

| Measure | Result |
| ------- | ------ |
| Audio | 178.96 s, 24 kHz mono, 8.2 MB (ffprobe-confirmed) |
| Delivery | 110 wpm — inside the plausibility guard |
| Cues | 90, spanning 0.16 s → 178.88 s |
| Anchored to real ASR words | 89 / 90 |
| Caption text vs authored narration | **identical, all 328 words** |
| Scene timeline | 8 scenes tiling 0.2 s → 178.9 s with no gaps or overlaps |

**F5 is fixed, and the transcript shows exactly why it mattered.** 8 of 90 cues
differ from what ASR heard, and in every case the authored text is the correct
one:

| Caption shows | ASR heard |
| ------------- | --------- |
| `holding one hundred and four` | `holding104` |
| `2015,` | `October12,2015,` |
| `at 9:01 AM,` | `at9.01` |
| `largest heist in U.S.` | `largest in U.S.` (dropped a word) |
| `Henry freeze-frames, his` | `Henry frames, his` |

The first of those is the POC's exact failure — it shipped `Right at317,` over
an authored "Right at three seventeen." Here the timing comes from the
transcript and the wording from the writer, which is the whole point.

## M2 PR1 — recovering stranded projects (shipped)

Both of the user's own real projects turned out to be stuck: every job had
succeeded, nothing was queued, and `awaitingReview` was `false` — so no worker
would touch them and no screen asked for anything. `844509f6` finished
`scene_images` before the `scene_images → voiceover` chain existed; `13229d77`
had an `elements` job abort, which at the time did not park the project.

| Piece | Where |
| ----- | ----- |
| `nextStep` / `isStalled` / `advance` | `lib/pipeline/chain.ts`, `lib/pipeline/chain.test.ts` |
| Worker parks on abort, not just on failure | `worker/index.ts` |
| `getProjectDetail` returns `nextStep`/`stalled`; `continueProject()` | `lib/projects.ts` |
| `POST /api/projects/[id]` `{action: "continue"}` | `app/api/projects/[id]/route.ts` |
| Stalled banner + Continue button, video player | `app/projects/[id]/project-view.tsx` |

**The fix derives the next step from artifacts, not from `projects.stage`.** A
stage label records where a project *got to*; it cannot say whether the work
is still there. `nextStep` walks the pipeline in order — synopsis, story,
story_eval, elements (re-running it if any scene lacks an `imagePrompt`),
character_images, scene_images, voiceover, subtitle_align, render — and asks
each time whether the artifact actually exists. Verified against the two real
stranded projects:

```
844509f6 | stage scene_images   | stalled true  | next: voiceover — the narration has not been generated
13229d77 | stage story_eval     | stalled true  | next: elements — no scenes have been extracted
```

230 tests pass (20 new for `chain.ts`), `tsc --noEmit` clean, `next build`
succeeds.

**Not yet done:** actually running Continue on the two stranded projects —
that starts a real generation run (~3 min for the waitress project, ~15 min
for the remaining Koodathai pipeline), left for the user to trigger
deliberately rather than as a side effect of this PR.

## M2 PR2 — per-scene and per-character redo (shipped)

Whole-stage regenerate already existed for synopsis, story and voiceover. What
was missing was any way to redo one scene's visual prompt, one scene's image,
or one character's portrait individually — the only lever was "regenerate the
whole stage," and `elements`/`character_images`/`scene_images` all skip rows
that already have an artifact, so a whole-stage regenerate against a fully
populated project does nothing at all.

| Piece | Where |
| ----- | ----- |
| `regenerateSchema` gains `sceneId`/`characterId` | `lib/projects.ts` |
| `regenerate()` clears the one targeted artifact before enqueueing | `lib/projects.ts` |
| Direction threaded into the LLM prompt for a redone scene | `lib/pipeline/elements.ts`, `lib/prompts/defaults.ts` (`elements.scene`) |
| Direction appended to the diffusion prompt for a redone scene/character image | `lib/pipeline/images.ts` |
| Per-scene "Redo prompt" / "Redo image", per-character "Redo portrait", each with its own direction field | `app/projects/[id]/project-view.tsx` |

**The mechanism is deliberately the same one PR1 already relies on:**
`regenerate()` clears just the targeted row's artifact (`imagePrompt`, or
`imageAssetId`, or a character's portrait fields) before enqueueing the stage.
The stage itself needs no knowledge of "scoped" redos — its existing
`pending = rows.filter(row => !row.artifact)` loop picks up the one row that
was cleared, whether that happened because nothing existed yet or because a
user asked for a specific redo. `sceneId`/`characterId` in the job payload
then scope any extra `direction` text to that one row, so a redo of scene 3
cannot leak its direction into scene 4 if both happened to be pending at once.

**Image-generation direction is not an LLM call.** For `scene_images` and
`character_images`, `direction` is appended directly to the diffusion prompt
(`imagePrompt + ", " + direction`) rather than routed through an LLM rewrite —
one fewer inference round trip, and it matches how the rest of the image
prompt already reads: comma-separated visual phrases. For `elements` (the
storyboard/imagePrompt-writing stage), `direction` **is** an LLM instruction,
threaded into the `elements.scene` prompt template as free text.

9 new tests (elements/images direction-scoping, plus a new `lib/projects.test.ts`
for `regenerate()`'s clear-the-right-row behaviour) — 239 tests pass, `tsc
--noEmit` clean, `next build` succeeds. Verified in the browser against the
real "waitress" project: per-scene and per-character direction fields render
and capture input correctly.

**Not done (at the time):** redirecting `story` itself — `runStory` always
wrote from scratch and ignored `payload.direction` even though the field
existed on the wire. Fixed in PR3, below.

## M2 PR3 — story redo honours direction (shipped)

`runStory` ignored `payload.direction` entirely — "Redo story" with text typed
into the direction field silently did nothing with it, while the identical
control on the synopsis panel worked, because `runSynopsis` already branched
between a `.generate` and a `.refine` template and `runStory` never got the
same treatment.

| Piece | Where |
| ----- | ----- |
| `story.refine` template, mirrors `synopsis.refine` | `lib/prompts/defaults.ts` |
| `runStory` picks `story.write` vs `story.refine` on `story && direction` | `lib/pipeline/story.ts` |

No UI change — the direction field and "Redo story" button already existed;
they simply reached a stage that ignored their input. `pnpm db:seed` was run
against the real dev database to add the one new template row (additive only,
`onConflictDoNothing` — confirmed nothing else was inserted).

1 new test (`lib/pipeline/story.test.ts`) — 240 tests pass, `tsc --noEmit`
clean, `next build` succeeds.

## M3 PR1 — narrative/voice/image style CRUD (shipped)

M3's plan item is "Narrative / voice / image style CRUD with LLM authoring."
This PR ships the CRUD half — list, create, edit, delete — and leaves
LLM-assisted authoring (generating a new style from a text brief, the way
`elements`/`story` are LLM-authored) for a follow-up PR, since it is a
materially separate piece of work (a new prompt template per style kind, plus
the request/response plumbing) rather than a UI nicety.

| Piece | Where |
| ----- | ----- |
| Zod schemas + CRUD functions, one set per style kind | `lib/styles.ts` |
| `GET`/`POST` per kind, `PATCH`/`DELETE` per row | `app/api/styles/{narrative,voice,image}/` |
| Tabbed management screen | `app/styles/page.tsx`, `app/styles/styles-view.tsx` |
| Nav link from the home page | `app/page.tsx` |

**Three static route trees, not one dynamic `[kind]` route.** The three style
tables share no common shape beyond `id`/`name`/`isBuiltin` — narrative styles
carry an evaluation checklist, voice styles a TTS instruction, image styles a
JSON params blob — so a single generically-dispatched handler would need a
runtime switch on every field anyway. Three concrete route trees calling three
concrete `lib/styles.ts` functions read directly instead, at the cost of a
few more files.

**Built-in styles can be edited but not deleted.** Deleting one would either
orphan any project already built with it or silently degrade to whatever
`resolveStyle`'s fallback picks — neither is a good default, so deletion of a
built-in style is refused outright, and deleting a *custom* style still in use
by a project surfaces better-sqlite3's `SQLITE_CONSTRAINT_FOREIGNKEY` as "used
by an existing project" rather than the raw driver error.

**The evaluation checklist and image-style default params use a small text
encoding, not a nested editor.** The checklist is a textarea of `key:
description` lines; default params is a raw JSON textarea. A structured
key/value list editor is more UI than a first CRUD pass needs, and both
encodings are trivial to parse and to get wrong loudly (a bad JSON blob
reports "must be valid JSON" before the request goes out).

10 new tests (`lib/styles.test.ts`) — 250 tests pass, `tsc --noEmit` clean,
`next build` succeeds. Verified in the browser: all three tabs render the
real seeded styles, and a full create → verify → delete round-trip was run
against a throwaway narrative style with no data left behind afterward.

## M3 PR2 — provider registry CRUD (shipped)

`providers` already existed as a table and `resolveProvider()` already read
from it, but nothing let a user see or change one short of editing the
database directly — changing which model a stage used meant `sqlite3
data/viceroy.db`.

| Piece | Where |
| ----- | ----- |
| Zod schema + CRUD functions, one default per kind enforced in a transaction | `lib/providers.ts` |
| `GET`/`POST`, `PATCH`/`DELETE` | `app/api/providers/`, `app/api/providers/[id]/` |
| Tabbed management screen, one tab per provider kind | `app/providers/page.tsx`, `app/providers/providers-view.tsx` |
| Nav link from the home page | `app/page.tsx` |

**API keys are never sent back over the wire.** `listProviders`/the create and
update functions all pass rows through a `redact()` step that drops `apiKey`
and replaces it with `hasApiKey: boolean`; the real value stays in the
database and only a client's own explicit "replace it" input reaches the
server again. The UI's edit form leaves the key field blank and only sends a
patched `apiKey` if something was typed into it.

**Exactly one default per kind, enforced where the write happens.** Marking a
provider default clears `isDefault` on its siblings of the same kind inside
the same `db.transaction()` as the write — `resolveProvider()` picks whichever
row has `isDefault` and falls back to any provider of that kind, so two
defaults would make that pick order-dependent instead of deliberate.

**The only provider of a kind cannot be deleted.** Every stage calls
`resolveProvider()` for its kind unconditionally; deleting the last one would
turn "no provider configured" into a job failure discovered mid-pipeline
instead of a screen that just refused the click.

**Caught and fixed before shipping: `z.object(...).partial()` still applies
a field's `.default()` to a key the caller never sent.** `providerSchema` and
all three `lib/styles.ts` schemas originally had `.default()` on fields like
`isDefault`, `targetSceneCount` and `defaultParams`; a PATCH that only meant
to change `model` would have silently reset those to their defaults, because
`.partial()` makes the *key* optional but does not remove the default that
fires when the key is absent. Fixed by dropping every `.default()` from
fields used in a `.partial()` schema and letting an omitted field fall
through to the database column's own default instead, which only fires on
insert. Both `lib/providers.test.ts` and `lib/styles.test.ts` now assert
`schema.partial().parse(partialInput)` does not produce the un-sent keys.

17 new tests (`lib/providers.test.ts`, plus the partial-schema regression
tests added to `lib/styles.test.ts`) — 260 tests pass, `tsc --noEmit` clean,
`next build` succeeds. Verified in the browser against the real seeded
providers: created a throwaway default LLM provider (confirmed it correctly
demoted `sd-api (local)`'s default badge), deleted it, and restored
`sd-api (local)` to default afterward so the real data was left as found.

## M3 PR3 — prompt-template editor with reset-to-built-in (shipped)

Closes the gap the previous two PRs' status notes both pointed at: `seed()`'s
`onConflictDoNothing` means an improved built-in template never reaches an
existing database on its own, and there was no screen to see or fix that.

| Piece | Where |
| ----- | ----- |
| List with a computed `isEdited` flag, edit, reset-to-built-in | `lib/promptTemplates.ts` |
| `GET` list, `POST` edit or `{action: "reset"}` | `app/api/prompt-templates/`, `app/api/prompt-templates/[key]/` |
| One card per template, grouped by section, with variable hints | `app/prompt-templates/page.tsx`, `app/prompt-templates/prompt-templates-view.tsx` |
| Nav link from the home page | `app/page.tsx` |

**No `isEdited` column — it's a comparison against this file, not stored
state.** `DEFAULT_PROMPT_TEMPLATES` (`lib/prompts/defaults.ts`) is always
available at runtime, so whether a row still reads exactly as seeded is a
string comparison against it rather than a flag that could itself drift out
of sync. The same comparison is what "reset to built-in" writes back.

**Reset restores every built-in field together, not just `template`.** The
first version of this only reset `template` and validated the new text
against the row's own (possibly also stale) `variables` column — which is
exactly the bug this PR exists to fix, just moved one column over. Caught
before shipping via a real example: `elements.scene`'s row in the actual dev
database predated M2 PR2's addition of `{{direction}}` to that template, so
resetting it failed with "references `{{direction}}`, which is not a
documented variable" — the row's `variables` list was stale too. Fixed by
having reset overwrite `section`/`label`/`description`/`variables`/`template`
together, straight from `defaults.ts`, with a regression test that stales the
`variables` column on purpose and asserts reset still succeeds.

**Editing is still validated against declared variables.** A plain edit (not
a reset) may only reference `{{name}}`s already in that row's `variables`
list — the stage that renders it supplies exactly that set, so anything else
would reach the model as a literal, unfilled placeholder instead of failing
loudly.

**This PR's own verification run found and fixed real drift in the actual
database**, not just test fixtures: every one of the 10 seeded templates in
`data/viceroy.db` was checked via the live API, and `elements.scene` came
back `isEdited: true` — a genuine consequence of the gap this PR closes,
predating any of this session's work. Reset via the same endpoint the UI
uses brought it (and confirmed all 9 others were already) in sync; a repeat
listing afterward showed `isEdited: false` across the board.

6 new tests (`lib/promptTemplates.test.ts`) — 266 tests pass, `tsc --noEmit`
clean, `next build` succeeds.

## M3 PR4 — preferences screen (shipped, M3 complete)

The last M3 plan item. `preferences` already existed and `defaultNarrativeStyle`/
`defaultVoiceStyle`/`defaultImageStyle` were already read by `createProject`,
but `defaultMode` was seeded and never read anywhere — the new-project
form's mode radio hardcoded `defaultChecked={option.value === "auto"}`
regardless of the preference, so setting it would have looked like it worked
and done nothing. Same failure shape as `runStory` ignoring `direction`
(M1-era gap, fixed in M2 PR3): a setting that exists in the schema and the
seed data but that no code path actually consults.

| Piece | Where |
| ----- | ----- |
| Known keys, get/set, `defaultMode` value validation | `lib/preferences.ts` |
| `GET`/`POST` | `app/api/preferences/route.ts` |
| One dropdown per style kind (backed by the real current styles) + a mode radio | `app/preferences/page.tsx`, `app/preferences/preferences-view.tsx` |
| Home page now reads `defaultMode` and passes it to the new-project form instead of hardcoding `"auto"` | `app/page.tsx`, `app/new-project-form.tsx` |

**Fixed the dead `defaultMode` preference as part of this PR**, not filed as
a follow-up gap: it is exactly what a preferences screen exists to make
meaningful, so shipping the screen without wiring its own fourth field would
repeat the mistake M2 PR3 already fixed once. `createProjectSchema`'s own
`z.enum(...).default("auto")` is untouched — the new-project form always
submits an explicit `mode` now, since its radio's initial selection is
computed from the preference rather than hardcoded, so the schema default
never actually fires in practice.

**Style preferences store the style's name, not its id,** matching what
`resolveStyle()` in `lib/projects.ts` already expected — this PR only added
the screen, not a new storage shape. A deleted style's name simply falls
through to `resolveStyle`'s existing "any style of that kind" fallback.

4 new tests (`lib/preferences.test.ts`) — 270 tests pass, `tsc --noEmit`
clean, `next build` succeeds. Verified in the browser: the real preferences
(including a custom "Fast Conversational Commentary" narrative/voice style
pair already in the database) render correctly selected in each dropdown,
and the home page's mode radio was confirmed reflecting a live preference
change — the dev server run throughout this session is the user's real app,
and `defaultMode` had already been changed to `"manual"` by the time this
was checked, which the form correctly picked up.

**M3 is now fully shipped**: style CRUD, provider registry, prompt-template
editor with reset-to-built-in, and preferences — all four pieces
[`docs/PLAN.md`](PLAN.md) named for the milestone.

## M4 PR1 — caption style CRUD with a live Remotion preview (shipped)

Before this, caption styling was a single hardcoded `DEFAULT_CAPTION_STYLE`
(`remotion/schema.ts`) baked into every render — no table, no reuse across
projects, no way to see a style before rendering three minutes of video with
it. This PR gives captions the same style-CRUD shape as narrative/voice/image
(M3 PR1), plus the live preview half of M4's plan item.

| Piece | Where |
| ----- | ----- |
| `caption_styles` table + `projects.caption_style_id`, migration `0003` | `lib/db/schema.ts`, `drizzle/0003_quick_captain_america.sql` |
| Two built-in styles ("Standard", "Bold Uppercase") + `defaultCaptionStyle` preference | `lib/db/seed.ts` |
| Zod schema + CRUD functions | `lib/styles.ts` (`captionStyleSchema`, `*CaptionStyle`) |
| `GET`/`POST`, `PATCH`/`DELETE` | `app/api/styles/caption/`, `app/api/styles/caption/[id]/` |
| "Caption" tab, form + live preview | `app/styles/styles-view.tsx` |
| `<Player>` wrapper around a dedicated lightweight composition | `app/styles/caption-preview-player.tsx`, `remotion/CaptionPreview.tsx` |
| `createProject` resolves a caption style the same way as the other three; new-project form gets a 4th select; preferences screen gets a 4th dropdown | `lib/projects.ts`, `app/new-project-form.tsx`, `app/preferences/` |
| Render pipeline uses the project's caption style instead of always the default | `lib/pipeline/render.ts` (`resolveRenderCaptionStyle`), `lib/pipeline/context.ts` (`loadProject` now also returns `captionStyle`) |

**The live preview needed no bundling, no staged files, and no headless
browser** — the three things the real render path (`@remotion/renderer`,
`lib/pipeline/render.ts`) exists to manage. `@remotion/player` (newly added,
pinned to the same `4.0.508` as the rest of the Remotion toolchain) renders a
composition as a plain React component directly in the browser, so
`remotion/CaptionPreview.tsx` — the `Caption` component from `StoryVideo.tsx`
(now exported) over a placeholder gradient, cycling through three sample
lines — mounts straight into the style editor and updates on every keystroke.
Verified in the browser: typing a new text color repainted the preview
immediately, with no save or reload.

**`captionStyleId` is optional, not required, in `loadProject`.** The other
three styles are required — every generation stage needs them and `loadProject`
throws if one is missing. A project created before this migration has no
`captionStyleId` to resolve, and the caption style only matters to the last
stage, so `loadProject` returns `captionStyle: undefined` for such a project
instead of throwing, and `resolveRenderCaptionStyle` falls back to
`DEFAULT_CAPTION_STYLE` — an old project stays renderable rather than being
blocked on a column that postdates it.

**Style fields intentionally duplicate `remotion/schema.ts`'s
`captionStyleSchema`**, field-for-field, rather than the render pipeline
reading the new table directly as its schema. The table is what a user edits
through CRUD (name, description, builtin protection, FK-in-use checks); the
composition's schema is what actually gates a render (F22 — defaults are not
auto-filled into `inputProps`). Keeping them separate means a `caption_styles`
row can carry fields a composition doesn't need without touching render code,
and `resolveRenderCaptionStyle` explicitly bridges the two with
`captionStyleSchema.parse()`, which also strips the CRUD-only columns
(`id`/`name`/`description`/`isBuiltin`/timestamps) down to just what the
composition declares.

12 new tests across `lib/styles.test.ts`, `lib/preferences.test.ts` and
`lib/pipeline/render.test.ts` (the last covering `resolveRenderCaptionStyle`
and `createProject`'s caption-style resolution as pure logic, not a real
render — per finding F7, an actual render is verified with `ffprobe`, never
by a unit test) — 278 tests pass, `tsc --noEmit` clean, `next build`
succeeds. Verified in the browser: both built-in styles list correctly, a
full create → live-preview-updates → verify → delete round-trip was run
against a throwaway style, and the new 4th selector renders correctly on
both the new-project form and the preferences screen.

## M4 PR2 — queue-wide jobs screen (shipped)

`lib/queue/index.ts` already had everything a queue screen needs —
abort/retry/delete, `listJobs` — and project detail already listed a
project's own jobs inline. What was missing was any cross-project view: the
only way to see "what failed across everything" was to open each project in
turn.

| Piece | Where |
| ----- | ----- |
| `listAllJobs` — every job, newest first, each carrying its project's id/idea/title | `lib/projects.ts` |
| `GET /api/jobs` | `app/api/jobs/route.ts` |
| Queue screen with All/Active/Failed filters, links back to each job's project | `app/jobs/page.tsx`, `app/jobs/jobs-view.tsx` |
| Nav link from the home page | `app/page.tsx` |

**`listAllJobs` fetches projects separately and merges in JS rather than
joining.** A join would return the same handful of project rows once per job
belonging to it; the distinct project set is always far smaller than the job
count, so two queries plus a `Map` lookup is simpler than the join and costs
nothing extra.

**Reuses the existing per-job routes rather than adding new ones.**
`POST /api/jobs/[id]` (abort/retry) and `DELETE /api/jobs/[id]` already
existed for the per-project job list in `project-view.tsx`; the queue screen
is a second caller of the same endpoints, not a parallel set.

2 new tests (`lib/projects.test.ts`) — 280 tests pass, `tsc --noEmit` clean,
`next build` succeeds. Verified in the browser against the real database:
all 71 real jobs across every real project rendered correctly, including a
genuine failed render job (a real Remotion timeout, 3/3 attempts, working
retry button) that the **Failed** filter correctly isolated, the **Active**
filter correctly showed "Nothing here" with nothing running, and a project
link navigated to the right project page. No job was mutated during
verification — retry/delete were confirmed present and correctly gated by
status, not clicked, since retrying that real failed render would trigger an
actual multi-minute render against the user's real data.

## M4 PR3 — resolution selection (shipped, M4 complete)

**F4's multiple-of-16 constraint turned out not to apply here at all.**
Rereading `lib/config.ts` while scoping this: `multipleOf16` only wraps
`SOURCE_IMAGE_WIDTH`/`SOURCE_IMAGE_HEIGHT` — the frames sd-api actually
generates, where stable-diffusion.cpp's silent round-up bites. `VIDEO_WIDTH`/
`VIDEO_HEIGHT` (the final render's output canvas) carry no such constraint;
source frames are only ever upscaled into it, never regenerated at a
different size. So resolution selection only ever needed to preserve the
*aspect ratio* `resolveConfig` already enforces between the two at startup —
not multiples of 16.

| Piece | Where |
| ----- | ----- |
| Three presets (Standard/HD/High) as scale factors of the configured base resolution | `lib/resolution.ts` |
| `projects.width`/`projects.height`, migration `0004` | `lib/db/schema.ts`, `drizzle/0004_shocking_patch.sql` |
| `createProject` resolves a `resolutionKey` into concrete dimensions, same shape as the four styles | `lib/projects.ts` |
| Resolution selector on the new-project form | `app/new-project-form.tsx`, `app/page.tsx` |
| Render pipeline resolves and uses the project's dimensions | `lib/pipeline/render.ts` (`resolveRenderDimensions`) |
| Composition dimensions now vary per render | `remotion/schema.ts`, `remotion/Root.tsx` |

**Presets are scale factors, not fixed pixel lists.** `resolutionPresets(config)`
multiplies the configured base width/height by 2/3, 1 and 4/3, rounding each
dimension to the nearest even number (what an h264 encoder wants) — so
"HD" always equals whatever `VIDEO_WIDTH`/`VIDEO_HEIGHT` actually are on this
machine, and every preset stays at the exact same ratio `resolveConfig`
already guarantees, without re-deriving that ratio here. At this app's real
1080×1920 default the three presets land exactly on 720×1280 / 1080×1920 /
1440×2560.

**A static `<Composition width height>` can't vary per render on its own —
`calculateMetadata` now overrides it from props.** The same mechanism already
used for `durationInFrames` (deriving it from `durationMs`) now also returns
`width`/`height` from the new `width`/`height` fields on `storyVideoSchema`,
which `render.ts` populates from `resolveRenderDimensions`. Before this PR,
`VIDEO_WIDTH`/`VIDEO_HEIGHT` env vars were actually inert for the real
render — `Root.tsx` hardcoded `1080`/`1920` as static JSX props, so even the
*global* config-level setting had no effect on actual output, only on what
got written into the `renders` row's metadata. That latent gap is now fixed
as a side effect: both the per-project override and the plain config default
flow through the same `calculateMetadata` path.

**`projects.width`/`height` are nullable, following the same pattern as
`captionStyleId`** rather than the required narrative/voice/image styles: a
project created before this migration has neither set, and
`resolveRenderDimensions` falls back to `config.video` exactly the way
`resolveRenderCaptionStyle` falls back to `DEFAULT_CAPTION_STYLE`.

12 new tests (`lib/resolution.test.ts`, plus additions to
`lib/pipeline/render.test.ts`) — 290 tests pass, `tsc --noEmit` clean,
`next build` succeeds. Verified in the browser: the new-project form's
Resolution selector lists exactly "Standard (720×1280)", "HD (1080×1920)",
"High (1440×2560)", defaulting to HD.

**M4 is now fully shipped**: caption style CRUD with a live preview,
a queue-wide jobs screen, and resolution selection — all three pieces
[`docs/PLAN.md`](PLAN.md) named for the milestone.

## Known gaps

None open at the moment.

## What to pick up next

**M4 is complete.** M5 — packaging — is next per the plan: containerise,
configurable output/cache storage location, S3 optional.

Also open, not part of M4/M5 but flagged along the way and still unscheduled:
**LLM-authoring for styles** (generate a style from a text brief, out of
scope in M3 PR1).

## Environment as found (2026-08-11)

| Thing | State |
| ----- | ----- |
| sd-api | `~/projects/sd-api`, `SD_PORT=3004`, `SD_ACCEL=cpu`. Not running. |
| Image bundles | `ernie-image-turbo`, `flux2-klein-4b`, `flux2-klein-9b`, `ssd-1b` |
| LLM bundles | `glm-4.6v-flash`, `smolvlm2-2.2b-instruct` (both VLMs), plus `mistral-nemo-12b` as of M0 step 2 |
| Audio bundles | `parakeet-tdt` (ASR), `pocket-tts`, `qwen3-tts`, `qwen3-tts-voicedesign` |
| Toolchain | Node 25.7.0, pnpm 10.18.0, Docker 29.1.3. Node 20.20.2 also present; 22 and 24 are not |
| POC | `~/projects/story-platform`, last commit `8ec951d` |

## Decisions taken since the plan

None yet.

## Drift

No drift. There are no commits to compare against.
