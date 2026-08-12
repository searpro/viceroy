import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { promptTemplates } from "./db/schema";
import { DEFAULT_PROMPT_TEMPLATES } from "./prompts/defaults";
import { templateVariables } from "./prompts/render";

export const promptTemplateUpdateSchema = z.object({
  template: z.string().trim().min(1),
});

const BUILTIN_BY_KEY = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.key, t]));

/**
 * Whether a row still reads exactly as seeded.
 *
 * There is no `isEdited` column: `seed()`'s `onConflictDoNothing` means the
 * built-in text this file ships is always available to diff against, so
 * "has this been edited" is a comparison, not state that could drift out of
 * sync with a flag.
 */
function withEditedFlag<T extends { key: string; template: string }>(
  row: T,
): T & { isEdited: boolean } {
  const builtin = BUILTIN_BY_KEY.get(row.key);
  return { ...row, isEdited: builtin !== undefined && builtin.template !== row.template };
}

export function listPromptTemplates(db: Db) {
  return db.select().from(promptTemplates).all().map(withEditedFlag);
}

/**
 * A template may only use `{{name}}`s it declares in `variables` — the stage
 * that renders it supplies exactly that set, so a typo'd or invented
 * placeholder would reach the model as a literal `{{like_this}}` instead of
 * failing until someone reads the output.
 */
function assertKnownVariables(template: string, declared: { name: string }[]): void {
  const known = new Set(declared.map((v) => v.name));
  const unknown = templateVariables(template).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Template references ${unknown.map((n) => `{{${n}}}`).join(", ")}, which ` +
        `${unknown.length === 1 ? "is not a documented variable" : "are not documented variables"} ` +
        `for this template — the stage that renders it will not supply ${unknown.length === 1 ? "it" : "them"}`,
    );
  }
}

export function updatePromptTemplate(db: Db, key: string, template: string) {
  const existing = db.select().from(promptTemplates).where(eq(promptTemplates.key, key)).get();
  if (!existing) throw new Error("No such prompt template");

  assertKnownVariables(template, existing.variables);

  const [updated] = db
    .update(promptTemplates)
    .set({ template })
    .where(eq(promptTemplates.key, key))
    .returning()
    .all();
  return withEditedFlag(updated!);
}

/**
 * Restore every built-in field, not just `template`.
 *
 * A plain edit validates a new template against the row's own `variables`
 * column, which is correct there — but that column can be just as stale as
 * `template` itself (seeding never updates an existing row), so resetting
 * through `updatePromptTemplate` would validate the fresh built-in text
 * against a stale variable list and could reject text this file's own
 * `template` field uses. Reset instead writes `section`/`label`/
 * `description`/`variables`/`template` together, straight from this file.
 */
export function resetPromptTemplate(db: Db, key: string) {
  const builtin = BUILTIN_BY_KEY.get(key);
  if (!builtin) throw new Error(`"${key}" is not a built-in template and cannot be reset`);

  const existing = db.select().from(promptTemplates).where(eq(promptTemplates.key, key)).get();
  if (!existing) throw new Error("No such prompt template");

  const [updated] = db
    .update(promptTemplates)
    .set({
      section: builtin.section,
      label: builtin.label,
      description: builtin.description,
      variables: builtin.variables,
      template: builtin.template,
    })
    .where(eq(promptTemplates.key, key))
    .returning()
    .all();
  return withEditedFlag(updated!);
}
