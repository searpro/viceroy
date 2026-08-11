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
};

type Evaluation = {
  id: string;
  iteration: number;
  verdict: string;
  overallScore: number | null;
  dimensions: Record<string, { score: number; comment: string }>;
  issues: { severity: string; note: string }[];
};

type Scene = {
  id: string;
  index: number;
  description: string;
  storyboard: string | null;
  imagePrompt: string | null;
  voiceoverScript: string;
  imageAssetId: string | null;
};

type Character = {
  id: string;
  name: string;
  description: string;
  appearanceTag: string | null;
  imageAssetId: string | null;
};

type Detail = {
  project: {
    id: string;
    idea: string;
    synopsis: string | null;
    story: string | null;
    stage: string;
    mode: string;
    awaitingReview: boolean;
    failureReason: string | null;
  };
  narrativeStyle?: { name: string };
  voiceStyle?: { name: string };
  evaluations: Evaluation[];
  scenes: Scene[];
  characters: Character[];
  jobs: Job[];
};

const ACTIVE = new Set(["queued", "running"]);

export function ProjectView({ initial }: { initial: Detail }) {
  const [detail, setDetail] = useState(initial);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);

  const active = detail.jobs.some((job) => ACTIVE.has(job.status));

  // Poll only while something is actually running. A finished project sitting
  // open in a tab shouldn't keep waking the database every two seconds.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
      if (response.ok) setDetail(await response.json());
    }, 2000);
    return () => clearInterval(timer);
  }, [active, detail.project.id]);

  async function regenerate(
    target: "synopsis" | "story" | "elements" | "scene_images" | "character_images",
  ) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, direction: direction.trim() || undefined }),
    });
    setDirection("");
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function jobAction(jobId: string, action: "abort" | "retry") {
    await fetch(`/api/jobs/${jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
  }

  const { project } = detail;
  const latestEvaluation = detail.evaluations[0];

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← all projects
      </Link>

      <header className="mt-4">
        <h1 className="text-xl font-semibold leading-snug">{project.idea}</h1>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/40">
          <span>{detail.narrativeStyle?.name}</span>
          <span>·</span>
          <span>{detail.voiceStyle?.name}</span>
          <span>·</span>
          <span>{project.mode} mode</span>
          <span>·</span>
          <span className="font-mono">{project.stage}</span>
          {active && <span className="text-amber-300">working…</span>}
        </p>
      </header>

      {project.failureReason && (
        <p className="mt-6 rounded-md bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {project.failureReason}
        </p>
      )}

      <Panel title="Synopsis" empty={!project.synopsis} emptyText="Not written yet.">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">
          {project.synopsis}
        </p>
      </Panel>

      <Panel title="Story" empty={!project.story} emptyText="Not written yet.">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{project.story}</p>
      </Panel>

      {(project.synopsis || project.story) && (
        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <label htmlFor="direction" className="block text-sm font-medium">
            Direct a rewrite
          </label>
          <input
            id="direction"
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="make the opening colder and cut the backstory"
            className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => regenerate("synopsis")}
              disabled={busy || active}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
            >
              Redo synopsis
            </button>
            <button
              onClick={() => regenerate("story")}
              disabled={busy || active || !project.synopsis}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
            >
              Redo story
            </button>
          </div>
          <p className="mt-2 text-xs text-white/35">
            Leave the field empty to regenerate from scratch.
          </p>
        </section>
      )}

      {latestEvaluation && (
        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="flex items-baseline gap-2 text-sm font-medium">
            Evaluation
            <span
              className={
                latestEvaluation.verdict === "pass" ? "text-emerald-400" : "text-amber-300"
              }
            >
              {latestEvaluation.verdict}
            </span>
            {latestEvaluation.overallScore !== null && (
              <span className="text-xs font-normal text-white/40">
                mean {latestEvaluation.overallScore.toFixed(1)}/5 · pass {latestEvaluation.iteration}
              </span>
            )}
          </h2>

          <dl className="mt-3 space-y-1.5 text-xs">
            {Object.entries(latestEvaluation.dimensions).map(([key, value]) => (
              <div key={key} className="flex gap-3">
                <dt className="w-36 shrink-0 font-mono text-white/45">{key}</dt>
                <dd className="flex-1 text-white/70">
                  <span className={value.score <= 2 ? "text-red-400" : "text-white/70"}>
                    {value.score}/5
                  </span>{" "}
                  {value.comment}
                </dd>
              </div>
            ))}
          </dl>

          {latestEvaluation.issues.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-white/5 pt-3 text-xs text-white/70">
              {latestEvaluation.issues.map((issue, index) => (
                <li key={index}>
                  <span className="font-mono text-white/40">[{issue.severity}]</span> {issue.note}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {detail.characters.length > 0 && (
        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Cast</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {detail.characters.map((character) => (
              <li key={character.id} className="flex gap-3">
                {character.imageAssetId && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/assets/${character.imageAssetId}`}
                    alt={character.name}
                    className="h-14 w-14 shrink-0 rounded object-cover"
                  />
                )}
                <div>
                  <span className="block font-medium">{character.name}</span>
                  <span className="block text-xs text-white/45">
                    {character.appearanceTag ?? character.description}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.scenes.length > 0 && (
        <section className="mt-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
              Scenes ({detail.scenes.length})
            </h2>
            <button
              onClick={() => regenerate("scene_images")}
              disabled={busy || active}
              className="text-xs text-white/40 transition hover:text-amber-300 disabled:opacity-40"
            >
              generate missing images
            </button>
          </div>

          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {detail.scenes.map((scene) => (
              <li
                key={scene.id}
                className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]"
              >
                <div className="relative aspect-[9/16] bg-black/40">
                  {scene.imageAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${scene.imageAssetId}`}
                      alt={scene.description}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="absolute inset-0 grid place-items-center text-xs text-white/25">
                      no image yet
                    </span>
                  )}
                  <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px]">
                    {scene.index + 1}
                  </span>
                </div>
                <div className="space-y-1.5 p-3">
                  <p className="text-xs font-medium">{scene.description}</p>
                  <p className="text-xs leading-relaxed text-white/55">{scene.voiceoverScript}</p>
                  {scene.imagePrompt && (
                    <details className="text-[11px] text-white/35">
                      <summary className="cursor-pointer">prompt</summary>
                      <p className="mt-1 leading-relaxed">{scene.imagePrompt}</p>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Jobs</h2>
        <ul className="mt-3 space-y-1.5">
          {detail.jobs.map((job) => (
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
              {ACTIVE.has(job.status) && (
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
      </section>
    </main>
  );
}

function Panel({
  title,
  empty,
  emptyText,
  children,
}: {
  title: string;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">{title}</h2>
      <div className="mt-3">
        {empty ? <p className="text-sm text-white/35">{emptyText}</p> : children}
      </div>
    </section>
  );
}

function statusColour(status: Job["status"]): string {
  if (status === "succeeded") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "aborted") return "text-white/40";
  if (status === "running") return "text-amber-300";
  return "text-white/50";
}
