"use client";

import { Panel } from "./panel";
import { ContinueBanner } from "../continue-banner";
import type { Detail } from "../detail-types";

export function SynopsisStoryStep({
  detail,
  active,
  busy,
  direction,
  onDirectionChange,
  onRedoSynopsis,
  onRedoStory,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  direction: string;
  onDirectionChange: (value: string) => void;
  onRedoSynopsis: () => void;
  onRedoStory: () => void;
  onContinue: () => void;
  showContinue: boolean;
}) {
  const { project } = detail;
  const latestEvaluation = detail.evaluations[0];

  return (
    <div>
      {showContinue && (
        <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />
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
            onChange={(event) => onDirectionChange(event.target.value)}
            placeholder="make the opening colder and cut the backstory"
            className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={onRedoSynopsis}
              disabled={busy || active}
              className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
            >
              Redo synopsis
            </button>
            <button
              onClick={onRedoStory}
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
    </div>
  );
}
