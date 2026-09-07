"use client";

import { useState } from "react";
import { aspectCss } from "@/lib/resolution";
import { ContinueBanner } from "../continue-banner";
import type { Detail, Scene, Shot } from "../detail-types";

export function ScenesStep({
  detail,
  active,
  busy,
  onRedoScene,
  onRedoShotPrompt,
  onRedoShotImage,
  onGenerateMissingImages,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onRedoScene: (sceneId: string, direction: string) => void;
  onRedoShotPrompt: (shotId: string, direction: string) => void;
  onRedoShotImage: (shotId: string, direction: string) => void;
  onGenerateMissingImages: () => void;
  onContinue: () => void;
  showContinue: boolean;
}) {
  const shots = detail.shots ?? [];
  const total = shots.length;

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
              {total > 0 && <span className="ml-2 normal-case text-white/25">{total} shots</span>}
            </h2>
            <button
              onClick={onGenerateMissingImages}
              disabled={busy || active}
              className="text-xs text-white/40 transition hover:text-amber-300 disabled:opacity-40"
            >
              generate missing images
            </button>
          </div>

          <ul className="mt-3 space-y-3">
            {detail.scenes.map((scene) => (
              <SceneRow
                key={scene.id}
                scene={scene}
                shots={shots.filter((shot) => shot.sceneId === scene.id).sort((a, b) => a.index - b.index)}
                aspect={aspectCss(detail.project.aspectRatio, detail.project.format)}
                busy={busy || active}
                onRedoScene={(direction) => onRedoScene(scene.id, direction)}
                onRedoShotPrompt={onRedoShotPrompt}
                onRedoShotImage={onRedoShotImage}
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
 * One scene: its narration and brief, above the strip of shots covering it.
 *
 * A scene is no longer a picture, so it no longer gets a picture-shaped card.
 * What it owns is the span of narration and the look every shot in it is drawn
 * against; the pictures belong to the shots, and they read as a strip because
 * that is the order they appear in the finished video.
 */
export function SceneRow({
  scene,
  shots,
  aspect,
  busy,
  onRedoScene,
  onRedoShotPrompt,
  onRedoShotImage,
}: {
  scene: Scene;
  shots: Shot[];
  /** The project's own frame shape — a narrative project can be 16:9 too since M7.1 PR-E. */
  aspect: string;
  busy: boolean;
  onRedoScene: (direction: string) => void;
  onRedoShotPrompt: (shotId: string, direction: string) => void;
  onRedoShotImage: (shotId: string, direction: string) => void;
}) {
  const [direction, setDirection] = useState("");

  // A project finished before M9 has no shots at all — its single still hangs
  // on the scene. Showing it as a one-shot strip keeps the screen readable
  // rather than reporting an old project as empty.
  const strip: Shot[] =
    shots.length > 0
      ? shots
      : scene.imageAssetId
        ? [
            {
              id: scene.id,
              sceneId: scene.id,
              index: 0,
              shotType: "scene",
              storyboard: scene.storyboard,
              imagePrompt: scene.imagePrompt,
              imageAssetId: scene.imageAssetId,
              startMs: null,
              endMs: null,
            },
          ]
        : [];

  return (
    <li className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <div className="space-y-1.5 p-3">
        <div className="flex items-baseline gap-2">
          <span className="rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-white/50">
            {scene.index + 1}
          </span>
          <p className="text-xs font-medium">{scene.description}</p>
        </div>
        <p className="text-xs leading-relaxed text-white/55">{scene.voiceoverScript}</p>
        {scene.visualBrief && (
          <details className="text-[11px] text-white/35">
            <summary className="cursor-pointer">scene brief</summary>
            <p className="mt-1 leading-relaxed">{scene.visualBrief}</p>
          </details>
        )}
      </div>

      {strip.length > 0 ? (
        <ul className="flex gap-2 overflow-x-auto px-3 pb-3">
          {strip.map((shot) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              aspect={aspect}
              busy={busy}
              // A pre-M9 still is not a shot and has nothing to re-roll on its
              // own; redoing the scene is what upgrades it to real coverage.
              onRedoPrompt={shots.length > 0 ? onRedoShotPrompt : undefined}
              onRedoImage={shots.length > 0 ? onRedoShotImage : undefined}
            />
          ))}
        </ul>
      ) : (
        <p className="px-3 pb-3 text-[11px] text-white/25">No shots yet.</p>
      )}

      <div className="space-y-1.5 border-t border-white/[0.06] p-3">
        <input
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          placeholder="direct this scene's look"
          className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <button
          onClick={() => onRedoScene(direction)}
          disabled={busy}
          className="rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
        >
          Redo scene
        </button>
        <p className="text-[10px] leading-relaxed text-white/25">
          Rewrites the scene&apos;s brief and re-cuts its coverage — every shot here is planned and
          drawn again. To change one picture, use the controls on that shot.
        </p>
      </div>
    </li>
  );
}

/** How long this shot holds, once alignment has placed it. */
function heldFor(shot: Shot): string | null {
  if (shot.startMs === null || shot.endMs === null) return null;
  return `${((shot.endMs - shot.startMs) / 1000).toFixed(1)}s`;
}

export function ShotCard({
  shot,
  aspect,
  busy,
  onRedoPrompt,
  onRedoImage,
}: {
  shot: Shot;
  aspect: string;
  busy: boolean;
  onRedoPrompt?: (shotId: string, direction: string) => void;
  onRedoImage?: (shotId: string, direction: string) => void;
}) {
  const [direction, setDirection] = useState("");
  const held = heldFor(shot);

  return (
    <li className="w-40 shrink-0 overflow-hidden rounded border border-white/10 bg-black/20">
      <div className="relative bg-black/40" style={{ aspectRatio: aspect }}>
        {shot.imageAssetId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/assets/${shot.imageAssetId}`}
            alt={shot.storyboard ?? `Shot ${shot.index + 1}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-[10px] text-white/25">
            {shot.imagePrompt ? "generating" : "no image yet"}
          </span>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide">
          {shot.shotType.replace(/_/g, " ")}
        </span>
        {held && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 py-0.5 font-mono text-[9px]">
            {held}
          </span>
        )}
      </div>

      <div className="space-y-1 p-2">
        {shot.storyboard && <p className="text-[10px] leading-snug text-white/55">{shot.storyboard}</p>}
        {shot.imagePrompt && (
          <details className="text-[10px] text-white/30">
            <summary className="cursor-pointer">prompt</summary>
            <p className="mt-1 leading-relaxed">{shot.imagePrompt}</p>
          </details>
        )}

        {onRedoPrompt && onRedoImage && (
          <>
            <input
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="direct this shot"
              className="w-full rounded border border-white/10 bg-black/20 px-1.5 py-1 text-[10px] outline-none placeholder:text-white/25 focus:border-white/25"
            />
            <div className="flex gap-1">
              <button
                onClick={() => onRedoPrompt(shot.id, direction)}
                disabled={busy}
                className="rounded border border-white/15 px-1.5 py-1 text-[10px] transition hover:border-white/35 disabled:opacity-40"
              >
                Prompt
              </button>
              <button
                onClick={() => onRedoImage(shot.id, direction)}
                disabled={busy || !shot.imagePrompt}
                className="rounded border border-white/15 px-1.5 py-1 text-[10px] transition hover:border-white/35 disabled:opacity-40"
              >
                Image
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
