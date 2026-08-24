import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { traceCalls } from "../db/schema";
import { enqueue } from "../queue";
import { getTraceCall, listTraceCalls, traceCountsByJob, traceStages } from "./query";

let handle: { db: Db; close: () => void };
let db: Db;

beforeEach(() => {
  handle = createTestDb();
  db = handle.db;
});

afterEach(() => handle.close());

function insert(overrides: Partial<typeof traceCalls.$inferInsert> = {}) {
  const job = enqueue(db, { type: (overrides.stage as "concept") ?? "concept" });
  const [row] = db
    .insert(traceCalls)
    .values({
      jobId: job.id,
      stage: "concept",
      kind: "llm",
      operation: "chat",
      sequence: 1,
      request: { prompt: "write a concept for a lighthouse keeper" },
      response: "a written concept",
      ...overrides,
    })
    .returning()
    .all();
  return row!;
}

describe("listTraceCalls", () => {
  it("filters by kind, stage and failure", () => {
    insert({ kind: "llm", stage: "concept" });
    insert({ kind: "image", stage: "concept_art" });
    insert({ kind: "llm", stage: "logline", ok: false, error: "boom" });

    expect(listTraceCalls(db, { kind: "image" }).map((r) => r.stage)).toEqual(["concept_art"]);
    expect(listTraceCalls(db, { stage: "logline" })).toHaveLength(1);
    expect(listTraceCalls(db, { failedOnly: true }).map((r) => r.error)).toEqual(["boom"]);
    expect(listTraceCalls(db, {})).toHaveLength(3);
  });

  /**
   * The list can hold five hundred rows and a screenplay revision's response
   * alone runs to tens of kilobytes, so it carries previews. The full text
   * still has to be there when asked for by id — a trace that truncates the
   * thing being debugged is not one.
   */
  it("previews long text in the list and serves it whole from the detail", () => {
    const long = "x".repeat(5_000);
    const row = insert({ request: { prompt: long }, response: long });

    const [listed] = listTraceCalls(db, {});
    expect(listed!.promptPreview).toHaveLength(200);
    expect(listed!.responsePreview).toHaveLength(200);
    expect(listed!.responseLength).toBe(5_000);

    expect(getTraceCall(db, row.id)!.response).toBe(long);
  });

  /**
   * The two kinds keep the prompt in different places — an image request has a
   * flat `prompt`, a chat request has `messages` — and a list that previews
   * only the first shape leaves every LLM row blank, which is most of them.
   */
  it("previews a chat prompt from its last message, not just an image prompt", () => {
    insert({
      request: {
        messages: [
          { role: "system", content: "You are a screenwriter." },
          { role: "user", content: "Write a concept for a lighthouse keeper." },
        ],
      },
    });

    expect(listTraceCalls(db, {})[0]!.promptPreview).toBe("Write a concept for a lighthouse keeper.");
  });

  it("previews an empty string rather than null when the request has no prompt at all", () => {
    insert({ request: {} });
    expect(listTraceCalls(db, {})[0]!.promptPreview).toBe("");
  });

  it("attaches the owning project", () => {
    expect(listTraceCalls(db, {})[0]?.project ?? null).toBeNull();
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(getTraceCall(db, "nope")).toBeUndefined();
  });
});

describe("traceStages", () => {
  it("lists each stage once", () => {
    insert({ stage: "concept" });
    insert({ stage: "concept" });
    insert({ stage: "logline" });

    expect(traceStages(db).sort()).toEqual(["concept", "logline"]);
  });
});

describe("traceCountsByJob", () => {
  it("counts calls per job and asks nothing of an empty list", () => {
    const row = insert();
    db.insert(traceCalls)
      .values({ jobId: row.jobId, stage: "concept", kind: "llm", operation: "chat", sequence: 2 })
      .run();

    expect(traceCountsByJob(db, [row.jobId])).toEqual({ [row.jobId]: 2 });
    expect(traceCountsByJob(db, [])).toEqual({});
  });
});
