"use client";

import { Panel } from "./steps/panel";
import { ContinueBanner } from "./continue-banner";
import type { Detail } from "./detail-types";

/**
 * The Development chain's review card (M7 PR1, generate/approve wiring added
 * once PR2/PR3 gave the chain something to generate).
 *
 * A dev-format project's `nextStep` names a `dev_artifacts` stage instead of
 * a job type; there is still no per-stage step component (PR4+ can grow one
 * once there's per-stage content worth reviewing beyond raw text). Until
 * then this reuses the same `ContinueBanner` every narrative step already
 * uses to dispatch/approve work — `advance()` in `lib/pipeline/chain.ts`
 * already handles both an empty stage (enqueue it) and a pending one
 * (approve, then re-derive and enqueue the next), so no dev-specific action
 * is needed here beyond calling the same `onContinue`.
 */
export function DevChainCard({
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
  const { nextStep } = detail;

  if (nextStep.kind === "complete") {
    return (
      <Panel title="Development" empty={false} emptyText="">
        <p className="text-sm text-white/85">{nextStep.reason}</p>
      </Panel>
    );
  }

  const stage = nextStep.kind === "dev" ? nextStep.stage : undefined;

  return (
    <div>
      <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />

      <Panel title={stage ?? "Development"} empty emptyText="Not yet generated.">
        <></>
      </Panel>
    </div>
  );
}
