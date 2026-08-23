import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { listPreferences, setPreference } from "./preferences";
import { createProject } from "./projects";
import { directionStyles, narrativeStyles, productionDesignStyles } from "./db/schema";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

describe("listPreferences", () => {
  it("returns the seeded defaults", () => {
    const prefs = listPreferences(db);
    expect(prefs.defaultMode).toBe("auto");
    expect(prefs.defaultNarrativeStyle).toBeTruthy();
    expect(prefs.defaultCaptionStyle).toBeTruthy();
  });
});

describe("setPreference", () => {
  it("overwrites an existing key rather than erroring on conflict", () => {
    setPreference(db, "defaultMode", "manual");
    expect(listPreferences(db).defaultMode).toBe("manual");
  });

  it("refuses a defaultMode value that isn't auto or manual", () => {
    expect(() => setPreference(db, "defaultMode", "sometimes")).toThrow(
      /must be "auto" or "manual"/,
    );
  });

  it("changes which narrative style a new project resolves to by default", () => {
    const other = db.select().from(narrativeStyles).all()[1]!;
    setPreference(db, "defaultNarrativeStyle", other.name);

    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    expect(project.narrativeStyleId).toBe(other.id);
  });

  // M7 PR2.
  it("changes which direction style a new dev-format project resolves to by default", () => {
    const other = db.select().from(directionStyles).all()[1]!;
    setPreference(db, "defaultDirectionStyle", other.name);

    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    expect(project.directionStyleId).toBe(other.id);
  });

  it("accepts a defaultDevLlmProvider value (a provider id, not a name)", () => {
    setPreference(db, "defaultDevLlmProvider", "some-provider-id");
    expect(listPreferences(db).defaultDevLlmProvider).toBe("some-provider-id");
  });

  // The three keys the Preferences screen gained so a movie project's defaults
  // could be set at all. Each names a closed vocabulary, and each is checked
  // here rather than only in the form — a value stored outside its set makes
  // `resolutionPresets`/`aspectRatioValue` throw at project-creation time,
  // which is a long way from the control that set it.
  it("accepts and refuses defaultResolution against the preset list", () => {
    setPreference(db, "defaultResolution", "draft");
    expect(listPreferences(db).defaultResolution).toBe("draft");
    expect(() => setPreference(db, "defaultResolution", "imax")).toThrow(/defaultResolution must be/);
  });

  it("accepts and refuses defaultAspectRatio against the ratio list", () => {
    setPreference(db, "defaultAspectRatio", "2.39:1");
    expect(listPreferences(db).defaultAspectRatio).toBe("2.39:1");
    expect(() => setPreference(db, "defaultAspectRatio", "21:9")).toThrow(/defaultAspectRatio must be/);
  });

  it("accepts and refuses defaultFormat against the format list", () => {
    setPreference(db, "defaultFormat", "short_movie");
    expect(listPreferences(db).defaultFormat).toBe("short_movie");
    expect(() => setPreference(db, "defaultFormat", "podcast")).toThrow(/defaultFormat must be/);
  });

  it("changes which production design style a new movie resolves to by default", () => {
    const other = db.select().from(productionDesignStyles).all()[1]!;
    setPreference(db, "defaultProductionDesignStyle", other.name);

    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    expect(project.productionDesignStyleId).toBe(other.id);
  });
});
