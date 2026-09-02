"use client";

import { useEffect, useState } from "react";
import { PAGE_SHELL } from "@/app/components/page-shell";
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
import { DevChainCard } from "./dev-chain-card";
import { ProjectHeader } from "./project-header";
import { redoConfirmation } from "./redo-warning";

const LAYOUT_KEY = "viceroy.layout";
type Layout = "stepper" | "legacy";

export function ProjectView({ initial, basePixels }: { initial: Detail; basePixels: number }) {
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

  /**
   * Re-roll part of the narrative pipeline's coverage.
   *
   * `scope` is what makes this one function rather than two: a `sceneId` redo
   * re-briefs the scene and re-cuts every shot in it, a `shotId` redo touches
   * one picture. With a shot costing minutes of generation (F30), the
   * difference between the two is the difference between a click and an hour.
   */
  async function regenerateCoverage(
    scope: { sceneId: string } | { shotId: string },
    target: "elements" | "scene_images",
    scopeDirection: string,
  ) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, ...scope, direction: scopeDirection.trim() || undefined }),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  /**
   * Re-roll one Development-chain image — a storyboard panel, a location or
   * prop's concept-art plate (M7.1 PR-D0), or a cast member's portrait
   * (BUG-29).
   *
   * No `redoConfirmation` prompt, unlike the unscoped `regenerate` above: a
   * scoped redo skips the downstream cascade entirely, so there is nothing to
   * warn about losing. It replaces one picture and leaves the row's prompt and
   * cinematography fields alone.
   *
   * A cast portrait routes to "casting", *not* to `regenerateCharacter`'s
   * "character_images": that is the narrative pipeline's stage, and on a
   * dev-chain project it would draw the portrait from an `appearanceTag` the
   * Development chain never populates, skip the character's reference pack
   * entirely, and cascade-invalidate through `INVALIDATION_CHAIN` rather than
   * replacing the one picture the user asked about.
   */
  async function regenerateDevItem(
    scope:
      | { panelId: string }
      | { locationId: string }
      | { propId: string }
      | { characterId: string },
    itemDirection: string,
    wardrobeVariantId?: string | null,
  ) {
    const target =
      "panelId" in scope ? "storyboards" : "characterId" in scope ? "casting" : "concept_art";
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target,
        ...scope,
        direction: itemDirection.trim() || undefined,
        // Sent only when the control offered a picker — `undefined` leaves the
        // panel's existing override alone, where `null` clears it to default.
        ...(wardrobeVariantId !== undefined ? { wardrobeVariantId } : {}),
      }),
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

  // M7 PR7. No bespoke review screen for continuity (the M7 detail page's
  // own "no UI review surface beyond a flat list" scope) — this is the one
  // action `DevChainHistory`'s flat list offers per conflicting fact.
  async function resolveContinuityFact(factId: string) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}/continuity-facts/${factId}`, { method: "PATCH" });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  // M7 PR12. The explicit unlock a locked character's portrait/voice redo
  // requires — see `unlockCasting` (lib/projects.ts) and
  // `castingLockReason` (redo-warning.ts), which is what tells the user this
  // button exists in the first place.
  async function unlockCharacterCasting(characterId: string) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}/characters/${characterId}/unlock`, {
      method: "POST",
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  // M7.2. Both timeline mutations return the whole rebuilt `Timeline` (an
  // edited duration reflows every later segment's derived start), but this
  // refetches the full detail rather than merging that response in: approving
  // and redoing both change `nextStep` too, and a screen holding a merged
  // timeline next to a stale `nextStep` is exactly the kind of half-updated
  // state the polling loop exists to avoid.
  async function patchTimeline(patch: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}/timeline`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  async function patchTimelineSegment(segmentId: string, patch: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}/timeline/segments/${segmentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const response = await fetch(`/api/projects/${detail.project.id}`, { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
    setBusy(false);
  }

  /**
   * Frame shape/size. Refetches the whole detail rather than merging: the
   * timeline's reported frame is derived from these two columns, so a merged
   * response would leave the header saying one thing and the timeline another.
   */
  async function patchSettings(patch: { aspectRatio?: string; resolutionKey?: string }) {
    setBusy(true);
    await fetch(`/api/projects/${detail.project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
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
        onRedoScene={(sceneId, dir) => regenerateCoverage({ sceneId }, "elements", dir)}
        onRedoShotPrompt={(shotId, dir) => regenerateCoverage({ shotId }, "elements", dir)}
        onRedoShotImage={(shotId, dir) => regenerateCoverage({ shotId }, "scene_images", dir)}
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
    <main className={`${PAGE_SHELL} py-8 pb-24`}>
      {/* The layout toggle only governs the narrative stepper. A movie project
          has no stepper for it to switch, and a control that does nothing is
          worse than no control. The "all projects" link that sat beside it is
          now the nav's Projects entry, on every screen rather than this one. */}
      {project.format === "short_video_narrative" && (
        <div className="flex justify-end">
          <button
            onClick={() => setLayoutAndPersist(layout === "stepper" ? "legacy" : "stepper")}
            className="text-xs text-white/30 transition hover:text-white/60"
          >
            {layout === "stepper" ? "switch to single-page view" : "switch to step view"}
          </button>
        </div>
      )}

      <ProjectHeader
        detail={detail}
        basePixels={basePixels}
        active={active}
        busy={busy}
        onPatchSettings={patchSettings}
      />

      {project.failureReason && (
        <p className="mt-6 rounded-md bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          {project.failureReason}
        </p>
      )}

      {project.format !== "short_video_narrative" ? (
        // The narrative Stepper below is built entirely around
        // PROJECT_STAGES/JOB_TYPES — reusing it for the Development chain
        // would mean teaching it a second, unrelated stage vocabulary for no
        // benefit yet, since PR1 has nothing to show per stage but "not yet
        // generated" anyway. PR2+ can grow this into its own stepper once
        // there's per-stage content worth stepping between.
        <div className="mt-6">
          <DevChainCard
            detail={detail}
            active={active}
            busy={busy}
            onContinue={continueProject}
            onResolveContinuityFact={resolveContinuityFact}
            onUnlockCasting={unlockCharacterCasting}
            onRedoDevItem={regenerateDevItem}
            onPatchTimeline={patchTimeline}
            onPatchSegment={patchTimelineSegment}
          />
        </div>
      ) : layout === "stepper" ? (
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
