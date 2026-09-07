import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { projects, traceCalls, type TraceKind } from "../db/schema";

/**
 * How much of a prompt or response the list view carries.
 *
 * The full text is stored — a trace that truncates the thing being debugged
 * is not one — but the list can show several hundred rows at once, and a
 * screenplay revision's response alone is tens of kilobytes. The detail
 * request fetches the whole row; the list gets enough to recognise it by.
 */
const PREVIEW_CHARS = 200;

export type TraceFilters = {
  projectId?: string | undefined;
  jobId?: string | undefined;
  kind?: TraceKind | undefined;
  stage?: string | undefined;
  /** Only calls that failed to send, or whose response would not parse. */
  failedOnly?: boolean | undefined;
  limit?: number | undefined;
};

export function listTraceCalls(db: Db, filters: TraceFilters = {}) {
  const where: SQL[] = [];
  if (filters.projectId) where.push(eq(traceCalls.projectId, filters.projectId));
  if (filters.jobId) where.push(eq(traceCalls.jobId, filters.jobId));
  if (filters.kind) where.push(eq(traceCalls.kind, filters.kind));
  if (filters.stage) where.push(eq(traceCalls.stage, filters.stage));
  if (filters.failedOnly) where.push(eq(traceCalls.ok, false));

  const rows = db
    .select({
      id: traceCalls.id,
      jobId: traceCalls.jobId,
      projectId: traceCalls.projectId,
      stage: traceCalls.stage,
      kind: traceCalls.kind,
      operation: traceCalls.operation,
      sequence: traceCalls.sequence,
      attempt: traceCalls.attempt,
      providerName: traceCalls.providerName,
      adapter: traceCalls.adapter,
      model: traceCalls.model,
      templates: traceCalls.templates,
      ok: traceCalls.ok,
      error: traceCalls.error,
      durationMs: traceCalls.durationMs,
      createdAt: traceCalls.createdAt,
      // Sliced in SQL rather than after the fact: selecting the full column and
      // then throwing 99% of it away still reads every byte off disk, and this
      // list is the screen that loads hundreds of rows at once.
      //
      // Two shapes, because the two kinds keep the prompt in different places:
      // an image request has a flat `prompt`, a chat request has `messages`.
      // The *last* message rather than the first — a system message is
      // boilerplate the stage sends every time, and the user turn is the part
      // that differs between one call and the next.
      promptPreview: sql<string>`substr(
        coalesce(
          json_extract(${traceCalls.request}, '$.prompt'),
          json_extract(${traceCalls.request}, '$.messages[#-1].content'),
          ''
        ), 1, ${PREVIEW_CHARS})`,
      responsePreview: sql<string | null>`substr(${traceCalls.response}, 1, ${PREVIEW_CHARS})`,
      responseLength: sql<number>`coalesce(length(${traceCalls.response}), 0)`,
    })
    .from(traceCalls)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(traceCalls.createdAt), desc(traceCalls.sequence))
    .limit(filters.limit ?? 500)
    .all();

  return withProjects(db, rows);
}

/**
 * The whole row, including the prompt and the raw response.
 *
 * Separate from the list precisely so the list can stay cheap — see
 * `PREVIEW_CHARS`.
 */
export function getTraceCall(db: Db, id: string) {
  const row = db.select().from(traceCalls).where(eq(traceCalls.id, id)).get();
  if (!row) return undefined;
  return withProjects(db, [row])[0];
}

/** Distinct stages present in the trace, for the filter control. */
export function traceStages(db: Db, projectId?: string): string[] {
  return db
    .selectDistinct({ stage: traceCalls.stage })
    .from(traceCalls)
    .where(projectId ? eq(traceCalls.projectId, projectId) : undefined)
    .all()
    .map((row) => row.stage);
}

/** How many calls a job made, for the Jobs screen's per-row link. */
export function traceCountsByJob(db: Db, jobIds: string[]): Record<string, number> {
  if (jobIds.length === 0) return {};
  const rows = db
    .select({ jobId: traceCalls.jobId, count: sql<number>`count(*)` })
    .from(traceCalls)
    .where(inArray(traceCalls.jobId, jobIds))
    .groupBy(traceCalls.jobId)
    .all();
  return Object.fromEntries(rows.map((row) => [row.jobId, Number(row.count)]));
}

/**
 * Attach the owning project to each row.
 *
 * One extra query for the whole page rather than a join, matching
 * `listAllJobs`: most rows in a page share a handful of projects, and a join
 * would carry the same title down every one of five hundred rows.
 */
function withProjects<T extends { projectId: string | null }>(db: Db, rows: T[]) {
  const ids = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => !!id))];
  const found =
    ids.length > 0
      ? db
          .select({ id: projects.id, idea: projects.idea, title: projects.title, format: projects.format })
          .from(projects)
          .where(inArray(projects.id, ids))
          .all()
      : [];
  const byId = new Map(found.map((project) => [project.id, project]));

  return rows.map((row) => ({
    ...row,
    project: row.projectId ? (byId.get(row.projectId) ?? null) : null,
  }));
}
