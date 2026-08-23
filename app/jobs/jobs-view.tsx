"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatLabel, isDevFormat, jobTypeFlow, jobTypeLabel } from "@/lib/labels";

type Job = {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "aborted";
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  project: { id: string; idea: string; title: string | null; format: string } | null;
};

const ACTIVE = new Set(["queued", "running"]);
const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "failed", label: "Failed" },
  { key: "development", label: "Movie" },
  { key: "narrative", label: "Short video" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

/**
 * Every job across every project.
 *
 * Two things were wrong here for movie work. The type column printed the raw
 * key in a 7rem monospace box — `script_breakdown` and `screenplay_revision`
 * both truncate to the same thing, so the column that says *what is happening*
 * said nothing. And with 32 job types spanning two unrelated pipelines there
 * was no way to look at only one of them. Both are fixed by `lib/labels.ts`
 * knowing which flow a type belongs to.
 */
export function JobsView({ initial, limit }: { initial: Job[]; limit: number }) {
  const [jobs, setJobs] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const anyActive = jobs.some((job) => ACTIVE.has(job.status));

  // Poll only while something is actually running — a queue screen sitting
  // open in a tab shouldn't keep waking the database every few seconds once
  // everything has settled.
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(async () => {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (response.ok) setJobs((await response.json()).jobs);
    }, 2000);
    return () => clearInterval(timer);
  }, [anyActive]);

  async function refresh() {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (response.ok) setJobs((await response.json()).jobs);
  }

  async function jobAction(jobId: string, action: "abort" | "retry") {
    setBusyId(jobId);
    await fetch(`/api/jobs/${jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await refresh();
    setBusyId(null);
  }

  async function remove(jobId: string) {
    setBusyId(jobId);
    await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    setJobs((current) => current.filter((j) => j.id !== jobId));
    setBusyId(null);
  }

  /**
   * Clearing one finished job at a time is not a realistic way to empty a queue
   * of several hundred — and neither is firing one request per row, which is
   * what this did first. One collection-level DELETE, server-side.
   */
  async function clearFinished() {
    const finished = jobs.filter((job) => !ACTIVE.has(job.status));
    if (finished.length === 0) return;
    if (!window.confirm(`Remove ${finished.length} finished job${finished.length === 1 ? "" : "s"} from the list?`)) {
      return;
    }
    setBusyId("bulk");
    await fetch("/api/jobs", { method: "DELETE" });
    await refresh();
    setBusyId(null);
  }

  const counts = useMemo(
    () => ({
      all: jobs.length,
      active: jobs.filter((job) => ACTIVE.has(job.status)).length,
      failed: jobs.filter((job) => job.status === "failed" || job.status === "aborted").length,
      development: jobs.filter((job) => jobTypeFlow(job.type) === "development").length,
      narrative: jobs.filter((job) => jobTypeFlow(job.type) === "narrative").length,
    }),
    [jobs],
  );

  const visible = jobs.filter((job) => {
    if (filter === "active") return ACTIVE.has(job.status);
    if (filter === "failed") return job.status === "failed" || job.status === "aborted";
    if (filter === "development" || filter === "narrative") return jobTypeFlow(job.type) === filter;
    return true;
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <button
          onClick={clearFinished}
          disabled={busyId !== null || counts.all === counts.active}
          className="text-xs text-white/40 transition hover:text-white/70 disabled:opacity-30"
        >
          clear finished
        </button>
      </div>
      <p className="mt-2 text-sm text-white/45">
        Every job across every project, newest first. Per-project jobs are also visible on each
        project's own page.
      </p>

      <nav className="mt-6 flex flex-wrap gap-1 border-b border-white/10">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm transition ${
              filter === f.key
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {f.label}
            <span className="text-xs text-white/30">{counts[f.key]}</span>
          </button>
        ))}
      </nav>

      {jobs.length >= limit && (
        <p className="mt-3 text-xs text-white/30">
          Showing the newest {limit} jobs. Older ones are still in the database but not listed —
          &ldquo;clear finished&rdquo; is the way to get back under the cap.
        </p>
      )}

      <ul className="mt-4 space-y-1.5">
        {visible.length === 0 && <p className="text-sm text-white/35">Nothing here.</p>}
        {visible.map((job) => (
          <li key={job.id} className="rounded-md border border-white/10 bg-white/[0.02]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs">
              <StatusDot status={job.status} />
              <span className="w-44 shrink-0 truncate text-white/85" title={job.type}>
                {jobTypeLabel(job.type)}
              </span>
              <span className={`w-16 shrink-0 ${statusColour(job.status)}`}>{job.status}</span>

              {job.project ? (
                <Link
                  href={`/projects/${job.project.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2 transition hover:text-amber-300"
                  title={job.project.title ?? job.project.idea}
                >
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      isDevFormat(job.project.format)
                        ? "bg-sky-400/10 text-sky-300"
                        : "bg-white/5 text-white/40"
                    }`}
                  >
                    {formatLabel(job.project.format, true)}
                  </span>
                  <span className="min-w-0 truncate text-white/60">
                    {job.project.title ?? job.project.idea}
                  </span>
                </Link>
              ) : (
                <span className="flex-1 text-white/30">no project</span>
              )}

              {job.status === "running" && <Progress value={job.progress} />}
              {job.attempts > 1 && (
                <span className="shrink-0 text-white/35" title="attempts of maximum">
                  {job.attempts}/{job.maxAttempts}
                </span>
              )}

              {ACTIVE.has(job.status) && (
                <Action onClick={() => jobAction(job.id, "abort")} disabled={busyId === job.id} tone="danger">
                  abort
                </Action>
              )}
              {(job.status === "failed" || job.status === "aborted") && (
                <Action onClick={() => jobAction(job.id, "retry")} disabled={busyId === job.id} tone="warn">
                  retry
                </Action>
              )}
              {!ACTIVE.has(job.status) && (
                <Action onClick={() => remove(job.id)} disabled={busyId === job.id} tone="danger">
                  delete
                </Action>
              )}
            </div>

            {/* The error used to share a truncating flex cell with the
                progress percentage, so a stack trace showed its first forty
                characters and no way to see the rest. */}
            {job.error && (
              <div className="border-t border-white/5 px-3 py-2">
                <button
                  onClick={() => setExpanded((current) => (current === job.id ? null : job.id))}
                  className="w-full text-left text-[11px] text-red-300/90 transition hover:text-red-200"
                >
                  <span className={expanded === job.id ? "whitespace-pre-wrap break-words" : "line-clamp-1"}>
                    {job.error}
                  </span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

function Progress({ value }: { value: number }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`${percent}%`}>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-amber-300 transition-all" style={{ width: `${percent}%` }} />
      </span>
      <span className="w-8 tabular-nums text-white/45">{percent}%</span>
    </span>
  );
}

function StatusDot({ status }: { status: Job["status"] }) {
  const tone =
    status === "succeeded"
      ? "bg-emerald-400"
      : status === "failed"
        ? "bg-red-400"
        : status === "running"
          ? "bg-amber-300 animate-pulse"
          : status === "queued"
            ? "bg-white/40"
            : "bg-white/20";
  return <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

function Action({
  onClick,
  disabled,
  tone,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  tone: "danger" | "warn";
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 text-white/40 transition disabled:opacity-40 ${
        tone === "danger" ? "hover:text-red-300" : "hover:text-amber-300"
      }`}
    >
      {children}
    </button>
  );
}

function statusColour(status: Job["status"]): string {
  if (status === "succeeded") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "aborted") return "text-white/40";
  if (status === "running") return "text-amber-300";
  return "text-white/50";
}
