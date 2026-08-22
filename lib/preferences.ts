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
  // M7 PR2.
  "defaultDirectionStyle",
  // M7 PR6.
  "defaultProductionDesignStyle",
  // A provider *id*, not a name — unlike the style defaults above, "which
  // provider" is not unique by name (two "llm" rows can share one), and this
  // has to pick one specific row rather than resolve one by kind the way
  // `resolveProvider` already does. Distinct from any per-kind default: the
  // Development chain's ten stages (M7) all point at one designated
  // high-quality provider, deliberately not the fast/cheap one the narrative
  // pipeline's own LLM stages use. See `resolveDevProvider` in
  // lib/pipeline/context.ts.
  "defaultDevLlmProvider",
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
