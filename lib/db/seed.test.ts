import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./testing";
import type { Db } from "./client";
import { seed } from "./seed";
import { DEFAULT_PROMPT_TEMPLATES } from "../prompts/defaults";
import { eq } from "drizzle-orm";
import { imageStyles, narrativeStyles, promptTemplates, providers, voiceStyles } from "./schema";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
});
afterEach(() => close());

describe("seed", () => {
  it("installs the built-in styles, templates and providers", () => {
    seed(db);
    expect(db.select().from(narrativeStyles).all().length).toBeGreaterThan(0);
    expect(db.select().from(voiceStyles).all().length).toBeGreaterThan(0);
    expect(db.select().from(imageStyles).all().length).toBeGreaterThan(0);
    expect(db.select().from(promptTemplates).all().length).toBeGreaterThan(0);
    expect(db.select().from(providers).all().map((p) => p.kind).sort()).toEqual([
      "asr",
      "audio",
      "image",
      "llm",
    ]);
  });

  it("is idempotent", () => {
    seed(db);
    const before = db.select().from(narrativeStyles).all().length;
    const second = seed(db);
    expect(second.inserted.narrativeStyles).toBe(0);
    expect(db.select().from(narrativeStyles).all().length).toBe(before);
  });

  // Templates are meant to be tuned; a re-seed must never revert someone's work.
  it("leaves an edited template alone", () => {
    seed(db);
    db.update(promptTemplates).set({ template: "MINE" }).run();
    seed(db);
    expect(db.select().from(promptTemplates).all().every((t) => t.template === "MINE")).toBe(true);
  });

  // BUG-022. The failure this prevents was silent for the life of the project:
  // VIC-003 added {{groundingInstruction}} to the story-content templates, and
  // no existing install ever received it, so Context mode's grounding clause
  // was passed to renderPrompt and dropped for every project. Nothing errored
  // — a supplied-but-unused variable is legal — and no test caught it, because
  // tests seed a fresh database where library and rows agree by construction.
  it("upgrades an untouched template when the built-in library moves on", () => {
    seed(db);
    // Simulate a row seeded from an older library: both columns hold the old
    // text, which is what "unedited, but stale" actually looks like on disk.
    db.update(promptTemplates)
      .set({ template: "OLD BUILT-IN", builtinTemplate: "OLD BUILT-IN" })
      .where(eq(promptTemplates.key, "story.write"))
      .run();

    seed(db);

    const row = db.select().from(promptTemplates).where(eq(promptTemplates.key, "story.write")).get()!;
    const builtin = DEFAULT_PROMPT_TEMPLATES.find((t) => t.key === "story.write")!;
    expect(row.template).toBe(builtin.template);
    expect(row.builtinTemplate).toBe(builtin.template);
    expect(row.template).toContain("{{groundingInstruction}}");
  });

  it("leaves an edited template alone even when its built-in has moved on", () => {
    seed(db);
    db.update(promptTemplates)
      .set({ template: "MY OWN WORDING", builtinTemplate: "OLD BUILT-IN" })
      .where(eq(promptTemplates.key, "story.write"))
      .run();

    seed(db);

    const row = db.select().from(promptTemplates).where(eq(promptTemplates.key, "story.write")).get()!;
    expect(row.template).toBe("MY OWN WORDING");
    expect(row.builtinTemplate).toBe("OLD BUILT-IN");
  });

  // Without this the upgrade is a one-shot: a row upgraded once would look
  // edited forever after and never receive the next improvement.
  it("re-baselines an upgraded row so it stays eligible for the next change", () => {
    seed(db);
    seed(db);
    const rows = db.select().from(promptTemplates).all();
    expect(rows.every((r) => r.template === r.builtinTemplate)).toBe(true);
  });

  // BUG-012: `onConflictDoNothing` also froze `variables`, so a correction to
  // the built-in library never reached an existing install — which is how
  // `character.portrait` went on advertising a withdrawn variable in the
  // editor long after it was removed here.
  it("refreshes the declared variables of a template nobody has edited", () => {
    seed(db);
    db.update(promptTemplates)
      .set({ variables: [{ name: "stale", description: "no longer supplied" }] })
      .where(eq(promptTemplates.key, "character.portrait"))
      .run();

    seed(db);

    const row = db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.key, "character.portrait"))
      .get()!;
    expect(row.variables.map((v) => v.name)).not.toContain("stale");
    expect(row.variables.map((v) => v.name)).not.toContain("characterName");
  });

  it("does not refresh metadata on a template that has been edited", () => {
    seed(db);
    db.update(promptTemplates)
      .set({ template: "MINE", variables: [{ name: "mine", description: "my own" }] })
      .where(eq(promptTemplates.key, "character.portrait"))
      .run();

    seed(db);

    const row = db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.key, "character.portrait"))
      .get()!;
    expect(row.variables.map((v) => v.name)).toEqual(["mine"]);
  });
});

/**
 * A diffusion prompt has no negation. Text that reaches the *positive* prompt
 * saying "no fantasy elements" asks for fantasy elements — observed leaking
 * out of a narrative style's visual guidance and into a generated scene
 * prompt verbatim. Negatives belong in the image style's `negativePrompt`,
 * which is passed separately.
 */
describe("built-in text destined for image prompts", () => {
  const NEGATION = /\b(no|not|without|never|avoid|excluding)\b/i;

  it("has no negations in any narrative style's scene guidance", () => {
    seed(db);
    for (const style of db.select().from(narrativeStyles).all()) {
      expect(
        style.sceneGuidance,
        `${style.name} scene guidance must state only what IS in frame`,
      ).not.toMatch(NEGATION);
    }
  });

  // `renderGuidance` reaches the LLM rather than the diffusion model directly,
  // so a negation here is not immediately fatal — but the model composing the
  // prompt copies phrasing it is given, and a copied "not illustrated" lands
  // in a positive prompt asking for illustration.
  it("has no negations in any image style's render guidance", () => {
    seed(db);
    for (const style of db.select().from(imageStyles).all()) {
      expect(style.renderGuidance, `${style.name} render guidance`).not.toMatch(NEGATION);
    }
  });

  it("has no negations in any image style's prefix or suffix", () => {
    seed(db);
    for (const style of db.select().from(imageStyles).all()) {
      expect(style.promptPrefix, `${style.name} prefix`).not.toMatch(NEGATION);
      expect(style.promptSuffix, `${style.name} suffix`).not.toMatch(NEGATION);
    }
  });

  it("still expresses exclusions, in the image provider's negative prompt where they work", () => {
    seed(db);
    const imageProvider = db.select().from(providers).where(eq(providers.kind, "image")).get()!;
    expect(imageProvider.negativePrompt.length).toBeGreaterThan(0);
  });
});
