import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { jobCounts, listAllJobs } from "@/lib/projects";
import { removeFinished } from "@/lib/queue";

export const dynamic = "force-dynamic";

/**
 * How many rows the list screen loads.
 *
 * Above `listAllJobs`'s own historical 200 because the screen now counts jobs
 * per pipeline, and a 200-row window on a machine that has mostly run short
 * videos put every Development-chain job outside it — so the "Movie" filter
 * read `0` on a database with hundreds of them, which is worse than not
 * offering the filter. Still capped: the list is a queue view, not an audit
 * log, and the screen says so when the cap is reached.
 */
const LIST_LIMIT = 1000;

export async function GET(request: Request) {
  const db = getDb();

  // The nav badge polls this every few seconds on every open tab and needs two
  // integers, so it gets a `GROUP BY status` aggregate — not the full listing
  // filtered down, which would select a thousand rows and join their projects
  // to produce the same two numbers. It also counts *every* job rather than
  // the newest `LIST_LIMIT`, so the badge cannot say "nothing running" because
  // the running job fell outside a window.
  if (new URL(request.url).searchParams.has("counts")) {
    return NextResponse.json({ counts: jobCounts(db) });
  }

  return NextResponse.json({ jobs: listAllJobs(db, { limit: LIST_LIMIT }), limit: LIST_LIMIT });
}

/**
 * Clear finished jobs — everything that is not queued or running, optionally
 * scoped to one project with `?projectId=`.
 *
 * A collection-level DELETE rather than the screen firing one request per row:
 * the list holds up to `LIST_LIMIT` jobs, and "clear finished" on a well-used
 * database meant hundreds of parallel requests contending for one sqlite write
 * lock. Running work is deliberately out of scope — see `removeFinished`.
 *
 * `?scope=finished` is required, and a bare `DELETE /api/jobs` is refused. A
 * collection endpoint that destroys history on the strength of the method
 * alone is one stray request away from wiping a queue nobody asked it to —
 * requiring the caller to name what it is deleting means an accidental or
 * replayed DELETE does nothing at all.
 */
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("scope") !== "finished") {
    return NextResponse.json(
      { error: "Refusing to delete without an explicit scope — pass ?scope=finished" },
      { status: 400 },
    );
  }

  const projectId = params.get("projectId") ?? undefined;
  return NextResponse.json({ removed: removeFinished(getDb(), { projectId }) });
}
