"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { jobTypeLabel } from "@/lib/labels";
import { ACTIVE_JOB_STATUSES, statusColour, type Job } from "./detail-types";

/** Counts used by the collapsed strip — active work and failures are what's worth surfacing at a glance. */
export function jobCounts(jobs: Job[]): { active: number; failed: number } {
  return {
    active: jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };
}

/** The job the bar summarises when collapsed: what is running right now. */
export function currentJob(jobs: Job[]): Job | undefined {
  return jobs.find((job) => job.status === "running") ?? jobs.find((job) => job.status === "queued");
}

/**
 * Floating, collapsible jobs list, scoped to the current project.
 *
 * Three things were wrong with the strip as shipped. The disclosure arrows
 * pointed the wrong way ("show ▴" on a bar that opens upward, "hide ▾" on one
 * that closes downward — both inverted). The collapsed state said "36 total, 2
 * active" without saying what those two were, so the only way to see what the
 * project was doing was to open the panel and read a column of raw job keys.
 * And a failure was a red number you had to go looking for.
 *
 * It now names the running stage and shows its progress while collapsed, and
 * opens itself the first time a job fails — a failed stage stops the pipeline,
 * so it is not something to leave folded away.
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
  const running = currentJob(jobs);

  // Seeded from the count at mount, so only a failure that happens *while you
  // are watching* opens the panel. Starting at zero meant a project carrying
  // ten old failures — the normal state of anything that has been iterated on
  // — opened the panel over its own content on every page load.
  const [dismissedFailures, setDismissedFailures] = useState(() => jobCounts(jobs).failed);

  useEffect(() => {
    if (failed > dismissedFailures) setExpanded(true);
  }, [failed, dismissedFailures]);

  function toggle() {
    setExpanded((value) => {
      if (value) setDismissedFailures(failed);
      return !value;
    });
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/10 bg-black/90 backdrop-blur">
      <button
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-6 py-2 text-xs text-white/50 transition hover:text-white/80"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="font-medium uppercase tracking-wide">Jobs</span>
          {running ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />
              <span className="truncate text-amber-300">{jobTypeLabel(running.type)}</span>
              {running.status === "running" && (
                <span className="tabular-nums text-white/40">{Math.round(running.progress * 100)}%</span>
              )}
            </span>
          ) : (
            <span className="text-white/35">idle</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
          <span className="text-white/30">
            {jobs.length} total{active > 0 ? ` · ${active} active` : ""}
          </span>
          {/* ▾ closes (points down, toward the bar's own edge); ▴ opens. */}
          <span aria-hidden>{expanded ? "hide ▾" : "show ▴"}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-white/5">
          <ul className="max-h-64 space-y-1.5 overflow-y-auto px-6 py-3">
            {jobs.length === 0 && <p className="text-xs text-white/35">No jobs for this project yet.</p>}
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs"
              >
                <span className="w-44 shrink-0 truncate" title={job.type}>
                  {jobTypeLabel(job.type)}
                </span>
                <span className={`w-16 shrink-0 ${statusColour(job.status)}`}>{job.status}</span>
                {job.status === "running" ? (
                  <span className="flex flex-1 items-center gap-2">
                    <span className="h-1 max-w-40 flex-1 overflow-hidden rounded-full bg-white/10">
                      <span
                        className="block h-full rounded-full bg-amber-300 transition-all"
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                      />
                    </span>
                    <span className="tabular-nums text-white/45">{Math.round(job.progress * 100)}%</span>
                  </span>
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate text-white/50"
                    title={job.error ?? undefined}
                  >
                    {job.error ?? ""}
                  </span>
                )}
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
          <div className="px-6 pb-2">
            <Link href="/jobs" className="text-[11px] text-white/35 transition hover:text-white/70">
              all jobs, every project →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
