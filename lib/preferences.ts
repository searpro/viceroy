import { z } from "zod";
import type { Db } from "./db/client";
import { preferences } from "./db/schema";
import { PROJECT_FORMATS } from "./labels";
import { ASPECT_RATIO_KEYS, RESOLUTION_KEYS } from "./resolution";

/**
 * The only keys `createProject` actually reads. A key here that nothing reads
 * would sit in the database looking meaningful and doing nothing — same
 * failure shape as the `runStory`-ignores-`direction` gap from M2 PR3, just
 * for settings instead of a redo button.
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
  // Which pipeline a new project starts in. Someone working on a movie starts
  // several in a row, and every one of them opened on the shorts form because
  // `short_video_narrative` was hardcoded as the format select's initial
  // value with no way to change it.
  "defaultFormat",
  // Shape and size. Both are per-project choices with a per-format default
  // (`defaultAspectFor`), and both are worth pinning: a machine that can only
  // comfortably render at "low" should not need that re-picked every time.
  // `defaultAspectRatio` deliberately has an "follow the format" setting —
  // stored as the absent key — because pinning one shape across formats is
  // usually not what someone means.
  "defaultAspectRatio",
  "defaultResolution",
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
  // Closed vocabularies, checked here rather than only in the form: a stored
  // value outside the set would make `resolutionPresets`/`aspectRatioValue`
  // throw at project-creation time, which is a long way from where it was set.
  if (key === "defaultResolution" && !(RESOLUTION_KEYS as readonly string[]).includes(value)) {
    throw new Error(`defaultResolution must be one of ${RESOLUTION_KEYS.join(", ")}`);
  }
  if (key === "defaultAspectRatio" && !(ASPECT_RATIO_KEYS as readonly string[]).includes(value)) {
    throw new Error(`defaultAspectRatio must be one of ${ASPECT_RATIO_KEYS.join(", ")}`);
  }
  if (key === "defaultFormat" && !PROJECT_FORMATS.some((entry) => entry.value === value)) {
    throw new Error("defaultFormat must be a known project format");
  }

  db.insert(preferences)
    .values({ key, value })
    .onConflictDoUpdate({ target: preferences.key, set: { value } })
    .run();
}
