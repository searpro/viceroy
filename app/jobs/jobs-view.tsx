"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Job = {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "aborted";
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  project: { id: string; idea: string; title: string | null } | null;
};

const ACTIVE = new Set(["queued", "running"]);
const FILTERS = ["all", "active", "failed"] as const;
type Filter = (typeof FILTERS)[number];

export function JobsView({ initial }: { initial: Job[] }) {
  const [jobs, setJobs] = useState(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const visible = jobs.filter((job) => {
    if (filter === "active") return ACTIVE.has(job.status);
    if (filter === "failed") return job.status === "failed" || job.status === "aborted";
    return true;
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <div className="mt-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <span className="text-xs text-white/35">{jobs.length} total</span>
      </div>
      <p className="mt-2 text-sm text-white/45">
        Every job across every project, newest first. Per-project jobs are also visible on each
        project's own page.
      </p>

      <nav className="mt-6 flex gap-1 border-b border-white/10">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-2 text-sm capitalize transition ${
              filter === f
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {f}
          </button>
        ))}
      </nav>

      <ul className="mt-4 space-y-1.5">
        {visible.length === 0 && <p className="text-sm text-white/35">Nothing here.</p>}
        {visible.map((job) => (
          <li
            key={job.id}
            className="flex flex-wrap items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs"
          >
            <span className="w-28 shrink-0 font-mono">{job.type}</span>
            <span className={`w-20 shrink-0 ${statusColour(job.status)}`}>{job.status}</span>
            {job.project ? (
              <Link
                href={`/projects/${job.project.id}`}
                className="min-w-0 flex-1 truncate text-white/60 transition hover:text-amber-300"
              >
                {job.project.title ?? job.project.idea}
              </Link>
            ) : (
              <span className="flex-1 text-white/30">no project</span>
            )}
            <span className="w-full basis-full truncate text-white/45 sm:w-auto sm:basis-0 sm:flex-1">
              {job.error ?? (job.status === "running" ? `${Math.round(job.progress * 100)}%` : "")}
            </span>
            {job.attempts > 1 && (
              <span className="shrink-0 text-white/35">
                {job.attempts}/{job.maxAttempts}
              </span>
            )}
            {ACTIVE.has(job.status) && (
              <button
                onClick={() => jobAction(job.id, "abort")}
                disabled={busyId === job.id}
                className="shrink-0 text-white/40 transition hover:text-red-300 disabled:opacity-40"
              >
                abort
              </button>
            )}
            {(job.status === "failed" || job.status === "aborted") && (
              <button
                onClick={() => jobAction(job.id, "retry")}
                disabled={busyId === job.id}
                className="shrink-0 text-white/40 transition hover:text-amber-300 disabled:opacity-40"
              >
                retry
              </button>
            )}
            {!ACTIVE.has(job.status) && (
              <button
                onClick={() => remove(job.id)}
                disabled={busyId === job.id}
                className="shrink-0 text-white/40 transition hover:text-red-300 disabled:opacity-40"
              >
                delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

function statusColour(status: Job["status"]): string {
  if (status === "succeeded") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "aborted") return "text-white/40";
  if (status === "running") return "text-amber-300";
  return "text-white/50";
}
