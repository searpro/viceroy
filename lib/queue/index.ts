import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobLogs, jobs, type JobType } from "../db/schema";

export type Job = typeof jobs.$inferSelect;

export type EnqueueInput = {
  type: JobType;
  projectId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
};

export function enqueue(db: Db, input: EnqueueInput): Job {
  const [job] = db
    .insert(jobs)
    .values({
      type: input.type,
      projectId: input.projectId ?? null,
      payload: input.payload ?? {},
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? new Date(),
    })
    .returning()
    .all();
  return job!;
}

/**
 * Atomically take one runnable job.
 *
 * The SELECT and the UPDATE have to be one transaction or two workers can read
 * the same queued row before either writes. better-sqlite3 is synchronous, so
 * nothing can interleave inside the callback within a process — but a second
 * *process* still can, which is what BEGIN IMMEDIATE (drizzle's default
 * behaviour here) guards against.
 */
export function claim(db: Db, types?: JobType[]): Job | undefined {
  return db.transaction((tx) => {
    const now = new Date();
    const candidate = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          lte(jobs.runAfter, now),
          eq(jobs.abortRequested, false),
          types && types.length > 0 ? inArray(jobs.type, types) : undefined,
        ),
      )
      .orderBy(asc(jobs.runAfter), asc(jobs.createdAt))
      .limit(1)
      .get();

    if (!candidate) return undefined;

    const [claimed] = tx
      .update(jobs)
      .set({
        status: "running",
        startedAt: now,
        attempts: sql`${jobs.attempts} + 1`,
        progress: 0,
        error: null,
      })
      .where(eq(jobs.id, candidate.id))
      .returning()
      .all();

    return claimed;
  });
}

export function reportProgress(db: Db, jobId: string, progress: number): void {
  db.update(jobs)
    .set({ progress: Math.max(0, Math.min(1, progress)) })
    .where(eq(jobs.id, jobId))
    .run();
}

export function setExternalJobId(db: Db, jobId: string, externalJobId: string | null): void {
  db.update(jobs).set({ externalJobId }).where(eq(jobs.id, jobId)).run();
}

export function log(
  db: Db,
  jobId: string,
  message: string,
  level: "debug" | "info" | "warn" | "error" = "info",
): void {
  db.insert(jobLogs).values({ jobId, message, level }).run();
}

export function succeed(db: Db, jobId: string): void {
  db.update(jobs)
    .set({ status: "succeeded", progress: 1, finishedAt: new Date(), error: null })
    .where(eq(jobs.id, jobId))
    .run();
}

/**
 * Fail a job, re-queueing it with exponential backoff while attempts remain.
 *
 * `attempts` was already incremented by `claim`, so it reflects runs *used*.
 */
export function fail(db: Db, jobId: string, error: string): { willRetry: boolean } {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No such job: ${jobId}`);

  // An operator asking to stop is not a failure to retry through.
  const willRetry = !job.abortRequested && job.attempts < job.maxAttempts;

  if (willRetry) {
    const backoffMs = 5_000 * 2 ** (job.attempts - 1);
    db.update(jobs)
      .set({
        status: "queued",
        error,
        runAfter: new Date(Date.now() + backoffMs),
        externalJobId: null,
      })
      .where(eq(jobs.id, jobId))
      .run();
    log(db, jobId, `Attempt ${job.attempts}/${job.maxAttempts} failed, retrying in ${backoffMs}ms: ${error}`, "warn");
  } else {
    db.update(jobs)
      .set({
        status: job.abortRequested ? "aborted" : "failed",
        error,
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    log(db, jobId, `Giving up after ${job.attempts} attempt(s): ${error}`, "error");
  }

  return { willRetry };
}

/**
 * Ask a job to stop.
 *
 * A queued job is aborted outright. A running one is only *flagged*: an
 * in-flight sd-api call can't be interrupted from here, so the worker is
 * responsible for noticing between steps and unwinding. `externalJobId` is
 * what lets it also cancel the work upstream rather than merely abandoning it.
 */
export function requestAbort(db: Db, jobId: string): { aborted: boolean } {
  return db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw new Error(`No such job: ${jobId}`);

    if (job.status === "queued") {
      tx.update(jobs)
        .set({ status: "aborted", abortRequested: true, finishedAt: new Date() })
        .where(eq(jobs.id, jobId))
        .run();
      return { aborted: true };
    }

    if (job.status === "running") {
      tx.update(jobs).set({ abortRequested: true }).where(eq(jobs.id, jobId)).run();
      return { aborted: false };
    }

    return { aborted: false };
  });
}

export function isAbortRequested(db: Db, jobId: string): boolean {
  const row = db
    .select({ abortRequested: jobs.abortRequested })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return row?.abortRequested ?? false;
}

/** Put a failed or aborted job back on the queue with a fresh attempt budget. */
export function retry(db: Db, jobId: string): Job {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No such job: ${jobId}`);
  if (job.status === "queued" || job.status === "running") {
    throw new Error(`Job ${jobId} is ${job.status}; only failed or aborted jobs can be retried`);
  }

  const [updated] = db
    .update(jobs)
    .set({
      status: "queued",
      attempts: 0,
      progress: 0,
      error: null,
      abortRequested: false,
      externalJobId: null,
      runAfter: new Date(),
      startedAt: null,
      finishedAt: null,
    })
    .where(eq(jobs.id, jobId))
    .returning()
    .all();
  return updated!;
}

export function remove(db: Db, jobId: string): void {
  db.delete(jobs).where(eq(jobs.id, jobId)).run();
}

export function getJob(db: Db, jobId: string): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, jobId)).get();
}

export function listJobs(db: Db, opts: { projectId?: string; limit?: number } = {}): Job[] {
  const query = db.select().from(jobs);
  const rows = opts.projectId
    ? query.where(eq(jobs.projectId, opts.projectId))
    : query;
  return rows.orderBy(asc(jobs.createdAt)).limit(opts.limit ?? 200).all();
}

export function getJobLogs(db: Db, jobId: string) {
  return db
    .select()
    .from(jobLogs)
    .where(eq(jobLogs.jobId, jobId))
    .orderBy(asc(jobLogs.createdAt))
    .all();
}

/**
 * Return jobs left `running` by a worker that died, so they can be re-queued
 * on startup. Without this a crash strands a job in `running` forever: nothing
 * claims it and nothing times it out.
 */
export function reclaimStale(db: Db, olderThanMs = 30 * 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = db
    .update(jobs)
    .set({ status: "queued", runAfter: new Date(), externalJobId: null })
    .where(
      and(
        eq(jobs.status, "running"),
        or(lte(jobs.startedAt, cutoff), sql`${jobs.startedAt} is null`),
      ),
    )
    .returning({ id: jobs.id })
    .all();
  return stale.length;
}
