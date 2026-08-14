"use client";

import { useState } from "react";
import { ACTIVE_JOB_STATUSES, statusColour, type Job } from "./detail-types";

/** Counts used by the collapsed strip — active work and failures are what's worth surfacing at a glance. */
export function jobCounts(jobs: Job[]): { active: number; failed: number } {
  return {
    active: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };
}

/**
 * Floating, collapsible jobs list, scoped to the current project.
 *
 * Extracted unchanged (same rows, same `statusColour`, same abort/retry
 * wiring) from the in-flow `<section>` this replaces — only the container
 * moved, to a `fixed bottom-0` bar so it no longer pushes the rest of the
 * page down.
 */
export function JobsBar({
  jobs,
  jobAction,
}: {
  jobs: Job[];
  jobAction: (jobId: string, action: "abort" | "retry") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { active, failed } = jobCounts(jobs);

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/10 bg-black/90 backdrop-blur">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-6 py-2 text-xs text-white/50 transition hover:text-white/80"
      >
        <span className="flex items-center gap-3">
          <span className="font-medium uppercase tracking-wide">Jobs</span>
          <span>{jobs.length} total</span>
          {active > 0 && <span className="text-amber-300">{active} active</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
        </span>
        <span>{expanded ? "hide ▾" : "show ▴"}</span>
      </button>

      {expanded && (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto border-t border-white/5 px-6 py-3">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs"
            >
              <span className="w-28 shrink-0 font-mono">{job.type}</span>
              <span className={`w-20 shrink-0 ${statusColour(job.status)}`}>{job.status}</span>
              <span className="flex-1 truncate text-white/50">
                {job.error ?? (job.status === "running" ? `${Math.round(job.progress * 100)}%` : "")}
              </span>
              {job.attempts > 1 && (
                <span className="shrink-0 text-white/35">
                  {job.attempts}/{job.maxAttempts}
                </span>
              )}
              {ACTIVE_JOB_STATUSES.has(job.status) && (
                <button
                  onClick={() => jobAction(job.id, "abort")}
                  className="shrink-0 text-white/40 transition hover:text-red-300"
                >
                  abort
                </button>
              )}
              {(job.status === "failed" || job.status === "aborted") && (
                <button
                  onClick={() => jobAction(job.id, "retry")}
                  className="shrink-0 text-white/40 transition hover:text-amber-300"
                >
                  retry
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
