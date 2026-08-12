import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { imageStyles, narrativeStyles, voiceStyles } from "./db/schema";

export const narrativeStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  plannerGuidance: z.string().trim().min(1),
  writingGuidance: z.string().trim().min(1),
  visualGuidance: z.string().trim().min(1),
  evaluationChecklist: z
    .array(z.object({ key: z.string().trim().min(1), description: z.string().trim().min(1) }))
    .min(1, "At least one checklist item is required — it is what the evaluator is held to"),
  targetSceneCount: z.number().int().positive().default(8),
  targetWordCount: z.number().int().positive().default(320),
});
export type NarrativeStyleInput = z.infer<typeof narrativeStyleSchema>;

export const voiceStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  ttsInstruct: z.string().trim().min(1),
  deliveryCues: z.string().trim().min(1),
  model: z.string().trim().min(1).default("qwen3-tts-voicedesign"),
});
export type VoiceStyleInput = z.infer<typeof voiceStyleSchema>;

export const imageStyleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1),
  promptPrefix: z.string().trim().default(""),
  promptSuffix: z.string().trim().default(""),
  negativePrompt: z.string().trim().default(""),
  model: z.string().trim().min(1),
  defaultParams: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
});
export type ImageStyleInput = z.infer<typeof imageStyleSchema>;

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
