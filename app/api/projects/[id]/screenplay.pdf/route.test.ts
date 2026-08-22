import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { createTestDb } from "@/lib/db/testing";
import { seed } from "@/lib/db/seed";
import { devArtifacts } from "@/lib/db/schema";
import { createProject } from "@/lib/projects";
import { claim, listJobs } from "@/lib/queue";

let db: Db;
let close: () => void;

// Same seam as app/api/projects/[id]/characters/[characterId]/image/route.test.ts
// — the route reaches its db through the module-level `getDb()` singleton, so
// mocking that module is what stands in for dependency injection at this layer.
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => db };
});

const { GET } = await import("./route");

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

function newDevProject() {
  const project = createProject(db, {
    idea: "a locksmith who can't lock her own door",
    format: "short_movie",
    mode: "auto",
  });
  // Nothing generates on creation for a dev-format project (PR1) — clear the
  // queue so this fixture starts quiet, same as dev.test.ts's own helper.
  for (const _job of listJobs(db, { projectId: project.id })) claim(db);
  return project;
}

const VALID_SCREENPLAY = `INT. REYNA'S SHOP - DAY

Reyna bends over a half-fixed lock.

REYNA
Almost.
`;

function request(url: string): Request {
  return new Request(url);
}

describe("GET /api/projects/[id]/screenplay.pdf", () => {
  it("returns a PDF for a project with an approved screenplay", async () => {
    const project = newDevProject();
    db.insert(devArtifacts)
      .values({
        projectId: project.id,
        stage: "screenplay",
        version: 1,
        content: VALID_SCREENPLAY,
        approvedAt: new Date(),
      })
      .run();

    const response = await GET(request("http://test/screenplay.pdf"), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("errors cleanly when the project has no approved screenplay yet", async () => {
    const project = newDevProject();

    const response = await GET(request("http://test/screenplay.pdf"), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/no approved screenplay/i);
  });

  it("errors cleanly when the screenplay draft exists but hasn't been approved yet", async () => {
    const project = newDevProject();
    db.insert(devArtifacts)
      .values({
        projectId: project.id,
        stage: "screenplay",
        version: 1,
        content: VALID_SCREENPLAY,
        approvedAt: null,
      })
      .run();

    const response = await GET(request("http://test/screenplay.pdf"), {
      params: Promise.resolve({ id: project.id }),
    });

    expect(response.status).toBe(404);
  });

  it("404s for a project that doesn't exist", async () => {
    const response = await GET(request("http://test/screenplay.pdf"), {
      params: Promise.resolve({ id: "no-such-project" }),
    });

    expect(response.status).toBe(404);
  });
});
