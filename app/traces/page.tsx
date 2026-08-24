import { getDb } from "@/lib/db/client";
import { TRACE_KINDS, type TraceKind } from "@/lib/db/schema";
import { listTraceCalls, traceStages } from "@/lib/trace";
import { TracesView } from "./traces-view";

export const dynamic = "force-dynamic";

/** Matches the API route's own limit, so the first paint and the first filter show the same window. */
const LIST_LIMIT = 500;

/**
 * Filters are read here rather than in the client component so that a link
 * into this screen — "everything this job sent", from the Jobs list — arrives
 * already scoped, instead of painting every trace in the database and then
 * replacing it a round trip later.
 */
export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const db = getDb();

  const kind = first(params.kind);
  const projectId = first(params.projectId);
  const jobId = first(params.jobId);
  const stage = first(params.stage);
  const failed = first(params.failed) === "1";

  const filters = {
    projectId,
    jobId,
    kind: isTraceKind(kind) ? kind : undefined,
    stage,
    failedOnly: failed,
    limit: LIST_LIMIT,
  };

  return (
    <TracesView
      // Serialised through JSON so the client component's props match exactly
      // what its own fetches will later replace them with — Dates would arrive
      // as strings on the second render and not the first.
      initial={JSON.parse(JSON.stringify(listTraceCalls(db, filters)))}
      stages={traceStages(db, projectId)}
      limit={LIST_LIMIT}
      initialFilters={{
        kind: filters.kind ?? "",
        stage: stage ?? "",
        failed,
        jobId: jobId ?? null,
        projectId: projectId ?? null,
      }}
    />
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isTraceKind(value: string | undefined): value is TraceKind {
  return value !== undefined && (TRACE_KINDS as readonly string[]).includes(value);
}
