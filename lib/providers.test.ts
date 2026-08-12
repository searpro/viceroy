import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { providers } from "./db/schema";
import {
  createProvider,
  deleteProvider,
  listProviders,
  updateProvider,
} from "./providers";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

const LLM_INPUT = {
  kind: "llm" as const,
  name: "Cloud LLM",
  baseUrl: "https://api.example.com",
  apiKey: "sk-secret-value",
  model: "gpt-x",
  defaultParams: {},
  isDefault: false,
};

describe("listProviders", () => {
  it("redacts the api key down to a boolean", () => {
    const created = createProvider(db, LLM_INPUT);
    expect(created).not.toHaveProperty("apiKey");
    expect(created.hasApiKey).toBe(true);

    const listed = listProviders(db).find((p) => p.id === created.id)!;
    expect(listed).not.toHaveProperty("apiKey");
    expect(listed.hasApiKey).toBe(true);

    // The real value must still be in the database, or nothing could ever use it.
    const raw = db.select().from(providers).where(eq(providers.id, created.id)).get()!;
    expect(raw.apiKey).toBe("sk-secret-value");
  });
});

describe("createProvider", () => {
  it("unsets the other llm provider's default when this one is marked default", () => {
    const seeded = db.select().from(providers).where(eq(providers.kind, "llm")).all();
    expect(seeded.filter((p) => p.isDefault)).toHaveLength(1);

    createProvider(db, { ...LLM_INPUT, isDefault: true });

    const after = db.select().from(providers).where(eq(providers.kind, "llm")).all();
    expect(after.filter((p) => p.isDefault)).toHaveLength(1);
    expect(after.find((p) => p.name === "Cloud LLM")!.isDefault).toBe(true);
  });

  it("does not touch defaults for a different kind", () => {
    createProvider(db, { ...LLM_INPUT, isDefault: true });
    const image = db.select().from(providers).where(eq(providers.kind, "image")).all();
    expect(image.filter((p) => p.isDefault)).toHaveLength(1);
  });
});

describe("updateProvider", () => {
  // The bug this guards against: zod's z.object(...).partial() still applies
  // a field's own .default() to a key that is simply missing from the patch,
  // which would silently overwrite it — the schema is written without
  // .default() specifically so this holds.
  it("leaves isDefault and defaultParams alone when a patch omits them", () => {
    const created = createProvider(db, { ...LLM_INPUT, isDefault: true, defaultParams: { temperature: 0.5 } });

    const updated = updateProvider(db, created.id, { model: "gpt-y" });

    expect(updated.model).toBe("gpt-y");
    expect(updated.isDefault).toBe(true);
    expect(updated.defaultParams).toEqual({ temperature: 0.5 });
  });

  it("promotes this provider to default and demotes its sibling", () => {
    const created = createProvider(db, LLM_INPUT);
    updateProvider(db, created.id, { isDefault: true });

    const after = db.select().from(providers).where(eq(providers.kind, "llm")).all();
    expect(after.filter((p) => p.isDefault)).toHaveLength(1);
    expect(after.find((p) => p.id === created.id)!.isDefault).toBe(true);
  });
});

describe("deleteProvider", () => {
  it("refuses to delete the only provider of a kind", () => {
    const [only] = db.select().from(providers).where(eq(providers.kind, "asr")).all();
    expect(() => deleteProvider(db, only!.id)).toThrow(/only asr provider/);
  });

  it("deletes a provider when a sibling of the same kind remains", () => {
    const created = createProvider(db, LLM_INPUT);
    deleteProvider(db, created.id);
    expect(listProviders(db).map((p) => p.id)).not.toContain(created.id);
  });
});
