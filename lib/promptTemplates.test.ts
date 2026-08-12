import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { promptTemplates } from "./db/schema";
import { listPromptTemplates, resetPromptTemplate, updatePromptTemplate } from "./promptTemplates";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

describe("listPromptTemplates", () => {
  it("marks every freshly-seeded template as not edited", () => {
    for (const row of listPromptTemplates(db)) {
      expect(row.isEdited).toBe(false);
    }
  });
});

describe("updatePromptTemplate", () => {
  it("saves new text and flags the row as edited", () => {
    const updated = updatePromptTemplate(db, "synopsis.generate", "A much shorter template. {{idea}}");
    expect(updated.template).toBe("A much shorter template. {{idea}}");
    expect(updated.isEdited).toBe(true);

    const listed = listPromptTemplates(db).find((r) => r.key === "synopsis.generate")!;
    expect(listed.isEdited).toBe(true);
  });

  it("refuses a template that references an undocumented variable", () => {
    expect(() =>
      updatePromptTemplate(db, "synopsis.generate", "{{idea}} but also {{nonsense}}"),
    ).toThrow(/nonsense.*is not a documented variable/);
  });

  it("refuses an unknown key", () => {
    expect(() => updatePromptTemplate(db, "no.such.key", "x")).toThrow(/No such prompt template/);
  });
});

describe("resetPromptTemplate", () => {
  it("restores the built-in text and clears the edited flag", () => {
    const original = listPromptTemplates(db).find((r) => r.key === "synopsis.generate")!.template;

    updatePromptTemplate(db, "synopsis.generate", "A much shorter template. {{idea}}");
    const reset = resetPromptTemplate(db, "synopsis.generate");

    expect(reset.template).toBe(original);
    expect(reset.isEdited).toBe(false);
  });

  // Regression: a row seeded before code added a new {{var}} to its built-in
  // template has a stale `variables` column too, not just a stale
  // `template`. Resetting must not validate the fresh built-in text against
  // that stale list — it has to replace both together.
  it("resets cleanly even when the row's own variables column is stale", () => {
    db.update(promptTemplates)
      .set({ variables: [{ name: "idea", description: "old" }] })
      .where(eq(promptTemplates.key, "synopsis.generate"))
      .run();

    const reset = resetPromptTemplate(db, "synopsis.generate");
    const builtinVariableCount = reset.variables.length;

    expect(builtinVariableCount).toBeGreaterThan(1);
    expect(reset.isEdited).toBe(false);
  });
});
