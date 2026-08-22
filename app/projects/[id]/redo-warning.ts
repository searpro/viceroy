import type { Detail } from "./detail-types";

/**
 * The stages a redo can be scoped to, in the order one derives from the last.
 *
 * Mirrors `INVALIDATION_CHAIN` in `lib/projects.ts`, which is what actually
 * performs the deletion (ADR 0003). Kept as its own list rather than imported:
 * this module is client-side and the server list carries the discard functions
 * with it. `redo-warning.test.ts` asserts the two stay in step.
 */
export const REDO_CHAIN = [
  "synopsis",
  "story",
  "elements",
  "character_images",
  "scene_images",
  "voiceover",
  "subtitle_align",
  "render",
  // The Development chain's stages (M7 PR1). No step component calls
  // `describeRedoLoss`/`redoConfirmation` with one of these yet — PR1's
  // `DevChainCard` has no redo affordance at all — but they're listed here
  // anyway so this mirror of `INVALIDATION_CHAIN` stays exact rather than
  // silently falling out of step the day a later PR does add one.
  "concept",
  "logline",
  "story_structure",
  "beat_sheet",
  "treatment",
  "screenplay",
  "screenplay_revision",
  "story_bible",
] as const;

export type RedoTarget = (typeof REDO_CHAIN)[number];

/**
 * What a redo of `target` will actually destroy, given what this project has.
 *
 * Counted from the project rather than described in general terms: "8 scene
 * images" is a number someone can weigh against 65 seconds a frame, where
 * "downstream artifacts" is not. Anything the project does not have yet is
 * omitted, so a redo early on warns about nothing and asks nothing.
 */
export function describeRedoLoss(target: RedoTarget, detail: Detail): string[] {
  const after = REDO_CHAIN.slice(REDO_CHAIN.indexOf(target) + 1);
  const discards = (stage: RedoTarget) => after.includes(stage);
  const loss: string[] = [];

  if (discards("story") && detail.project.story) {
    loss.push("the written narration");
  }
  if (discards("elements") && detail.scenes.length > 0) {
    loss.push(`${detail.scenes.length} scene${detail.scenes.length === 1 ? "" : "s"}`);
  }
  if (discards("elements") && detail.characters.length > 0) {
    // Called out separately because it is the one loss the user cannot
    // regenerate — the pipeline can redraw a portrait, but it cannot recover a
    // photo the user chose. See ADR 0003 for why they go with the cast.
    const uploaded = detail.characters.filter((c) => c.imageSource === "uploaded").length;
    loss.push(
      `${detail.characters.length} cast member${detail.characters.length === 1 ? "" : "s"}` +
        (uploaded > 0
          ? ` — including ${uploaded} photo${uploaded === 1 ? "" : "s"} you uploaded, which cannot be recovered`
          : ""),
    );
  }
  if (discards("character_images")) {
    const portraits = detail.characters.filter((c) => c.imageAssetId).length;
    // Suppressed when the cast itself is already listed above: "3 cast members
    // and 3 portraits" reads as six things lost rather than three.
    if (portraits > 0 && !discards("elements")) {
      loss.push(`${portraits} character portrait${portraits === 1 ? "" : "s"}`);
    }
  }
  if (discards("scene_images")) {
    const images = detail.scenes.filter((s) => s.imageAssetId).length;
    if (images > 0 && !discards("elements")) {
      loss.push(`${images} scene image${images === 1 ? "" : "s"}`);
    }
  }
  if (discards("voiceover") && detail.voiceover?.audioAssetId) {
    loss.push("the recorded narration");
  }
  if (discards("subtitle_align") && detail.cues.length > 0) {
    loss.push("the caption timings");
  }
  if (discards("render") && detail.render?.status === "ready") {
    loss.push("the finished video");
  }

  return loss;
}

/** The confirmation text, or null when a redo destroys nothing worth asking about. */
export function redoConfirmation(target: RedoTarget, detail: Detail): string | null {
  const loss = describeRedoLoss(target, detail);
  if (loss.length === 0) return null;

  return (
    `Redoing this discards everything built from it:\n\n` +
    loss.map((item) => `  • ${item}`).join("\n") +
    `\n\nThey are regenerated from the new version. Continue?`
  );
}
