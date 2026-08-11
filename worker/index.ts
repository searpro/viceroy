import { resolveConfig } from "../lib/config";
import { createDb, createSqlite } from "../lib/db/client";
import { runMigrations } from "../lib/db/migrate";
import { claim, fail, log, reclaimStale, succeed, type Job } from "../lib/queue";
import { createSdApi } from "../lib/sdapi";

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

  const sdApi = createSdApi({ baseUrl: config.sdApiUrl });
  if (!(await sdApi.health())) {
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
      console.error(`[${job.type}] ${job.id} failed${willRetry ? " (will retry)" : ""}: ${message}`);
    }
  }

  sqlite.close();
  process.exit(0);

  async function runJob(job: Job): Promise<void> {
    // Stage handlers land in PR2-PR5; until then an enqueued job should say so
    // plainly rather than silently succeed and advance the pipeline.
    log(db, job.id, `No handler registered for job type "${job.type}"`, "error");
    throw new Error(`No handler registered for job type "${job.type}"`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
