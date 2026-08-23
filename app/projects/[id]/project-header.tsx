"use client";

import { useState } from "react";
import { formatLabel, isDevFormat } from "@/lib/labels";
import { ASPECT_RATIOS, resolutionPresetsFor, projectAspect } from "@/lib/resolution";
import type { Detail } from "./detail-types";

/**
 * The project's identity strip.
 *
 * It used to print `narrativeStyle · voiceStyle · mode · stage` for every
 * project. On a movie that is actively misleading: `createProject` assigns a
 * narrative and a voice style to every project because those columns are NOT
 * NULL, and the Development chain reads neither — so a short movie's header
 * advertised "Fast Conversational Commentary" twice over while saying nothing
 * about the direction style and production design style its 22 stages actually
 * use. The header now shows whichever pair its own pipeline reads.
 *
 * The frame controls are here rather than on a settings screen because of what
 * they are for: every project made before M7.1 PR-E stores 1080x1920 and no
 * aspect, so every existing movie is a vertical short until someone changes
 * it, and the place you notice that is the page showing you portrait panels.
 */
export function ProjectHeader({
  detail,
  basePixels,
  active,
  busy,
  onPatchSettings,
}: {
  detail: Detail;
  basePixels: number;
  active: boolean;
  busy: boolean;
  onPatchSettings: (patch: { aspectRatio?: string; resolutionKey?: string }) => void;
}) {
  const { project } = detail;
  const dev = isDevFormat(project.format);
  const [editing, setEditing] = useState(false);

  const aspect = projectAspect(project);
  const width = project.width ?? 0;
  const height = project.height ?? 0;
  // The stored shape and the stored dimensions can disagree, and did for every
  // pre-PR-E movie: aspect null (so, landscape by format) with a 1080x1920
  // frame on disk. Saying so is more useful than silently showing one of them.
  const mismatched = width > 0 && height > 0 && Math.abs(width / height / ratioOf(aspect) - 1) > 0.02;

  const styles = dev
    ? [detail.directionStyle?.name, detail.productionDesignStyle?.name]
    : [detail.narrativeStyle?.name, detail.voiceStyle?.name];

  return (
    <header className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            dev ? "bg-sky-400/10 text-sky-300" : "bg-white/5 text-white/40"
          }`}
        >
          {formatLabel(project.format, true)}
        </span>
        {project.awaitingReview && (
          <span className="rounded bg-amber-300/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
            needs review
          </span>
        )}
        {active && (
          <span className="flex items-center gap-1.5 text-[11px] text-amber-300">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-300" />
            working…
          </span>
        )}
      </div>

      <h1 className="mt-2 line-clamp-2 text-xl font-semibold leading-snug" title={project.idea}>
        {project.idea}
      </h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
        {styles.filter(Boolean).map((name) => (
          <span key={name}>{name}</span>
        ))}
        {styles.every((name) => !name) && (
          <span className="text-white/25">
            {dev ? "no direction or production design style set" : "no styles set"}
          </span>
        )}
        <span aria-hidden>·</span>
        <span>{project.mode} mode</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{project.stage}</span>
        <span aria-hidden>·</span>
        <button
          onClick={() => setEditing((value) => !value)}
          className={`transition hover:text-white/70 ${mismatched ? "text-amber-300" : ""}`}
          title="Frame shape and size"
        >
          {width && height ? `${width}×${height}` : aspect} ({aspect}){mismatched ? " ⚠" : ""}
        </button>
      </div>

      {editing && (
        <FrameSettings
          detail={detail}
          basePixels={basePixels}
          busy={busy}
          mismatched={mismatched}
          onPatchSettings={(patch) => {
            onPatchSettings(patch);
            setEditing(false);
          }}
        />
      )}
    </header>
  );
}

function ratioOf(key: string): number {
  return ASPECT_RATIOS.find((entry) => entry.key === key)?.ratio ?? 1;
}

function FrameSettings({
  detail,
  basePixels,
  busy,
  mismatched,
  onPatchSettings,
}: {
  detail: Detail;
  basePixels: number;
  busy: boolean;
  mismatched: boolean;
  onPatchSettings: (patch: { aspectRatio?: string; resolutionKey?: string }) => void;
}) {
  const { project } = detail;
  const [aspect, setAspect] = useState(projectAspect(project));
  // The preset labels are pixel dimensions, which depend on the shape being
  // chosen right now — not on the one stored.
  const presets = resolutionPresetsFor(basePixels, aspect);
  const [resolutionKey, setResolutionKey] = useState(nearestPresetKey(presets, project));

  const generated =
    detail.storyboardPanels.length > 0 ||
    detail.shotListItems.length > 0 ||
    detail.scenes.some((scene) => scene.imageAssetId) ||
    detail.characters.some((character) => character.imageAssetId);

  const changed = aspect !== projectAspect(project) || resolutionKey !== nearestPresetKey(presets, project);

  return (
    <div className="mt-3 rounded-lg border border-white/15 bg-white/[0.03] p-3">
      <p className="text-xs text-white/55">
        Frame shape and size. Changing these affects what is generated <em>next</em> — nothing
        already produced is re-rendered or discarded.
      </p>
      {mismatched && (
        <p className="mt-2 text-xs text-amber-300">
          This project&apos;s stored dimensions don&apos;t match its shape — it was created before a
          project could carry an aspect ratio, so it kept the global vertical default. Re-saving
          here fixes it.
        </p>
      )}
      {generated && (
        <p className="mt-2 text-xs text-white/40">
          Images already exist at the current size. They keep their pixels; a re-roll picks up the
          new one.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="block text-white/40">Aspect ratio</span>
          <select
            value={aspect}
            onChange={(event) => setAspect(event.target.value as typeof aspect)}
            className="mt-1 rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          >
            {ASPECT_RATIOS.map((option) => (
              <option key={option.key} value={option.key} className="bg-neutral-900">
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs">
          <span className="block text-white/40">Resolution</span>
          <select
            value={resolutionKey}
            onChange={(event) => setResolutionKey(event.target.value)}
            className="mt-1 rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          >
            {presets.map((preset) => (
              <option key={preset.key} value={preset.key} className="bg-neutral-900">
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={() => onPatchSettings({ aspectRatio: aspect, resolutionKey })}
          disabled={busy || (!changed && !mismatched)}
          className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          Save frame
        </button>
      </div>
    </div>
  );
}

function nearestPresetKey(
  presets: { key: string; width: number; height: number }[],
  project: { width?: number | null; height?: number | null },
): string {
  if (!project.width || !project.height) return "hd";
  const pixels = project.width * project.height;
  let nearest = presets.find((preset) => preset.key === "hd") ?? presets[0]!;
  for (const preset of presets) {
    if (Math.abs(preset.width * preset.height - pixels) < Math.abs(nearest.width * nearest.height - pixels)) {
      nearest = preset;
    }
  }
  return nearest.key;
}
