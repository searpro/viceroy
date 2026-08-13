import { z } from "zod";
import type { Db } from "./db/client";
import { preferences } from "./db/schema";

/**
 * The only keys `createProject` actually reads. A fifth key here would sit
 * in the database looking meaningful and doing nothing — same failure shape
 * as the `runStory`-ignores-`direction` gap from M2 PR3, just for settings
 * instead of a redo button.
 */
export const PREFERENCE_KEYS = [
  "defaultNarrativeStyle",
  "defaultVoiceStyle",
  "defaultImageStyle",
  "defaultCaptionStyle",
  "defaultMode",
] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const preferenceUpdateSchema = z.object({
  key: z.enum(PREFERENCE_KEYS),
  value: z.string().trim().min(1),
});

export function listPreferences(db: Db): Partial<Record<PreferenceKey, string>> {
  const rows = db.select().from(preferences).all();
  return Object.fromEntries(
    rows
      .filter((r): r is typeof r & { key: PreferenceKey } =>
        (PREFERENCE_KEYS as readonly string[]).includes(r.key),
      )
      .map((r) => [r.key, String(r.value)]),
  );
}

export function setPreference(db: Db, key: PreferenceKey, value: string): void {
  if (key === "defaultMode" && value !== "auto" && value !== "manual") {
    throw new Error('defaultMode must be "auto" or "manual"');
  }

  db.insert(preferences)
    .values({ key, value })
    .onConflictDoUpdate({ target: preferences.key, set: { value } })
    .run();
}
