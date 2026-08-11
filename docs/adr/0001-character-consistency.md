# ADR 0001 — Character consistency uses reference images

**Status:** accepted, 2026-08-11
**Supersedes:** the textual-only approach shipped in M1 PR3, and corrects
finding F11.

## Context

Scenes are generated as independent text-to-image calls. Nothing in that
carries a face from one frame to the next, so without an explicit mechanism the
protagonist is a different person in every shot.

The build plan (D-series, `docs/PLAN.md` stage 5) called for generating a
reference portrait per character first and passing it to every scene via
`ref_images`. During PR3 that was abandoned on the following reasoning:

- `ref_images` maps to sd-cli's `-r`, documented in `--help` as "reference
  image for **Flux Kontext or MiniMax-H3 Ref2VA**".
- sd-api's catalog flags exactly five models `edit: true` — `flux1-kontext-dev`,
  `qwen-image-edit`, `qwen-image-edit-2509`, `qwen-image-edit-2511`,
  `mage-flow-edit-turbo`.
- Every installed bundle reports `edit: false`, including `flux2-klein-4b`.

That reasoning was wrong, and it was wrong in an avoidable way: it inferred a
capability from a metadata flag instead of testing the capability.

**Two facts overturn it.**

1. **sd-api never enforces the `edit` flag.** `src/sd/args.ts` pushes `-r` for
   every reference passed, on any model:
   ```
   for (const ref of images?.refs ?? []) args.push('-r', ref);
   ```
   `edit` is catalog metadata driving the web UI's affordances, not a gate.

2. **FLUX.2 supports reference images.** stable-diffusion.cpp's own
   `docs/flux2.md` documents `-r` editing workflows for FLUX.2 dev *and* both
   klein variants. The `--help` line naming Kontext is simply out of date.

### Measured

Reference: the generated `scene-06` frame (a clear face). Prompt: an entirely
different setting — *"the same man standing outside a courthouse at dusk,
wearing a dark overcoat, crowd behind him"*. Model `flux2-klein-4b`, 4 steps,
cfg 1, 432×768.

The returned frame is recognisably **the same person** — facial structure,
hairline and part, glasses, jaw — in a completely different scene, pose and
wardrobe.

Cost: **76 s versus ~65 s** for the same generation without a reference, so
roughly **+11 s per frame**.

## Decision

Generate character portraits **before** scene images, and pass each scene the
portraits of the characters appearing in it as `ref_images`.

Concretely:

- `character_images` re-enters the automatic chain, between `elements` and
  `scene_images`, which is where the original plan put it.
- Each portrait is uploaded to sd-api via `POST /v1/inputs` **once**, and the
  returned name is stored on the character row. Scenes reference it by name;
  nothing re-uploads per frame.
- `scene_images` resolves each scene's `characterIds` to those names and sends
  them as `ref_images`.

**The textual `appearanceTag` stays**, and is still pasted into scene prompts.
It is not redundant: it covers characters with no portrait yet, it survives a
cleared inputs directory, and reference and description reinforce rather than
fight each other. It is now the fallback rather than the mechanism.

## Consequences

**Costs.** One extra generation per character (~65 s each; two characters is
typical) plus ~11 s per scene frame. For a 7-scene video with two characters
that is roughly **+3 minutes** on a ~12-minute run — about 25%, spent entirely
on the stage that already dominates the wall clock.

**Benefits.** Identity holds across frames by construction rather than by the
model's luck in reading a description the same way twice. The textual approach
worked better than expected but was visibly imperfect: recognisably similar
people, not the same person.

**Risks.**

- **Multi-character scenes are unproven.** `-r` accepts up to 16 references,
  but whether FLUX.2 klein cleanly separates two identities in one frame is
  untested. `--increase-ref-index` exists for exactly this on
  Qwen-Image-Edit-2509; its effect on FLUX.2 is unknown. Test before trusting.
- **A bad portrait poisons every frame it appears in.** Previously a weak
  character description degraded one prompt; now a malformed portrait
  propagates. Portraits are worth reviewing before scene generation in manual
  mode.
- **sd-api's inputs directory is not viceroy's.** Uploaded names are a
  reference to state in another service. If that directory is cleared, stored
  names dangle — so a missing input must degrade to a text-only generation
  rather than failing the stage.

## Alternatives rejected

- **Textual descriptions only** (what PR3 shipped) — cheapest, no extra
  generations, and demonstrably not exact.
- **Install a dedicated edit model** (Qwen-Image-Edit, FLUX.1-Kontext) — a
  multi-gigabyte download of a slower model to get a capability the installed
  model already has.
- **Generate all scenes in one batch conditioned on a shared seed** — seeds fix
  noise, not identity, and the compositions must differ per scene anyway.
