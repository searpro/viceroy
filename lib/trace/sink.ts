import type { Db } from "../db/client";
import { traceCalls, type TraceKind } from "../db/schema";
import { attributeTemplates } from "../prompts/trace";
import type { Job } from "../queue";

/**
 * Whatever the caller knows about the provider row a request went to.
 *
 * Every field is optional because the three wrappers know different amounts:
 * an LLM provider has a `model` and no `adapter` that matters, a ComfyUI image
 * provider has an `adapter` and a `model` that means nothing to the host. A
 * missing field is recorded as empty rather than guessed at.
 */
export type TraceProvider = {
  id?: string | null;
  name?: string;
  adapter?: string;
  model?: string;
  baseUrl?: string;
};

export type TraceEntry = {
  kind: TraceKind;
  operation: string;
  provider: TraceProvider;
  requestPath?: string;
  /**
   * The text to attribute prompt templates from — the concatenated messages
   * for a chat, the prompt for a generation. Separate from `request` because
   * attribution needs one flat string and `request` needs to stay the shape a
   * reader recognises.
   */
  prompt: string;
  request: Record<string, unknown>;
  resolved?: Record<string, unknown> | undefined;
  response?: string | undefined;
  responseMeta?: Record<string, unknown> | undefined;
  ok: boolean;
  error?: string | undefined;
  durationMs: number;
};

export type TraceSink = {
  record(entry: TraceEntry): void;
};

/**
 * A sink that records nothing.
 *
 * The default everywhere a sink is optional, so tracing is something the
 * worker opts into rather than something every other caller — the test
 * harness, a one-off script — has to opt out of.
 */
export const NO_TRACE: TraceSink = { record: () => {} };

/**
 * Record every generation request made while running one job.
 *
 * The sequence counter lives here rather than in the table's default because
 * it is per-job and monotonic: `created_at` at millisecond resolution cannot
 * order the dozen calls a per-scene stage fires in the same second, and the
 * order is what makes the trace readable.
 */
export function createTraceSink(db: Db, job: Job): TraceSink {
  let sequence = 0;

  return {
    record(entry) {
      sequence++;
      try {
        db.insert(traceCalls)
          .values({
            jobId: job.id,
            projectId: job.projectId,
            stage: job.type,
            kind: entry.kind,
            operation: entry.operation,
            sequence,
            attempt: job.attempts,
            providerId: entry.provider.id ?? null,
            providerName: entry.provider.name ?? "",
            adapter: entry.provider.adapter ?? "",
            model: entry.provider.model ?? "",
            baseUrl: entry.provider.baseUrl ?? "",
            requestPath: entry.requestPath ?? "",
            templates: attributeTemplates(entry.prompt),
            request: entry.request,
            resolved: entry.resolved ?? null,
            response: entry.response ?? null,
            responseMeta: entry.responseMeta ?? null,
            ok: entry.ok,
            error: entry.error ?? null,
            durationMs: entry.durationMs,
          })
          .run();
      } catch (error) {
        // A trace is diagnostic, never load-bearing. A job that generated
        // correctly must not be failed by a bookkeeping insert — a locked
        // database or a value that would not serialise costs a warning and
        // one missing row, not the twelve minutes of inference that produced
        // it.
        console.warn(
          `trace: failed to record ${entry.kind}/${entry.operation} for job ${job.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
}
