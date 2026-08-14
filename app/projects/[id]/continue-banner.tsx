import type { Detail } from "./detail-types";

/**
 * Manual-mode "Approve & continue" / stalled-recovery "Continue" banner.
 *
 * Rendered inside whichever step's content currently corresponds to
 * `detail.nextStep.type`, rather than as page-wide chrome, so it sits next
 * to the work it's actually about.
 */
export function ContinueBanner({
  detail,
  active,
  busy,
  onContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onContinue: () => void;
}) {
  if (active || detail.nextStep.kind !== "run") return null;

  return (
    <div
      className={`mb-6 flex items-center justify-between gap-4 rounded-md px-4 py-3 text-sm ${
        detail.stalled ? "bg-red-500/10 text-red-200" : "bg-white/5 text-white/70"
      }`}
    >
      <span>
        {detail.stalled ? "Stalled — " : detail.project.awaitingReview ? "Waiting for you — " : ""}
        next: <span className="font-mono">{detail.nextStep.type}</span>, because {detail.nextStep.reason}.
      </span>
      <button
        onClick={onContinue}
        disabled={busy}
        className="shrink-0 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
      >
        {detail.project.awaitingReview ? "Approve & continue" : "Continue"}
      </button>
    </div>
  );
}
