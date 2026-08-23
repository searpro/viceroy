import { resolveConfig, type Config } from "../lib/config";
import { createDb, createSqlite, type Db } from "../lib/db/client";
import { runMigrations } from "../lib/db/migrate";
import {
  claim,
  fail,
  isAbortRequested,
  log,
  reclaimStale,
  reportProgress,
  succeed,
  type Job,
} from "../lib/queue";
import { createSdApi } from "../lib/sdapi";
import { awaitReview, STAGE_HANDLERS, type StageContext } from "../lib/pipeline";
import { resolveImageBackend, resolveLlmClient, resolveVideoBackend } from "../lib/backends/resolve";

const IDLE_POLL_MS = 1000;

/**
 * The worker runs one job at a time, deliberately.
 *
 * Every stage is bound by sd-api, which serialises heavy work itself, and the
 * models compete for the same 24 GB. Concurrency here would buy queueing
 * inside sd-api rather than throughput.
 */
async function main() {
  const config = resolveConfig();
  const sqlite = createSqlite(config.databasePath);
  const db = createDb(sqlite);
  runMigrations(db);

  const baseSdApi = createSdApi({ baseUrl: config.sdApiUrl, timeoutMs: config.sdApiTimeoutMs });
  if (!(await baseSdApi.health())) {
    console.warn(`sd-api is not reachable at ${config.sdApiUrl} — jobs will fail until it is`);
  }

  const reclaimed = reclaimStale(db);
  if (reclaimed > 0) console.log(`re-queued ${reclaimed} job(s) stranded by a previous run`);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("finishing current job, then stopping");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`worker ready — sd-api ${config.sdApiUrl}, db ${config.databasePath}`);

  while (!stopping) {
    const job = claim(db);
    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    console.log(`[${job.type}] ${job.id} started`);
    try {
      await runJob(job);
      succeed(db, job.id);
      console.log(`[${job.type}] ${job.id} succeeded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { willRetry } = fail(db, job.id, message);
      // A project whose job has given up is not "in progress" — without this
      // it keeps its old stage in the list and looks like it is still working.
      // Aborting counts: an operator stopping a stage leaves exactly the same
      // dead end as a failure does.
      if (!willRetry && job.projectId) {
        const aborted = isAbortRequested(db, job.id);
        awaitReview(
          db,
          job.projectId,
          aborted ? `${job.type} was aborted` : `${job.type} failed: ${message}`,
        );
      }
      console.error(`[${job.type}] ${job.id} failed${willRetry ? " (will retry)" : ""}: ${message}`);
    }
  }

  sqlite.close();
  process.exit(0);

  async function runJob(job: Job): Promise<void> {
    const handler = STAGE_HANDLERS[job.type];
    if (!handler) {
      // Not yet implemented is a failure, not a no-op: succeeding here would
      // advance a project past a stage that never ran.
      log(db, job.id, `No handler registered for job type "${job.type}"`, "error");
      throw new Error(`No handler registered for job type "${job.type}"`);
    }

    const ctx: StageContext = {
      db,
      sdApi: baseSdApi,
      // Resolved per call, not per job: an LLM stage must not fail because no
      // image provider is configured, and picking the row at call time is what
      // lets a provider swapped in the admin UI take effect on the next job.
      imageBackend: () => resolveImageBackend(db, config, baseSdApi),
      videoBackend: () => resolveVideoBackend(db, config),
      llmClient: (provider) => resolveLlmClient(provider, config, baseSdApi),
      config,
      job,
      log: (message, level) => log(db, job.id, message, level),
      progress: (fraction) => reportProgress(db, job.id, fraction),
      shouldAbort: () => isAbortRequested(db, job.id),
    };

    await handler(ctx);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
