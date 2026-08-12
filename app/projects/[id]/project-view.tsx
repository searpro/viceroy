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
  nextStep: { kind: "run" | "complete"; type?: string; reason: string };
  stalled: boolean;
  scenes: Scene[];
  characters: Character[];
  render?: { id: string; assetId: string | null; status: string } | null;
  voiceover?: {
    id: string;
    ttsInstruct: string;
    audioAssetId: string | null;
    durationMs: number | null;
  } | null;
  cues: Cue[];
  jobs: Job[];
};

type Cue = {
  id: string;
  index: number;
  text: string;
  heardText: string | null;
  startMs: number;
  endMs: number;
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
    target:
      | "synopsis"
      | "story"
      | "elements"
      | "character_images"
      | "scene_images"
      | "voiceover"
      | "subtitle_align",
    extra: { ttsInstruct?: string } = {},
  ) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, direction: direction.trim() || undefined, ...extra }),
    });
    setDirection("");
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function regenerateScene(
    sceneId: string,
    target: "elements" | "scene_images",
    sceneDirection: string,
  ) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, sceneId, direction: sceneDirection.trim() || undefined }),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function regenerateCharacter(characterId: string, characterDirection: string) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "character_images",
        characterId,
        direction: characterDirection.trim() || undefined,
      }),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function continueProject() {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "continue" }),
    });
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

      {/* Nothing is queued and nothing is asking for a decision, so without
          this the project would sit here looking busy forever. */}
      {!active && detail.nextStep.kind === "run" && (
        <div
          className={`mt-6 flex items-center justify-between gap-4 rounded-md px-4 py-3 text-sm ${
            detail.stalled ? "bg-red-500/10 text-red-200" : "bg-white/5 text-white/70"
          }`}
        >
          <span>
            {detail.stalled ? "Stalled — " : project.awaitingReview ? "Waiting for you — " : ""}
            next: <span className="font-mono">{detail.nextStep.type}</span>, because{" "}
            {detail.nextStep.reason}.
          </span>
          <button
            onClick={continueProject}
            disabled={busy}
            className="shrink-0 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
          >
            {project.awaitingReview ? "Approve & continue" : "Continue"}
          </button>
        </div>
      )}

      {!active && detail.nextStep.kind === "complete" && detail.render?.assetId && (
        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Video</h2>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            controls
            src={`/api/assets/${detail.render.assetId}`}
            className="mt-3 max-h-[70vh] w-full rounded-md bg-black"
          />
        </section>
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
          <ul className="mt-3 space-y-3 text-sm">
            {detail.characters.map((character) => (
              <CharacterRow
                key={character.id}
                character={character}
                busy={busy || active}
                onRedoPortrait={(direction) => regenerateCharacter(character.id, direction)}
              />
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
              <SceneCard
                key={scene.id}
                scene={scene}
                busy={busy || active}
                onRedoPrompt={(direction) => regenerateScene(scene.id, "elements", direction)}
                onRedoImage={(direction) => regenerateScene(scene.id, "scene_images", direction)}
              />
            ))}
          </ul>
        </section>
      )}

      {detail.voiceover?.audioAssetId && (
        <NarrationPanel
          voiceover={detail.voiceover}
          cues={detail.cues}
          busy={busy || active}
          onRenarrate={(instruct) => regenerate("voiceover", { ttsInstruct: instruct })}
          onRealign={() => regenerate("subtitle_align")}
        />
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

/**
 * Narration playback with its cues.
 *
 * The cue list shows the authored text alongside what ASR heard, because the
 * two differ by design — the transcript supplies timing only — and seeing both
 * is the fastest way to tell a bad alignment from a bad transcription.
 */
function NarrationPanel({
  voiceover,
  cues,
  busy,
  onRenarrate,
  onRealign,
}: {
  voiceover: NonNullable<Detail["voiceover"]>;
  cues: Cue[];
  busy: boolean;
  onRenarrate: (instruct: string) => void;
  onRealign: () => void;
}) {
  const [instruct, setInstruct] = useState(voiceover.ttsInstruct);
  const [nowMs, setNowMs] = useState(0);

  const activeCue = cues.find((cue) => nowMs >= cue.startMs && nowMs < cue.endMs);
  const drifted = cues.filter((cue) => cue.heardText === null).length;

  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Narration</h2>
        {voiceover.durationMs && (
          <span className="text-xs text-white/35">
            {(voiceover.durationMs / 1000).toFixed(1)}s · {cues.length} cues
            {drifted > 0 && ` · ${drifted} unanchored`}
          </span>
        )}
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        controls
        src={`/api/assets/${voiceover.audioAssetId}`}
        onTimeUpdate={(event) => setNowMs(event.currentTarget.currentTime * 1000)}
        className="mt-3 w-full"
      />

      {cues.length > 0 && (
        <div className="mt-3 grid min-h-14 place-items-center rounded-md bg-black/40 px-4 py-3 text-center text-lg font-semibold">
          {activeCue?.text ?? <span className="text-sm font-normal text-white/25">—</span>}
        </div>
      )}

      <div className="mt-4">
        <label htmlFor="instruct" className="block text-sm font-medium">
          Voice design
        </label>
        <textarea
          id="instruct"
          rows={2}
          value={instruct}
          onChange={(event) => setInstruct(event.target.value)}
          className="mt-2 w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onRenarrate(instruct)}
            disabled={busy}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
          >
            Re-narrate
          </button>
          <button
            onClick={onRealign}
            disabled={busy}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
          >
            Re-align captions
          </button>
        </div>
      </div>

      {cues.length > 0 && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-white/40">cue timings</summary>
          <ul className="mt-2 space-y-1">
            {cues.map((cue) => (
              <li key={cue.id} className="flex gap-3">
                <span className="w-24 shrink-0 font-mono text-white/35">
                  {(cue.startMs / 1000).toFixed(2)}–{(cue.endMs / 1000).toFixed(2)}
                </span>
                <span className="flex-1">{cue.text}</span>
                {cue.heardText && cue.heardText.toLowerCase() !== cue.text.toLowerCase() && (
                  <span className="flex-1 text-white/30">heard: {cue.heardText}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * One scene, with its own direction field.
 *
 * The direction is local to the card rather than the page's single shared
 * input — redoing one scene's prompt should never accidentally also steer
 * the synopsis rewrite sitting above it.
 */
function SceneCard({
  scene,
  busy,
  onRedoPrompt,
  onRedoImage,
}: {
  scene: Scene;
  busy: boolean;
  onRedoPrompt: (direction: string) => void;
  onRedoImage: (direction: string) => void;
}) {
  const [direction, setDirection] = useState("");

  return (
    <li className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
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

        <input
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          placeholder="direct this scene's visuals"
          className="mt-1 w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <div className="flex gap-2 pt-0.5">
          <button
            onClick={() => onRedoPrompt(direction)}
            disabled={busy}
            className="rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
          >
            Redo prompt
          </button>
          <button
            onClick={() => onRedoImage(direction)}
            disabled={busy || !scene.imagePrompt}
            className="rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
          >
            Redo image
          </button>
        </div>
      </div>
    </li>
  );
}

/** One cast member, with its own direction field for redoing just their portrait. */
function CharacterRow({
  character,
  busy,
  onRedoPortrait,
}: {
  character: Character;
  busy: boolean;
  onRedoPortrait: (direction: string) => void;
}) {
  const [direction, setDirection] = useState("");

  return (
    <li className="flex gap-3">
      {character.imageAssetId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${character.imageAssetId}`}
          alt={character.name}
          className="h-14 w-14 shrink-0 rounded object-cover"
        />
      )}
      <div className="flex-1">
        <span className="block font-medium">{character.name}</span>
        <span className="block text-xs text-white/45">
          {character.appearanceTag ?? character.description}
        </span>
        <div className="mt-1.5 flex gap-2">
          <input
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="direct this portrait"
            className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <button
            onClick={() => onRedoPortrait(direction)}
            disabled={busy}
            className="shrink-0 rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
          >
            Redo portrait
          </button>
        </div>
      </div>
    </li>
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
