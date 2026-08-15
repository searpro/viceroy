"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Detail } from "./detail-types";
import { ACTIVE_JOB_STATUSES } from "./detail-types";
import { JobsBar } from "./jobs-bar";
import {
  STEPS,
  StepNavButtons,
  Stepper,
  computeAutoAdvance,
  computeInitialStep,
  stepForNextStep,
  type StepId,
} from "./stepper";
import { SynopsisStoryStep } from "./steps/synopsis-story-step";
import { CharactersStep } from "./steps/characters-step";
import { ScenesStep } from "./steps/scenes-step";
import { NarrationStep } from "./steps/narration-step";
import { VideoStep } from "./steps/video-step";
import { redoConfirmation } from "./redo-warning";

const LAYOUT_KEY = "viceroy.layout";
type Layout = "stepper" | "legacy";

export function ProjectView({ initial }: { initial: Detail }) {
  const [detail, setDetail] = useState(initial);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);

  // Client-only preference (guideline 1): no server round trip, no schema
  // change. Read once on mount so the initial server-rendered markup and the
  // first client render agree before the flag can take effect.
  const [layout, setLayout] = useState<Layout>("stepper");
  useEffect(() => {
    const stored = window.localStorage.getItem(LAYOUT_KEY);
    if (stored === "stepper" || stored === "legacy") setLayout(stored);
  }, []);

  function setLayoutAndPersist(next: Layout) {
    setLayout(next);
    window.localStorage.setItem(LAYOUT_KEY, next);
  }

  const [activeStep, setActiveStep] = useState<StepId>(() => computeInitialStep(initial));
  const [userNavigated, setUserNavigated] = useState(false);

  function selectStep(id: StepId) {
    setUserNavigated(true);
    setActiveStep(id);
  }

  const active = detail.jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status));

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

  // Live auto-advance (guideline 6): follow the pipeline forward only while
  // the user hasn't manually navigated away, and only ever forward.
  useEffect(() => {
    setActiveStep((current) => computeAutoAdvance(current, userNavigated, detail));
  }, [detail, userNavigated]);

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
    // An unscoped redo discards everything derived from that stage (ADR 0003),
    // which on a finished project is hours of generation and, for an uploaded
    // portrait, something the pipeline cannot recreate at all. The old
    // behaviour destroyed some of this silently and left the rest stale; now
    // that it is consistent, it is worth confirming.
    const confirmation = redoConfirmation(target, detail);
    if (confirmation && !window.confirm(confirmation)) return;

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

  async function uploadCharacterImage(characterId: string, file: File) {
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    await fetch(`/api/projects/${detail.project.id}/characters/${characterId}/image`, {
      method: "POST",
      body: form,
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function clearCharacterImage(characterId: string) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}/characters/${characterId}/image`, {
      method: "DELETE",
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
  const currentPipelineStep = stepForNextStep(detail.nextStep);

  // Manual mode's Cast step has its own per-character "Generate"/"Use my
  // photo" controls (BUG-5) — once the cast list exists, portrait generation
  // is a per-row choice, not a stage the generic "Approve & continue" banner
  // should bulk-fire for every character at once.
  const castAwaitsPerCharacterChoice =
    project.mode === "manual" &&
    detail.nextStep.kind === "run" &&
    detail.nextStep.type === "character_images";

  const stepContent: Record<StepId, React.ReactNode> = {
    story: (
      <SynopsisStoryStep
        detail={detail}
        active={active}
        busy={busy}
        direction={direction}
        onDirectionChange={setDirection}
        onRedoSynopsis={() => regenerate("synopsis")}
        onRedoStory={() => regenerate("story")}
        onContinue={continueProject}
        showContinue={currentPipelineStep === "story"}
      />
    ),
    cast: (
      <CharactersStep
        detail={detail}
        active={active}
        busy={busy}
        onRedoPortrait={(characterId, dir) => regenerateCharacter(characterId, dir)}
        onUploadImage={(characterId, file) => uploadCharacterImage(characterId, file)}
        onClearImage={(characterId) => clearCharacterImage(characterId)}
        onContinue={continueProject}
        showContinue={currentPipelineStep === "cast" && !castAwaitsPerCharacterChoice}
      />
    ),
    scenes: (
      <ScenesStep
        detail={detail}
        active={active}
        busy={busy}
        onRedoPrompt={(sceneId, dir) => regenerateScene(sceneId, "elements", dir)}
        onRedoImage={(sceneId, dir) => regenerateScene(sceneId, "scene_images", dir)}
        onGenerateMissingImages={() => regenerate("scene_images")}
        onContinue={continueProject}
        showContinue={currentPipelineStep === "scenes"}
      />
    ),
    narration: (
      <NarrationStep
        detail={detail}
        active={active}
        busy={busy}
        onRenarrate={(instruct) => regenerate("voiceover", { ttsInstruct: instruct })}
        onRealign={() => regenerate("subtitle_align")}
        onContinue={continueProject}
        showContinue={currentPipelineStep === "narration"}
      />
    ),
    video: (
      <VideoStep
        detail={detail}
        active={active}
        busy={busy}
        onContinue={continueProject}
        showContinue={currentPipelineStep === "video"}
      />
    ),
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-14 pb-24">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
          ← all projects
        </Link>
        <button
          onClick={() => setLayoutAndPersist(layout === "stepper" ? "legacy" : "stepper")}
          className="text-xs text-white/30 transition hover:text-white/60"
        >
          {layout === "stepper" ? "switch to single-page view" : "switch to step view"}
        </button>
      </div>

      <header className="mt-4">
        <h1 className="line-clamp-2 text-xl font-semibold leading-snug" title={project.idea}>
          {project.idea}
        </h1>
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

      {layout === "stepper" ? (
        <>
          <Stepper activeStep={activeStep} onSelect={selectStep} detail={detail} />
          <div className="mt-6">{stepContent[activeStep]}</div>
          <StepNavButtons activeStep={activeStep} onSelect={selectStep} />
        </>
      ) : (
        <div className="mt-6 space-y-6">
          {STEPS.map((step) => (
            <div key={step.id}>{stepContent[step.id]}</div>
          ))}
        </div>
      )}

      <JobsBar jobs={detail.jobs} jobAction={jobAction} />
    </main>
  );
}
