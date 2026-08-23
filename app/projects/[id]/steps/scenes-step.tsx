"use client";

import { useState } from "react";
import { aspectCss } from "@/lib/resolution";
import { ContinueBanner } from "../continue-banner";
import type { Detail, Scene } from "../detail-types";

export function ScenesStep({
  detail,
  active,
  busy,
  onRedoPrompt,
  onRedoImage,
  onGenerateMissingImages,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onRedoPrompt: (sceneId: string, direction: string) => void;
  onRedoImage: (sceneId: string, direction: string) => void;
  onGenerateMissingImages: () => void;
  onContinue: () => void;
  showContinue: boolean;
}) {
  return (
    <div>
      {showContinue && (
        <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />
      )}

      {detail.scenes.length > 0 ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
              Scenes ({detail.scenes.length})
            </h2>
            <button
              onClick={onGenerateMissingImages}
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
                aspect={aspectCss(detail.project.aspectRatio, detail.project.format)}
                busy={busy || active}
                onRedoPrompt={(direction) => onRedoPrompt(scene.id, direction)}
                onRedoImage={(direction) => onRedoImage(scene.id, direction)}
              />
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-white/35">No scenes yet.</p>
      )}
    </div>
  );
}

/**
 * One scene, with its own direction field.
 *
 * The direction is local to the card rather than a page-wide shared input —
 * redoing one scene's prompt should never accidentally also steer the
 * synopsis rewrite on a different step.
 */
export function SceneCard({
  scene,
  aspect,
  busy,
  onRedoPrompt,
  onRedoImage,
}: {
  scene: Scene;
  /** The project's own frame shape — a narrative project can be 16:9 too since M7.1 PR-E. */
  aspect: string;
  busy: boolean;
  onRedoPrompt: (direction: string) => void;
  onRedoImage: (direction: string) => void;
}) {
  const [direction, setDirection] = useState("");

  return (
    <li className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="relative bg-black/40" style={{ aspectRatio: aspect }}>
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
