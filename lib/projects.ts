import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { resolveConfig } from "./config";
import type { Db } from "./db/client";
import {
  captionStyles,
  characters,
  DEV_CHAIN_STAGES,
  devArtifacts,
  directionStyles,
  evaluations,
  imageStyles,
  locations,
  narrativeStyles,
  preferences,
  PROJECT_FORMATS,
  projects,
  props,
  renders,
  scenes,
  subtitleCues,
  voiceovers,
  voiceStyles,
  worldBuilding,
  type DevArtifactStage,
} from "./db/schema";
import { enqueue, listJobs } from "./queue";
import { advance, isStalled, nextStep } from "./pipeline/chain";
import { RESOLUTION_KEYS, resolvePresetDimensions } from "./resolution";

// A sane UX ceiling, not a measured model token-budget limit (Finding F10
// covers the actual, model-dependent context window) — see VIC-003.
const CONTEXT_MAX = 8000;

export const createProjectSchema = z
  .object({
    // Deliberately not named `mode` — `mode` already means the auto/manual
    // review cadence below. This chooses where the story's facts come from.
    inputMode: z.enum(["idea", "context"]).default("idea"),
    idea: z.string().trim().max(2000).optional(),
    context: z.string().trim().max(CONTEXT_MAX).optional(),
    // Defaulted to today's only format, so every existing caller/test that
    // never mentions this field keeps starting the narrative pipeline.
    format: z.enum(PROJECT_FORMATS).default("short_video_narrative"),
    narrativeStyleId: z.string().optional(),
    voiceStyleId: z.string().optional(),
    imageStyleId: z.string().optional(),
    captionStyleId: z.string().optional(),
    directionStyleId: z.string().optional(),
    resolutionKey: z.enum(RESOLUTION_KEYS).optional(),
    mode: z.enum(["auto", "manual"]).default("auto"),
  })
  .superRefine((data, ctx) => {
    if (data.inputMode === "idea") {
      if (!data.idea || data.idea.length < 8) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idea"],
          message: "Give the idea a little more to work with",
        });
      }
    } else if (!data.context || data.context.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context"],
        message: "Paste in more context to work with",
      });
    }
  });

// `z.input` rather than `z.infer`, so callers may omit anything with a default
// — the function parses what it is given rather than trusting it.
export type CreateProjectInput = z.input<typeof createProjectSchema>;

function preferenceValue(db: Db, key: string): string | undefined {
  const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
  return typeof row?.value === "string" ? row.value : undefined;
}

/**
 * Resolve a style, falling back to the configured default and then to whatever
 * exists.
 *
 * The last fallback matters: a fresh install with seeded styles but no
 * preferences should still be able to start a project rather than erroring on
 * a lookup the user never knew they had to make.
 */
function resolveStyle<T extends { id: string; name: string }>(
  rows: T[],
  explicitId: string | undefined,
  defaultName: string | undefined,
  label: string,
): T {
  if (explicitId) {
    const found = rows.find((r) => r.id === explicitId);
    if (!found) throw new Error(`No such ${label}: ${explicitId}`);
    return found;
  }
  const byName = defaultName ? rows.find((r) => r.name === defaultName) : undefined;
  const chosen = byName ?? rows[0];
  if (!chosen) throw new Error(`No ${label} exists — has the seed run?`);
  return chosen;
}

/** A short caller-facing label for a Context-mode project's `idea`/`title`. */
function shortLabel(context: string): string {
  const firstLine = context.trim().split("\n")[0]!.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

export function createProject(db: Db, raw: CreateProjectInput) {
  const input = createProjectSchema.parse(raw);
  const narrative = resolveStyle(
    db.select().from(narrativeStyles).all(),
    input.narrativeStyleId,
    preferenceValue(db, "defaultNarrativeStyle"),
    "narrative style",
  );
  const voice = resolveStyle(
    db.select().from(voiceStyles).all(),
    input.voiceStyleId,
    preferenceValue(db, "defaultVoiceStyle"),
    "voice style",
  );
  const image = resolveStyle(
    db.select().from(imageStyles).all(),
    input.imageStyleId,
    preferenceValue(db, "defaultImageStyle"),
    "image style",
  );
  const caption = resolveStyle(
    db.select().from(captionStyles).all(),
    input.captionStyleId,
    preferenceValue(db, "defaultCaptionStyle"),
    "caption style",
  );
  // Only the Development chain (M7 PR2) reads a direction style — the
  // narrative pipeline never does, so a narrative-format project leaves this
  // null rather than forcing every existing caller to resolve a style it has
  // no use for.
  const direction =
    input.format === "short_video_narrative"
      ? undefined
      : resolveStyle(
          db.select().from(directionStyles).all(),
          input.directionStyleId,
          preferenceValue(db, "defaultDirectionStyle"),
          "direction style",
        );
  const resolution = resolvePresetDimensions(resolveConfig(), input.resolutionKey);

  // `idea` stays NOT NULL either way — rather than a nullability change, a
  // Context-mode project gets a short label derived from its context, which
  // doubles as `title` for the list/job views that already fall back to it.
  const isContext = input.inputMode === "context";
  const label = isContext ? shortLabel(input.context!) : input.idea!;

  const [project] = db
    .insert(projects)
    .values({
      idea: label,
      title: isContext ? label : null,
      inputMode: input.inputMode,
      context: isContext ? input.context : null,
      format: input.format,
      mode: input.mode,
      narrativeStyleId: narrative.id,
      voiceStyleId: voice.id,
      imageStyleId: image.id,
      captionStyleId: caption.id,
      directionStyleId: direction?.id,
      width: resolution.width,
      height: resolution.height,
    })
    .returning()
    .all();

  // The narrative pipeline starts itself off with a synopsis job; the
  // Development chain has no generation logic yet (PR2+), so a dev-format
  // project is created with an empty chain and nothing queued — `nextStep`
  // reports its first stage, "concept", with no job behind it yet.
  if (input.format === "short_video_narrative") {
    enqueue(db, { type: "synopsis", projectId: project!.id });
  }
  return project!;
}

export function listProjects(db: Db) {
  return db.select().from(projects).orderBy(desc(projects.createdAt)).limit(50).all();
}

/**
 * Every job across every project, newest first, each carrying enough of its
 * project to be identifiable without a second round trip per row.
 *
 * A plain join would return the same handful of project rows once per job;
 * fetching the distinct set separately and merging in JS is simpler than
 * writing that join and costs nothing extra since the project count is
 * always far smaller than the job count.
 */
export function listAllJobs(db: Db, opts: { limit?: number } = {}) {
  const jobRows = listJobs(db, { limit: opts.limit ?? 200 }).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const projectIds = [...new Set(jobRows.map((j) => j.projectId).filter((id): id is string => !!id))];
  const projectRows =
    projectIds.length > 0
      ? db
          .select({ id: projects.id, idea: projects.idea, title: projects.title })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
      : [];
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  return jobRows.map((job) => ({
    ...job,
    project: job.projectId ? (projectById.get(job.projectId) ?? null) : null,
  }));
}

export function getProjectDetail(db: Db, projectId: string) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return undefined;

  return {
    project,
    narrativeStyle: project.narrativeStyleId
      ? db.select().from(narrativeStyles).where(eq(narrativeStyles.id, project.narrativeStyleId)).get()
      : undefined,
    voiceStyle: project.voiceStyleId
      ? db.select().from(voiceStyles).where(eq(voiceStyles.id, project.voiceStyleId)).get()
      : undefined,
    evaluations: db
      .select()
      .from(evaluations)
      .where(eq(evaluations.projectId, projectId))
      .orderBy(desc(evaluations.iteration))
      .all(),
    scenes: db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.index))
      .all(),
    characters: db.select().from(characters).where(eq(characters.projectId, projectId)).all(),
    voiceover: db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get(),
    render: db
      .select()
      .from(renders)
      .where(eq(renders.projectId, projectId))
      .orderBy(desc(renders.createdAt))
      .get(),
    cues: db
      .select()
      .from(subtitleCues)
      .where(eq(subtitleCues.projectId, projectId))
      .orderBy(asc(subtitleCues.index))
      .all(),
    jobs: listJobs(db, { projectId }),
    nextStep: nextStep(db, projectId),
    stalled: isStalled(db, projectId),
    // The Development chain (M7) has no per-stage review UI yet — everything
    // it's generated is otherwise invisible once the chain reaches its
    // terminal "complete" state, since the chain-status card only ever shows
    // the *next* stage. Latest version per stage, since a stage can have more
    // than one (a redo keeps history rather than deleting it, per ADR 0003).
    devArtifacts: latestDevArtifactsByStage(db, projectId),
    worldBuilding: db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get(),
    locations: db.select().from(locations).where(eq(locations.projectId, projectId)).all(),
    props: db.select().from(props).where(eq(props.projectId, projectId)).all(),
  };
}

function latestDevArtifactsByStage(db: Db, projectId: string) {
  const all = db
    .select()
    .from(devArtifacts)
    .where(eq(devArtifacts.projectId, projectId))
    .orderBy(desc(devArtifacts.version))
    .all();
  const latestByStage = new Map<string, (typeof all)[number]>();
  for (const row of all) {
    if (!latestByStage.has(row.stage)) latestByStage.set(row.stage, row);
  }
  return DEV_CHAIN_STAGES.map((stage) => latestByStage.get(stage)).filter((row) => row !== undefined);
}

/** Approve what is there and queue whatever is outstanding. */
export function continueProject(db: Db, projectId: string) {
  return advance(db, projectId);
}

export const regenerateSchema = z.object({
  target: z.enum([
    "synopsis",
    "story",
    "elements",
    "character_images",
    "scene_images",
    "voiceover",
    "subtitle_align",
    "render",
    // The Development chain's stages, in `DEV_CHAIN_STAGES` order (M7 PR1
    // laid out `DEV_ARTIFACT_STAGES`; PR2 adds "characters" and
    // "world_building" between "logline" and "story_structure" — see
    // `DEV_CHAIN_STAGES` in lib/db/schema.ts). Valid only for a project whose
    // format is not `short_video_narrative` — enforced in `regenerate` below,
    // not here, since the schema alone doesn't know which project it's
    // parsing for.
    ...DEV_CHAIN_STAGES,
  ]),
  direction: z.string().trim().max(2000).optional(),
  /** Voice-design cues, when re-narrating with a different delivery. */
  ttsInstruct: z.string().trim().max(1000).optional(),
  /** Scopes an "elements" or "scene_images" redo to one scene. */
  sceneId: z.string().optional(),
  /** Scopes a "character_images" redo to one character. */
  characterId: z.string().optional(),
});

/**
 * The pipeline's artifacts, in the order one derives from the last.
 *
 * A redo of any stage invalidates everything *after* it here. Deriving that
 * from one ordered list, rather than a per-target `if` per stage, is what stops
 * the next target added to `regenerateSchema` from quietly reintroducing
 * BUG-002's class of failure: a resumable stage skips artifacts a redo forgot
 * to clear, and the pipeline finishes a video assembled from two different
 * stories. Nothing errors, because each half is internally consistent.
 */
export const INVALIDATION_CHAIN = [
  "synopsis",
  "story",
  "elements",
  "character_images",
  "scene_images",
  "voiceover",
  "subtitle_align",
  "render",
  // The Development chain's stages, appended in `DEV_CHAIN_STAGES` order —
  // the chain's full ten-stage ordering (M7 PR2), not just the eight that own
  // a `dev_artifacts` row. A project is only ever one format or the other, so
  // in practice a redo only ever walks the half of this list its own format
  // populated — but the two chains still share one array on purpose, per the
  // type-safety trick this file is built around (see the comment above).
  ...DEV_CHAIN_STAGES,
] as const;

type InvalidationStage = (typeof INVALIDATION_CHAIN)[number];

/**
 * Discard one stage's own output.
 *
 * Rows are deleted or nulled; the underlying asset files are left alone, since
 * `assets` rows are shared and reaped separately.
 */
const DISCARD: Record<InvalidationStage, (db: Db, projectId: string) => void> = {
  synopsis: (db, projectId) => {
    db.update(projects).set({ synopsis: null }).where(eq(projects.id, projectId)).run();
  },
  story: (db, projectId) => {
    db.update(projects).set({ story: null }).where(eq(projects.id, projectId)).run();
    db.delete(evaluations).where(eq(evaluations.projectId, projectId)).run();
  },
  // Scenes and the cast are one stage's output (`runElements` produces both)
  // and must go together: keeping the cast while regrouping scenes leaves
  // characters extracted from a story that no longer exists being pasted into
  // every new scene prompt. A user-uploaded portrait is lost with its
  // character — the story it belonged to is gone, so the reference no longer
  // depicts anyone in this project.
  elements: (db, projectId) => {
    db.delete(scenes).where(eq(scenes.projectId, projectId)).run();
    db.delete(characters).where(eq(characters.projectId, projectId)).run();
  },
  character_images: (db, projectId) => {
    db.update(characters)
      .set({ imageAssetId: null, imagePrompt: null, refInputName: null, imageSource: "generated" })
      .where(eq(characters.projectId, projectId))
      .run();
  },
  scene_images: (db, projectId) => {
    db.update(scenes).set({ imageAssetId: null }).where(eq(scenes.projectId, projectId)).run();
  },
  // Nulled rather than deleted, to keep `ttsInstruct`: a user who redirected
  // the delivery ("less breathy, slower") set that on the voiceover row, and
  // `runVoiceover` reads it back to prefer their cues over the voice style's.
  // Deleting the row would silently revert them to the style default.
  voiceover: (db, projectId) => {
    db.update(voiceovers)
      .set({ audioAssetId: null, durationMs: null, sampleRate: null })
      .where(eq(voiceovers.projectId, projectId))
      .run();
  },
  subtitle_align: (db, projectId) => {
    db.delete(subtitleCues).where(eq(subtitleCues.projectId, projectId)).run();
    db.update(scenes)
      .set({ startMs: null, endMs: null })
      .where(eq(scenes.projectId, projectId))
      .run();
  },
  render: (db, projectId) => {
    db.delete(renders).where(eq(renders.projectId, projectId)).run();
  },
  // Every dev-artifact stage discards the same way: cleared, not deleted, so
  // `directionHistory` survives a redo (unlike the narrative stages above,
  // there's no downstream row shape to also clean up yet — PR3+ builds the
  // stages that would derive from these).
  concept: devArtifactDiscard("concept"),
  logline: devArtifactDiscard("logline"),
  // Mirrors `elements` above: the whole cast is this stage's own output, so a
  // redo clears it wholesale rather than leaving arcs/characters extracted
  // from a concept/logline that redoing "characters" itself is about to
  // replace. `charactersDirectionHistory` survives (see the schema comment),
  // the same way `dev_artifacts.directionHistory` survives its own discard.
  characters: (db, projectId) => {
    db.delete(characters).where(eq(characters.projectId, projectId)).run();
    db.update(projects).set({ charactersApprovedAt: null }).where(eq(projects.id, projectId)).run();
  },
  // ADR 0003's "scenes and cast are one unit" reasoning extends here: a world
  // and the locations/props derived from it are one stage's output.
  // Redoing "world_building" cascade-deletes `locations`/`props` along with
  // the `world_building` row itself, consistent with `elements` clearing
  // `scenes`+`characters` together above, rather than leaving locations that
  // named a world this redo is about to replace.
  world_building: (db, projectId) => {
    db.delete(locations).where(eq(locations.projectId, projectId)).run();
    db.delete(props).where(eq(props.projectId, projectId)).run();
    db.update(worldBuilding)
      .set({ content: "", approvedAt: null })
      .where(eq(worldBuilding.projectId, projectId))
      .run();
  },
  story_structure: devArtifactDiscard("story_structure"),
  beat_sheet: devArtifactDiscard("beat_sheet"),
  treatment: devArtifactDiscard("treatment"),
  screenplay: devArtifactDiscard("screenplay"),
  // Also clears the revision loop's evaluation history — same reasoning as
  // "story" above clearing `evaluations` on its own redo: a fresh run of the
  // loop should judge only its own attempts, not carry an iteration count
  // (and QC-threshold budget) left over from a run against a screenplay this
  // redo is about to replace.
  screenplay_revision: (db, projectId) => {
    devArtifactDiscard("screenplay_revision")(db, projectId);
    db.delete(evaluations).where(eq(evaluations.projectId, projectId)).run();
  },
  story_bible: devArtifactDiscard("story_bible"),
};

/** `DISCARD`'s handler for one dev-artifact stage, covering every version. */
function devArtifactDiscard(stage: DevArtifactStage) {
  return (db: Db, projectId: string) => {
    db.update(devArtifacts)
      .set({ approvedAt: null, content: "" })
      .where(and(eq(devArtifacts.projectId, projectId), eq(devArtifacts.stage, stage)))
      .run();
  };
}

/**
 * Clear every artifact derived from `target`'s output, leaving `target`'s own
 * output alone — the stage about to run overwrites that itself.
 */
export function invalidateDownstreamOf(db: Db, projectId: string, target: InvalidationStage): void {
  const from = INVALIDATION_CHAIN.indexOf(target);
  for (const stage of INVALIDATION_CHAIN.slice(from + 1)) {
    DISCARD[stage]!(db, projectId);
  }
}

/**
 * Re-run one stage, optionally under a user's direction.
 *
 * Clears `awaitingReview` so the project is live again — otherwise a project
 * parked for review would stay flagged while a job for it was already running.
 *
 * A `sceneId`/`characterId` scopes the redo to one row rather than the whole
 * stage: its existing artifact is cleared first, which is what makes it the
 * only thing the stage's own "skip what's already there" logic picks up. A
 * scoped redo deliberately does *not* cascade — it is a request to redraw one
 * frame, not to rebuild the project from that point down.
 */
export function regenerate(db: Db, projectId: string, input: z.infer<typeof regenerateSchema>) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No such project: ${projectId}`);

  // A dev-artifact target only means anything for a project that is actually
  // running the Development chain — accepting it for a narrative project
  // would enqueue a job type nothing in the narrative pipeline expects, and
  // clear a `dev_artifacts` row that project will never populate.
  if (
    (DEV_CHAIN_STAGES as readonly string[]).includes(input.target) &&
    project.format === "short_video_narrative"
  ) {
    throw new Error(
      `"${input.target}" is a Development-chain stage — not valid for a short_video_narrative project`,
    );
  }

  const scoped = input.sceneId ?? input.characterId;

  if (!scoped) {
    invalidateDownstreamOf(db, projectId, input.target);
  }

  if (input.target === "elements" && input.sceneId) {
    // The image belongs to the prompt that produced it: leaving it in place
    // means the new prompt is written, every scene still has an image, and
    // `nextStep` walks straight past `scene_images` — so the redo the user
    // asked for never reaches the frame they were looking at.
    db.update(scenes)
      .set({ imagePrompt: null, storyboard: null, imageAssetId: null })
      .where(eq(scenes.id, input.sceneId))
      .run();
  }
  if (input.target === "scene_images" && input.sceneId) {
    db.update(scenes).set({ imageAssetId: null }).where(eq(scenes.id, input.sceneId)).run();
  }
  if (input.target === "character_images" && input.characterId) {
    // A redo on a previously-uploaded character (a "revert to generated")
    // must clear imageSource back to its default too, or the character would
    // keep looking "uploaded" — and stay excluded from character_images'
    // pending filter — even after its upload was discarded.
    db.update(characters)
      .set({ imageAssetId: null, imagePrompt: null, refInputName: null, imageSource: "generated" })
      .where(eq(characters.id, input.characterId))
      .run();
  }

  db.update(projects)
    .set({ awaitingReview: false, failureReason: null })
    .where(eq(projects.id, projectId))
    .run();

  return enqueue(db, {
    type: input.target,
    projectId,
    payload: {
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.ttsInstruct ? { ttsInstruct: input.ttsInstruct } : {}),
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
      ...(input.characterId ? { characterId: input.characterId } : {}),
    },
  });
}
