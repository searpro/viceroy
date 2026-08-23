import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { jobs as schemaJobs, projects as schemaProjects } from "../db/schema";
import {
  claim,
  enqueue,
  fail,
  getJob,
  getJobLogs,
  isAbortRequested,
  listJobs,
  log,
  reclaimStale,
  remove,
  removeFinished,
  requestAbort,
  retry,
  succeed,
} from "./index";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
});
afterEach(() => {
  close();
  vi.useRealTimers();
});

describe("enqueue and claim", () => {
  it("claims a queued job and marks it running with an attempt spent", () => {
    enqueue(db, { type: "synopsis" });
    const claimed = claim(db)!;

    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    expect(claimed.startedAt).toBeInstanceOf(Date);
  });

  it("returns nothing when the queue is empty", () => {
    expect(claim(db)).toBeUndefined();
  });

  it("hands the same job to only one claimer", () => {
    enqueue(db, { type: "synopsis" });
    expect(claim(db)).toBeDefined();
    expect(claim(db)).toBeUndefined();
  });

  it("claims in queue order", () => {
    const first = enqueue(db, { type: "synopsis" });
    enqueue(db, { type: "story" });
    expect(claim(db)!.id).toBe(first.id);
  });

  it("filters by job type so a worker can specialise", () => {
    enqueue(db, { type: "synopsis" });
    const render = enqueue(db, { type: "render" });
    expect(claim(db, ["render"])!.id).toBe(render.id);
  });

  it("does not claim a job whose runAfter is in the future", () => {
    enqueue(db, { type: "synopsis", runAfter: new Date(Date.now() + 60_000) });
    expect(claim(db)).toBeUndefined();
  });

  it("does not claim a job already flagged for abort", () => {
    const job = enqueue(db, { type: "synopsis" });
    requestAbort(db, job.id);
    expect(claim(db)).toBeUndefined();
  });
});

describe("fail", () => {
  it("re-queues with backoff while attempts remain", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 3 });
    claim(db);

    const { willRetry } = fail(db, job.id, "sd-api unreachable");

    expect(willRetry).toBe(true);
    const after = getJob(db, job.id)!;
    expect(after.status).toBe("queued");
    expect(after.error).toBe("sd-api unreachable");
    expect(after.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("backs off further on each successive attempt", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 4 });

    claim(db);
    fail(db, job.id, "one");
    const firstDelay = getJob(db, job.id)!.runAfter.getTime() - Date.now();

    // Claim again by clearing the backoff, so the second failure is measured
    // from the same starting point as the first.
    db.update(schemaJobs).set({ runAfter: new Date() }).where(eq(schemaJobs.id, job.id)).run();
    claim(db);
    fail(db, job.id, "two");
    const secondDelay = getJob(db, job.id)!.runAfter.getTime() - Date.now();

    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it("gives up once the attempt budget is spent", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 1 });
    claim(db);

    const { willRetry } = fail(db, job.id, "fatal");

    expect(willRetry).toBe(false);
    const after = getJob(db, job.id)!;
    expect(after.status).toBe("failed");
    expect(after.finishedAt).toBeInstanceOf(Date);
  });

  // An operator asking to stop is not a transient error to retry through.
  it("does not retry a job that was asked to abort", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 5 });
    claim(db);
    requestAbort(db, job.id);

    const { willRetry } = fail(db, job.id, "abandoned");

    expect(willRetry).toBe(false);
    expect(getJob(db, job.id)!.status).toBe("aborted");
  });

  it("records why it gave up", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 1 });
    claim(db);
    fail(db, job.id, "fatal");
    expect(getJobLogs(db, job.id).map((l) => l.message).join()).toMatch(/Giving up/);
  });
});

describe("abort", () => {
  it("aborts a queued job outright", () => {
    const job = enqueue(db, { type: "synopsis" });
    expect(requestAbort(db, job.id)).toEqual({ aborted: true });
    expect(getJob(db, job.id)!.status).toBe("aborted");
  });

  // A running sd-api call can't be interrupted from here; the worker has to
  // notice the flag and unwind.
  it("only flags a running job, leaving the worker to unwind", () => {
    const job = enqueue(db, { type: "synopsis" });
    claim(db);

    expect(requestAbort(db, job.id)).toEqual({ aborted: false });
    expect(getJob(db, job.id)!.status).toBe("running");
    expect(isAbortRequested(db, job.id)).toBe(true);
  });

  it("throws for an unknown job", () => {
    expect(() => requestAbort(db, "nope")).toThrow(/No such job/);
  });
});

describe("retry", () => {
  it("puts a failed job back with a fresh attempt budget", () => {
    const job = enqueue(db, { type: "synopsis", maxAttempts: 1 });
    claim(db);
    fail(db, job.id, "fatal");

    const retried = retry(db, job.id);

    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(0);
    expect(retried.error).toBeNull();
    expect(retried.finishedAt).toBeNull();
    expect(claim(db)).toBeDefined();
  });

  it("clears the abort flag so an aborted job can run again", () => {
    const job = enqueue(db, { type: "synopsis" });
    requestAbort(db, job.id);
    retry(db, job.id);
    expect(isAbortRequested(db, job.id)).toBe(false);
  });

  it("refuses to retry a job that is still queued or running", () => {
    const job = enqueue(db, { type: "synopsis" });
    expect(() => retry(db, job.id)).toThrow(/only failed or aborted/);
    claim(db);
    expect(() => retry(db, job.id)).toThrow(/only failed or aborted/);
  });
});

describe("succeed", () => {
  it("marks the job done at full progress", () => {
    const job = enqueue(db, { type: "synopsis" });
    claim(db);
    succeed(db, job.id);

    const after = getJob(db, job.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.progress).toBe(1);
    expect(after.finishedAt).toBeInstanceOf(Date);
  });
});

describe("reclaimStale", () => {
  // Without this a crashed worker strands a job in `running` forever: nothing
  // claims it and nothing times it out.
  it("re-queues jobs left running by a dead worker", () => {
    const job = enqueue(db, { type: "synopsis" });
    claim(db);

    expect(reclaimStale(db, -1)).toBe(1);
    expect(getJob(db, job.id)!.status).toBe("queued");
    expect(claim(db)).toBeDefined();
  });

  it("leaves a job that is still within its grace period alone", () => {
    enqueue(db, { type: "synopsis" });
    claim(db);
    expect(reclaimStale(db, 30 * 60_000)).toBe(0);
  });
});

describe("logs and listing", () => {
  it("keeps log lines in order for a job", () => {
    const job = enqueue(db, { type: "synopsis" });
    log(db, job.id, "first");
    log(db, job.id, "second", "warn");

    const logs = getJobLogs(db, job.id);
    expect(logs.map((l) => l.message)).toEqual(["first", "second"]);
    expect(logs[1]!.level).toBe("warn");
  });

  it("scopes a listing to one project", () => {
    const [projectA] = db
      .insert(schemaProjects)
      .values({ idea: "a" })
      .returning()
      .all();
    enqueue(db, { type: "synopsis", projectId: projectA!.id });
    enqueue(db, { type: "synopsis" });

    expect(listJobs(db, { projectId: projectA!.id })).toHaveLength(1);
    expect(listJobs(db)).toHaveLength(2);
  });

  it("deletes a job and its logs", () => {
    const job = enqueue(db, { type: "synopsis" });
    log(db, job.id, "line");
    remove(db, job.id);

    expect(getJob(db, job.id)).toBeUndefined();
    expect(getJobLogs(db, job.id)).toHaveLength(0);
  });
});

describe("removeFinished", () => {
  /**
   * One statement, not one request per row. The Jobs screen's "clear finished"
   * button used to fire a DELETE per job, which on a database with several
   * hundred of them is several hundred writers contending for one sqlite lock.
   */
  function queueOneOfEach() {
    const queued = enqueue(db, { type: "synopsis" });
    const running = enqueue(db, { type: "story" });
    const succeeded = enqueue(db, { type: "elements" });
    const failed = enqueue(db, { type: "render" });
    const aborted = enqueue(db, { type: "voiceover" });

    db.update(schemaJobs).set({ status: "running" }).where(eq(schemaJobs.id, running.id)).run();
    db.update(schemaJobs).set({ status: "succeeded" }).where(eq(schemaJobs.id, succeeded.id)).run();
    db.update(schemaJobs).set({ status: "failed" }).where(eq(schemaJobs.id, failed.id)).run();
    db.update(schemaJobs).set({ status: "aborted" }).where(eq(schemaJobs.id, aborted.id)).run();

    return { queued, running, succeeded, failed, aborted };
  }

  it("removes succeeded, failed and aborted jobs and reports how many", () => {
    const { succeeded, failed, aborted } = queueOneOfEach();
    expect(removeFinished(db)).toBe(3);
    for (const job of [succeeded, failed, aborted]) {
      expect(getJob(db, job.id)).toBeUndefined();
    }
  });

  it("never removes work the worker may be part way through", () => {
    const { queued, running } = queueOneOfEach();
    removeFinished(db);
    expect(getJob(db, queued.id)).toBeDefined();
    expect(getJob(db, running.id)).toBeDefined();
  });

  it("scopes to one project when asked, leaving other projects' history alone", () => {
    const [mine] = db.insert(schemaProjects).values({ idea: "mine" }).returning().all();
    const [theirs] = db.insert(schemaProjects).values({ idea: "theirs" }).returning().all();

    const a = enqueue(db, { type: "synopsis", projectId: mine!.id });
    const b = enqueue(db, { type: "synopsis", projectId: theirs!.id });
    db.update(schemaJobs).set({ status: "succeeded" }).run();

    expect(removeFinished(db, { projectId: mine!.id })).toBe(1);
    expect(getJob(db, a.id)).toBeUndefined();
    expect(getJob(db, b.id)).toBeDefined();
  });

  it("is a no-op on an empty queue", () => {
    expect(removeFinished(db)).toBe(0);
  });
});
