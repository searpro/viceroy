import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { captionStyles, directionStyles, imageStyles, narrativeStyles, voiceStyles } from "./db/schema";

export const narrativeStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  plannerGuidance: z.string().trim().min(1),
  writingGuidance: z.string().trim().min(1),
  sceneGuidance: z.string().trim().min(1),
  evaluationChecklist: z
    .array(z.object({ key: z.string().trim().min(1), description: z.string().trim().min(1) }))
    .min(1, "At least one checklist item is required — it is what the evaluator is held to"),
  // No zod .default() on these: .partial() (used for PATCH) still applies a
  // field's default to a key that is simply absent from the patch, which
  // would silently overwrite it. Omitted fields fall through to the
  // column's own default in lib/db/schema.ts instead, which only fires on
  // insert.
  targetSceneCount: z.number().int().positive().optional(),
  targetWordCount: z.number().int().positive().optional(),
});
export type NarrativeStyleInput = z.infer<typeof narrativeStyleSchema>;

export const voiceStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  ttsInstruct: z.string().trim().min(1),
  deliveryCues: z.string().trim().min(1),
});
export type VoiceStyleInput = z.infer<typeof voiceStyleSchema>;

// Text register only (ADR 0002): genre/tone/pacing prose for the Development
// chain's writer, in place of a narrative style's `sceneGuidance`/checklist —
// Direction Style has no world-of-the-story or evaluation concept of its own,
// only guidance about how the writing itself should read. See the field-level
// comment on `directionStyles` in lib/db/schema.ts for why this must never be
// referenced from an image-generation prompt path.
export const directionStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  genreGuidance: z.string().trim().min(1),
  toneGuidance: z.string().trim().min(1),
  pacingGuidance: z.string().trim().min(1),
});
export type DirectionStyleInput = z.infer<typeof directionStyleSchema>;

/**
 * A diffusion prompt has no "not".
 *
 * `promptPrefix` and `promptSuffix` are concatenated verbatim onto the
 * *positive* prompt, so "no artificial CGI appearance" there asks for
 * artificial CGI — the model sees the concepts and not the refusal. The
 * built-in styles are held to this by a seed test; this holds user-authored
 * ones to it at the API boundary, which is where a style that shipped with
 * exactly that phrase got in.
 *
 * Deliberately not applied to `renderGuidance` or a narrative style's
 * `sceneGuidance`: those are read by the LLM composing a prompt, which is
 * explicitly instructed about negation and handles "avoid X" correctly.
 */
const NEGATION = /\b(no|not|without|never|avoid|excluding)\b/i;

function refuseNegations(value: string | undefined, ctx: z.RefinementCtx, field: string): void {
  const match = value?.match(NEGATION);
  if (!match) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message:
      `"${match[0]}" cannot be used here — this text is appended to the positive prompt, ` +
      `where a diffusion model reads the thing you are excluding and generates it. ` +
      `Put it in the negative prompt instead.`,
  });
}

function checkNegations(
  data: { promptPrefix?: string; promptSuffix?: string },
  ctx: z.RefinementCtx,
): void {
  refuseNegations(data.promptPrefix, ctx, "promptPrefix");
  refuseNegations(data.promptSuffix, ctx, "promptSuffix");
}

// The plain object is kept separate because zod throws — at runtime, with no
// type error to warn you — on `.partial()` applied to a schema carrying
// refinements, and PATCH needs the partial form. So both shapes are built from
// these fields rather than one being derived from the other.
const imageStyleFields = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  renderGuidance: z.string().trim().optional(),
  promptPrefix: z.string().trim().optional(),
  promptSuffix: z.string().trim().optional(),
  negativePrompt: z.string().trim().optional(),
});

export const imageStyleSchema = imageStyleFields.superRefine(checkNegations);
export const imageStylePatchSchema = imageStyleFields.partial().superRefine(checkNegations);
export type ImageStyleInput = z.infer<typeof imageStyleSchema>;

// Style fields mirror remotion/schema.ts's captionStyleSchema field-for-field
// — that is what the render pipeline and the live preview actually validate
// props against. No .default() here for the same .partial()-PATCH reason as
// every other schema in this file.
export const captionStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  fontFamily: z.string().trim().min(1).optional(),
  fontSize: z.number().int().positive().optional(),
  fontWeight: z.number().int().positive().optional(),
  color: z.string().trim().min(1).optional(),
  outlineColor: z.string().trim().min(1).optional(),
  outlineWidth: z.number().min(0).optional(),
  bottomOffset: z.number().min(0).max(1).optional(),
  uppercase: z.boolean().optional(),
});
export type CaptionStyleInput = z.infer<typeof captionStyleSchema>;

/** better-sqlite3's shape for a FOREIGN KEY constraint violation. */
function isForeignKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  );
}

export function listNarrativeStyles(db: Db) {
  return db.select().from(narrativeStyles).all();
}
export function createNarrativeStyle(db: Db, input: NarrativeStyleInput) {
  return db.insert(narrativeStyles).values(input).returning().get();
}
export function updateNarrativeStyle(db: Db, id: string, input: Partial<NarrativeStyleInput>) {
  const existing = db.select().from(narrativeStyles).where(eq(narrativeStyles.id, id)).get();
  if (!existing) throw new Error("No such narrative style");
  return db.update(narrativeStyles).set(input).where(eq(narrativeStyles.id, id)).returning().get();
}
export function deleteNarrativeStyle(db: Db, id: string): void {
  const existing = db.select().from(narrativeStyles).where(eq(narrativeStyles.id, id)).get();
  if (!existing) throw new Error("No such narrative style");
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete the built-in narrative style "${existing.name}"`);
  }
  try {
    db.delete(narrativeStyles).where(eq(narrativeStyles.id, id)).run();
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new Error(`Cannot delete "${existing.name}" — it is used by an existing project`);
    }
    throw error;
  }
}

export function listVoiceStyles(db: Db) {
  return db.select().from(voiceStyles).all();
}
export function createVoiceStyle(db: Db, input: VoiceStyleInput) {
  return db.insert(voiceStyles).values(input).returning().get();
}
export function updateVoiceStyle(db: Db, id: string, input: Partial<VoiceStyleInput>) {
  const existing = db.select().from(voiceStyles).where(eq(voiceStyles.id, id)).get();
  if (!existing) throw new Error("No such voice style");
  return db.update(voiceStyles).set(input).where(eq(voiceStyles.id, id)).returning().get();
}
export function deleteVoiceStyle(db: Db, id: string): void {
  const existing = db.select().from(voiceStyles).where(eq(voiceStyles.id, id)).get();
  if (!existing) throw new Error("No such voice style");
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete the built-in voice style "${existing.name}"`);
  }
  try {
    db.delete(voiceStyles).where(eq(voiceStyles.id, id)).run();
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new Error(`Cannot delete "${existing.name}" — it is used by an existing project`);
    }
    throw error;
  }
}

export function listImageStyles(db: Db) {
  return db.select().from(imageStyles).all();
}
export function createImageStyle(db: Db, input: ImageStyleInput) {
  return db.insert(imageStyles).values(input).returning().get();
}
export function updateImageStyle(db: Db, id: string, input: Partial<ImageStyleInput>) {
  const existing = db.select().from(imageStyles).where(eq(imageStyles.id, id)).get();
  if (!existing) throw new Error("No such image style");
  return db.update(imageStyles).set(input).where(eq(imageStyles.id, id)).returning().get();
}
export function deleteImageStyle(db: Db, id: string): void {
  const existing = db.select().from(imageStyles).where(eq(imageStyles.id, id)).get();
  if (!existing) throw new Error("No such image style");
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete the built-in image style "${existing.name}"`);
  }
  try {
    db.delete(imageStyles).where(eq(imageStyles.id, id)).run();
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new Error(`Cannot delete "${existing.name}" — it is used by an existing project`);
    }
    throw error;
  }
}

export function listDirectionStyles(db: Db) {
  return db.select().from(directionStyles).all();
}
export function createDirectionStyle(db: Db, input: DirectionStyleInput) {
  return db.insert(directionStyles).values(input).returning().get();
}
export function updateDirectionStyle(db: Db, id: string, input: Partial<DirectionStyleInput>) {
  const existing = db.select().from(directionStyles).where(eq(directionStyles.id, id)).get();
  if (!existing) throw new Error("No such direction style");
  return db.update(directionStyles).set(input).where(eq(directionStyles.id, id)).returning().get();
}
export function deleteDirectionStyle(db: Db, id: string): void {
  const existing = db.select().from(directionStyles).where(eq(directionStyles.id, id)).get();
  if (!existing) throw new Error("No such direction style");
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete the built-in direction style "${existing.name}"`);
  }
  try {
    db.delete(directionStyles).where(eq(directionStyles.id, id)).run();
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new Error(`Cannot delete "${existing.name}" — it is used by an existing project`);
    }
    throw error;
  }
}

export function listCaptionStyles(db: Db) {
  return db.select().from(captionStyles).all();
}
export function createCaptionStyle(db: Db, input: CaptionStyleInput) {
  return db.insert(captionStyles).values(input).returning().get();
}
export function updateCaptionStyle(db: Db, id: string, input: Partial<CaptionStyleInput>) {
  const existing = db.select().from(captionStyles).where(eq(captionStyles.id, id)).get();
  if (!existing) throw new Error("No such caption style");
  return db.update(captionStyles).set(input).where(eq(captionStyles.id, id)).returning().get();
}
export function deleteCaptionStyle(db: Db, id: string): void {
  const existing = db.select().from(captionStyles).where(eq(captionStyles.id, id)).get();
  if (!existing) throw new Error("No such caption style");
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete the built-in caption style "${existing.name}"`);
  }
  try {
    db.delete(captionStyles).where(eq(captionStyles.id, id)).run();
  } catch (error) {
    if (isForeignKeyError(error)) {
      throw new Error(`Cannot delete "${existing.name}" — it is used by an existing project`);
    }
    throw error;
  }
}
