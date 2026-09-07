import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { TRACE_KINDS, type TraceKind } from "@/lib/db/schema";
import { listTraceCalls, traceStages } from "@/lib/trace";

export const dynamic = "force-dynamic";

/**
 * How many trace rows the list screen loads.
 *
 * Lower than the Jobs screen's thousand because one job produces many rows —
 * a per-scene image stage alone is a few dozen — so this window still spans
 * far more work than a thousand jobs' worth of queue does. The screen says so
 * when the cap is reached.
 */
const LIST_LIMIT = 500;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const db = getDb();

  const kind = params.get("kind");
  const projectId = params.get("projectId") ?? undefined;

  return NextResponse.json({
    traces: listTraceCalls(db, {
      projectId,
      jobId: params.get("jobId") ?? undefined,
      // An unrecognised kind is dropped rather than 400'd: it can only come
      // from a hand-edited URL, and an unfiltered list is a more useful answer
      // than an error page.
      kind: isTraceKind(kind) ? kind : undefined,
      stage: params.get("stage") ?? undefined,
      failedOnly: params.get("failed") === "1",
      limit: LIST_LIMIT,
    }),
    // Sourced from the whole table rather than the returned page, so the
    // filter never hides the stage you are trying to filter down to.
    stages: traceStages(db, projectId),
    limit: LIST_LIMIT,
  });
}

function isTraceKind(value: string | null): value is TraceKind {
  return value !== null && (TRACE_KINDS as readonly string[]).includes(value);
}
