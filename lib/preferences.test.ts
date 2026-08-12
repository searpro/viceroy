import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { listPreferences, setPreference } from "./preferences";
import { createProject } from "./projects";
import { narrativeStyles } from "./db/schema";

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
});
