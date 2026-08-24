import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Load `.env.local` and `.env` the way Next.js already does.
 *
 * Next loads these automatically; a plain `tsx` process does not, and nothing
 * in this repo made up the difference. So `pnpm dev` and `pnpm dev:worker`
 * resolved different `VICEROY_DATA_DIR`s the moment a `.env.local` existed —
 * the web app enqueued jobs into one database while the worker polled another,
 * and a job sat `queued` forever with no error, no attempt, and a worker that
 * was healthy and correctly idle because its own queue really was empty.
 *
 * The same split hits `db:migrate` and `db:seed`, which is worse: they would
 * migrate or seed the default database while the app runs on the configured
 * one, and nothing would say so.
 *
 * `.env.local` is loaded first *because* `process.loadEnvFile` never overwrites
 * a variable that is already set. Loading it first is therefore what gives it
 * precedence over `.env`, and lets a real environment variable beat both —
 * matching Next's own order rather than inventing a second one.
 *
 * Not `.env.development`/`.env.production`: Next resolves those from NODE_ENV,
 * and this repo has never had one. Add them here, not at a call site, if that
 * changes.
 */
export function loadEnvFiles(cwd = process.cwd()): void {
  for (const file of [".env.local", ".env"]) {
    const full = path.join(cwd, file);
    // `loadEnvFile` throws on a missing file rather than returning quietly, and
    // neither of these is required to exist.
    if (existsSync(full)) process.loadEnvFile(full);
  }
}
