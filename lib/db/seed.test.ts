import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./testing";
import type { Db } from "./client";
import { seed } from "./seed";
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

  it("has no negations in any narrative style's visual guidance", () => {
    seed(db);
    for (const style of db.select().from(narrativeStyles).all()) {
      expect(
        style.visualGuidance,
        `${style.name} visual guidance must state only what IS in frame`,
      ).not.toMatch(NEGATION);
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
