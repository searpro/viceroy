import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { promptTemplates } from "../db/schema";
import { missingVariables, renderTemplate } from "./render";
import { recordPromptRender } from "./trace";

export * from "./render";
export * from "./defaults";
export * from "./trace";

/**
 * Load templates by key.
 *
 * Every key referenced by a stage is seeded, so a missing row means seeding
 * hasn't run — a setup error to surface, not a runtime edge case to degrade
 * gracefully from.
 */
export function getPromptTemplates(db: Db, keys: string[]): Record<string, string> {
  const rows = db
    .select({ key: promptTemplates.key, template: promptTemplates.template })
    .from(promptTemplates)
    .where(inArray(promptTemplates.key, keys))
    .all();

  const found = Object.fromEntries(rows.map((r) => [r.key, r.template]));
  const missing = keys.filter((key) => !(key in found));
  if (missing.length > 0) {
    throw new Error(`Missing prompt template row(s): ${missing.join(", ")} — has the seed run?`);
  }
  return found;
}

/**
 * Load one template and render it, refusing to proceed on an unfilled
 * placeholder.
 *
 * Without this check a typo'd `{{name}}` reaches the model verbatim, and on a
 * local model that costs a minute of generation before anyone notices the
 * prompt was malformed.
 */
export function renderPrompt(db: Db, key: string, vars: Record<string, string>): string {
  const template = getPromptTemplates(db, [key])[key]!;
  const missing = missingVariables(template, vars);
  if (missing.length > 0) {
    throw new Error(
      `Prompt template "${key}" references ${missing.map((m) => `{{${m}}}`).join(", ")}, ` +
        `which the caller did not supply`,
    );
  }
  const text = renderTemplate(template, vars);
  // Recorded, not returned, so no call site has to change to get its prompt
  // attributed in the trace — see lib/prompts/trace.ts for why it works this
  // way and what it costs.
  recordPromptRender({ key, vars, text });
  return text;
}
