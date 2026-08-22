"use client";

import { Panel } from "./steps/panel";
import type { Detail } from "./detail-types";

/**
 * The Development chain's review card (M7 PR1).
 *
 * A dev-format project's `nextStep` names a `dev_artifacts` stage instead of
 * a job type — there is no per-stage step component yet because there is no
 * generation logic yet (PR2+ builds concept/logline/etc one at a time). This
 * is the whole UI for now: report which stage is next and show it empty,
 * the same way any other step already reads before its first job has run.
 */
export function DevChainCard({ detail }: { detail: Detail }) {
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
      <p className="rounded-md bg-white/5 px-4 py-3 text-sm text-white/70">
        Development chain — next: <span className="font-mono">{stage ?? "—"}</span>
        {nextStep.reason ? `, because ${nextStep.reason}.` : "."}
      </p>

      <Panel title={stage ?? "Development"} empty emptyText="Not yet generated.">
        <></>
      </Panel>
    </div>
  );
}
