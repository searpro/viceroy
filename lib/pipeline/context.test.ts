import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { preferences, providers } from "../db/schema";
import { setPreference } from "../preferences";
import { createProject } from "../projects";
import { loadProject, requireDirectionStyle, resolveDevProvider } from "./context";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

describe("resolveDevProvider", () => {
  // The Development chain's ten stages (M7) all point at one designated
  // high-quality provider, deliberately distinct from the fast/cheap "llm"
  // default the narrative pipeline's own stages use.
  it("prefers the provider named by the defaultDevLlmProvider preference", () => {
    const [dev] = db
      .insert(providers)
      .values({ kind: "llm", name: "dev-tier", baseUrl: "http://x", model: "big-model" })
      .returning()
      .all();
    setPreference(db, "defaultDevLlmProvider", dev!.id);

    expect(resolveDevProvider(db).id).toBe(dev!.id);
  });

  it("falls back to the ordinary default llm provider when the preference is unset", () => {
    const fallback = db.select().from(providers).where(eq(providers.kind, "llm")).get()!;
    expect(resolveDevProvider(db).id).toBe(fallback.id);
  });

  it("falls back when the preference names a provider that no longer exists", () => {
    db.insert(preferences).values({ key: "defaultDevLlmProvider", value: "no-such-id" }).run();
    const fallback = db.select().from(providers).where(eq(providers.kind, "llm")).get()!;
    expect(resolveDevProvider(db).id).toBe(fallback.id);
  });

  it("does not resolve a non-llm provider even if its id is misconfigured into the preference", () => {
    const image = db.select().from(providers).where(eq(providers.kind, "image")).get()!;
    db.insert(preferences).values({ key: "defaultDevLlmProvider", value: image.id }).run();

    const fallback = db.select().from(providers).where(eq(providers.kind, "llm")).get()!;
    expect(resolveDevProvider(db).id).toBe(fallback.id);
  });
});

describe("requireDirectionStyle", () => {
  it("returns the project's resolved direction style", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits", format: "short_movie" });
    const bundle = loadProject(db, project.id);
    expect(requireDirectionStyle(bundle).id).toBe(project.directionStyleId);
  });

  it("throws for a project with no direction style — e.g. a narrative-format one", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    const bundle = loadProject(db, project.id);
    expect(() => requireDirectionStyle(bundle)).toThrow(/no direction style/);
  });
});
