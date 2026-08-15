import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { createTestDb } from "@/lib/db/testing";
import { seed } from "@/lib/db/seed";
import { assets, characters, projects } from "@/lib/db/schema";
import { createProject } from "@/lib/projects";
import { claim, listJobs, succeed } from "@/lib/queue";

// The route handler reaches its db/sd-api through module-level singletons
// (`getDb()`, `createSdApi()`), same as every other route in the app — there
// is no injected-provider seam at this layer the way pipeline stages have.
// Mocking the modules is what stands in for that seam in a route test.
const { uploadInputMock, hasInputMock } = vi.hoisted(() => ({
  uploadInputMock: vi.fn(async (_bytes: Buffer, filename: string) => `uploaded-${filename}`),
  hasInputMock: vi.fn(async () => true),
}));

let db: Db;
let close: () => void;

// `createTestDb` (used below) itself imports from this same module for
// `createSqlite`/`createDb` — a full mock would break those too, so only
// `getDb` (what the route handler calls) is overridden.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => db };
});
vi.mock("@/lib/sdapi", () => ({
  createSdApi: () => ({ image: { uploadInput: uploadInputMock, hasInput: hasInputMock } }),
}));

const { POST, DELETE } = await import("./route");

function scratchDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "viceroy-route-test-"));
}

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
  process.env.VICEROY_DATA_DIR = scratchDataDir();
  uploadInputMock.mockClear();
  hasInputMock.mockClear();
});
afterEach(() => close());

function manualProjectWithCharacter() {
  const project = createProject(db, { idea: "a plumber became mayor by wits", mode: "manual" });
  // Creating a project always queues its first stage job; settle it so the
  // fixture looks like a project that has already reached the cast step
  // (no job in flight), rather than tripping the route's own active-job guard.
  const synopsisJob = claim(db);
  if (synopsisJob) succeed(db, synopsisJob.id);

  const [character] = db
    .insert(characters)
    .values({ projectId: project.id, name: "Hal", description: "a plumber" })
    .returning()
    .all();
  return { project, character: character! };
}

function png(byte: number): File {
  return new File([new Uint8Array([byte, byte, byte])], "photo.png", { type: "image/png" });
}

function request(url: string, init: RequestInit): Request {
  return new Request(url, init);
}

describe("POST /api/projects/[id]/characters/[characterId]/image", () => {
  it("stores the upload and marks the character as user-supplied", async () => {
    const { project, character } = manualProjectWithCharacter();
    const form = new FormData();
    form.append("file", png(1));

    const response = await POST(request("http://test/upload", { method: "POST", body: form }), {
      params: Promise.resolve({ id: project.id, characterId: character.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.character.imageSource).toBe("uploaded");
    expect(body.character.refInputName).toBe("uploaded-photo.png");
    expect(body.character.imagePrompt).toBeNull();
    expect(uploadInputMock).toHaveBeenCalledTimes(1);

    const stored = db
      .select()
      .from(assets)
      .where(eq(assets.id, body.character.imageAssetId))
      .get()!;
    expect(stored.meta).toMatchObject({ characterId: character.id, source: "upload" });
    expect(fs.existsSync(stored.path)).toBe(true);
  });

  it("rejects a MIME type outside PNG/JPEG/WebP", async () => {
    const { project, character } = manualProjectWithCharacter();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "clip.gif", { type: "image/gif" }));

    const response = await POST(request("http://test/upload", { method: "POST", body: form }), {
      params: Promise.resolve({ id: project.id, characterId: character.id }),
    });

    expect(response.status).toBe(400);
    expect(uploadInputMock).not.toHaveBeenCalled();
  });

  it("rejects an upload when the project is not in manual mode", async () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits", mode: "auto" });
    const [character] = db
      .insert(characters)
      .values({ projectId: project.id, name: "Hal", description: "a plumber" })
      .returning()
      .all();
    const form = new FormData();
    form.append("file", png(1));

    const response = await POST(request("http://test/upload", { method: "POST", body: form }), {
      params: Promise.resolve({ id: project.id, characterId: character!.id }),
    });

    expect(response.status).toBe(400);
    expect(uploadInputMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/[id]/characters/[characterId]/image", () => {
  it("reverts imageSource to generated and enqueues character_images scoped to the character", async () => {
    const { project, character } = manualProjectWithCharacter();
    db.update(characters)
      .set({ imageSource: "uploaded", refInputName: "uploaded-photo.png" })
      .where(eq(characters.id, character.id))
      .run();

    const response = await DELETE(request("http://test/upload", { method: "DELETE" }), {
      params: Promise.resolve({ id: project.id, characterId: character.id }),
    });

    expect(response.status).toBe(202);
    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageSource).toBe("generated");
    expect(after.refInputName).toBeNull();

    const queued = listJobs(db, { projectId: project.id });
    const job = queued.find((j) => j.type === "character_images")!;
    expect(job).toBeTruthy();
    expect(job.payload).toMatchObject({ characterId: character.id });
  });
});
