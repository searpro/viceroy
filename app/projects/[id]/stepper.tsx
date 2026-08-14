"use client";

import type { Detail } from "./detail-types";

export type StepId = "story" | "cast" | "scenes" | "narration" | "video";

export type StepDefinition = {
  id: StepId;
  label: string;
  /** True once this step's output already exists, regardless of whether it's current. */
  isComplete: (detail: Detail) => boolean;
  /**
   * Whether `nextStep` (what the pipeline wants to do next) belongs to this
   * step. `elements` produces both scenes and characters; per the confirmed
   * decision it maps to Cast, not Scenes, so Cast must be checked first.
   */
  matchesNextStep: (nextStep: Detail["nextStep"]) => boolean;
};

// Five steps, collapsing the nine job types. Order matters: `computeStepIndex`
// and the initial-landing logic below rely on this being the pipeline's
// natural reading order.
export const STEPS: StepDefinition[] = [
  {
    id: "story",
    label: "Story",
    isComplete: (detail) => Boolean(detail.project.story),
    matchesNextStep: (nextStep) =>
      nextStep.kind === "run" &&
      (nextStep.type === "synopsis" ||
        nextStep.type === "story" ||
        nextStep.type === "story_eval" ||
        nextStep.type === "story_revise"),
  },
  {
    id: "cast",
    label: "Cast",
    isComplete: (detail) =>
      detail.characters.length > 0 && detail.characters.every((c) => c.imageAssetId !== null),
    // `elements` is ambiguous between Cast and Scenes (it produces both). Per
    // the confirmed scope decision, it lands on Cast — natural pipeline
    // reading order runs Cast before Scenes.
    matchesNextStep: (nextStep) =>
      nextStep.kind === "run" && (nextStep.type === "elements" || nextStep.type === "character_images"),
  },
  {
    id: "scenes",
    label: "Scenes",
    isComplete: (detail) =>
      detail.scenes.length > 0 && detail.scenes.every((s) => s.imageAssetId !== null),
    matchesNextStep: (nextStep) => nextStep.kind === "run" && nextStep.type === "scene_images",
  },
  {
    id: "narration",
    label: "Narration",
    isComplete: (detail) => Boolean(detail.voiceover?.audioAssetId) && detail.cues.length > 0,
    matchesNextStep: (nextStep) =>
      nextStep.kind === "run" && (nextStep.type === "voiceover" || nextStep.type === "subtitle_align"),
  },
  {
    id: "video",
    label: "Video",
    isComplete: (detail) => Boolean(detail.render?.assetId),
    matchesNextStep: (nextStep) => nextStep.kind === "run" && nextStep.type === "render",
  },
];

/** Which step the pipeline currently wants to work on, per `nextStep`. */
export function stepForNextStep(nextStep: Detail["nextStep"]): StepId {
  const match = STEPS.find((step) => step.matchesNextStep(nextStep));
  return match ? match.id : "story";
}

/**
 * Where a project should land when first opened. A finished render always
 * wins — the pipeline has nothing left to say about `nextStep` at that
 * point, so deriving from it would just fall through to "story".
 */
export function computeInitialStep(detail: Detail): StepId {
  if (detail.nextStep.kind === "complete") return "video";
  return stepForNextStep(detail.nextStep);
}

export function stepIndex(id: StepId): number {
  return STEPS.findIndex((step) => step.id === id);
}

/**
 * The live auto-advance rule (guideline 6): while the user hasn't manually
 * navigated away, the shell may follow the pipeline forward — but only
 * forward, and only when the currently-viewed step is the one that just
 * finished. It must never yank the user backward or sideways.
 */
export function computeAutoAdvance(
  currentStep: StepId,
  userNavigated: boolean,
  detail: Detail,
): StepId {
  if (userNavigated) return currentStep;
  const target = computeInitialStep(detail);
  if (stepIndex(target) > stepIndex(currentStep)) return target;
  return currentStep;
}

export function Stepper({
  activeStep,
  onSelect,
  detail,
}: {
  activeStep: StepId;
  onSelect: (id: StepId) => void;
  detail: Detail;
}) {
  const active = detail.jobs.some((job) => job.status === "queued" || job.status === "running");
  const currentPipelineStep = stepForNextStep(detail.nextStep);

  return (
    <nav className="mt-4 flex flex-wrap gap-2" aria-label="Project steps">
      {STEPS.map((step) => {
        const isActive = step.id === activeStep;
        const complete = step.isComplete(detail);
        const isWorking = active && currentPipelineStep === step.id;
        return (
          <button
            key={step.id}
            onClick={() => onSelect(step.id)}
            aria-current={isActive ? "step" : undefined}
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition ${
              isActive
                ? "border-white/35 bg-white/10 text-white"
                : "border-white/10 text-white/50 hover:border-white/25 hover:text-white/80"
            }`}
          >
            <span
              className={
                complete
                  ? "text-emerald-400"
                  : isWorking
                    ? "text-amber-300"
                    : "text-white/25"
              }
            >
              {complete ? "✓" : isWorking ? "…" : "○"}
            </span>
            {step.label}
          </button>
        );
      })}
    </nav>
  );
}

export function StepNavButtons({
  activeStep,
  onSelect,
}: {
  activeStep: StepId;
  onSelect: (id: StepId) => void;
}) {
  const index = stepIndex(activeStep);
  const prev = index > 0 ? STEPS[index - 1] : null;
  const next = index < STEPS.length - 1 ? STEPS[index + 1] : null;

  return (
    <div className="mt-4 flex justify-between gap-2">
      <button
        onClick={() => prev && onSelect(prev.id)}
        disabled={!prev}
        className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-30"
      >
        ← {prev?.label ?? ""}
      </button>
      <button
        onClick={() => next && onSelect(next.id)}
        disabled={!next}
        className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-30"
      >
        {next?.label ?? ""} →
      </button>
    </div>
  );
}
