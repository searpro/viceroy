"use client";

import { useState } from "react";
import {
  formatDuration,
  formatTimecode,
  groupIssues,
  issueSummary,
  layoutBlocks,
  rulerTicks,
  type TimelineIssueView,
  type TimelineSegmentView,
  type TimelineView,
} from "../timeline-view";
import type { Detail, TimelineTargetOption } from "../detail-types";

/**
 * The production timeline's review surface (M7.2).
 *
 * Reads as a Director-style track: one block per planned clip, sized in
 * proportion to its duration, with its keyframe as the thumbnail and a ruler
 * above. Selecting a block opens its fields.
 *
 * **Nothing in this file names LTX.** The target picker is populated from
 * `detail.timelineTargets`, the ceilings and frame-rate choices come off that
 * target's `constraints`, and every warning is text the target itself
 * produced. Adding Wan or Minimax later changes the registry on the server
 * and nothing here — which is the whole reason the timeline is a neutral
 * shape rather than a Director payload with a UI bolted on.
 */
export function TimelineStep({
  detail,
  busy,
  onPatchTimeline,
  onPatchSegment,
}: {
  detail: Detail;
  busy: boolean;
  onPatchTimeline: (patch: Record<string, unknown>) => void;
  onPatchSegment: (segmentId: string, patch: Record<string, unknown>) => void;
}) {
  const timeline = detail.timeline;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!timeline) {
    return <p className="text-sm text-white/50">Not yet assembled.</p>;
  }

  const issues = detail.timelineIssues ?? [];
  const { bySegment, overall } = groupIssues(issues);
  const summary = issueSummary(issues);
  const target = (detail.timelineTargets ?? []).find((option) => option.id === timeline.targetId);
  const selected = timeline.segments.find((segment) => segment.id === selectedId) ?? null;

  return (
    <div className="space-y-5">
      <TimelineHeader
        timeline={timeline}
        targets={detail.timelineTargets ?? []}
        target={target}
        summary={summary}
        busy={busy}
        onPatchTimeline={onPatchTimeline}
      />

      {overall.length > 0 && <IssueList issues={overall} />}

      <Track
        timeline={timeline}
        bySegment={bySegment}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      {selected ? (
        <SegmentInspector
          key={selected.id}
          segment={selected}
          issues={bySegment.get(selected.index) ?? []}
          assets={detail.timelineAssets ?? []}
          busy={busy}
          onPatchSegment={onPatchSegment}
        />
      ) : (
        <p className="text-xs text-white/40">Select a segment to edit its prompt, duration and keyframes.</p>
      )}

      <a
        href={`/api/projects/${detail.project.id}/timeline/export`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-200"
      >
        view compiled payload for {target?.label ?? timeline.targetId}
      </a>
    </div>
  );
}

function TimelineHeader({
  timeline,
  targets,
  target,
  summary,
  busy,
  onPatchTimeline,
}: {
  timeline: TimelineView;
  targets: TimelineTargetOption[];
  target: TimelineTargetOption | undefined;
  summary: string | null;
  busy: boolean;
  onPatchTimeline: (patch: Record<string, unknown>) => void;
}) {
  const [globalPrompt, setGlobalPrompt] = useState(timeline.globalPrompt);
  // A frame rate the target cannot emit is still offered, because a stored
  // one has to remain visible in the control that shows it — the target's own
  // validation is what says it is wrong.
  const fpsChoices = [...new Set([...(target?.constraints.fpsChoices ?? []), timeline.fps])].sort(
    (a, b) => a - b,
  );

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/60">
        <label className="flex items-center gap-2">
          <span className="text-white/40">Target</span>
          <select
            value={timeline.targetId}
            disabled={busy}
            onChange={(event) => onPatchTimeline({ targetId: event.target.value })}
            className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          >
            {targets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-white/40">fps</span>
          <select
            value={timeline.fps}
            disabled={busy}
            onChange={(event) => onPatchTimeline({ fps: Number(event.target.value) })}
            className="rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          >
            {fpsChoices.map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </label>

        <span>
          <span className="text-white/40">Length </span>
          {formatTimecode(timeline.totalDurationMs)}
        </span>
        <span>
          <span className="text-white/40">Segments </span>
          {timeline.segments.length}
        </span>
        <span>
          <span className="text-white/40">Frame </span>
          {timeline.width}×{timeline.height} ({timeline.aspectRatio})
        </span>
        {summary && <span className="text-amber-300">{summary}</span>}
      </div>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-white/40">Global prompt</span>
        <textarea
          value={globalPrompt}
          disabled={busy}
          rows={2}
          onChange={(event) => setGlobalPrompt(event.target.value)}
          onBlur={() => {
            if (globalPrompt !== timeline.globalPrompt) onPatchTimeline({ globalPrompt });
          }}
          className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-sm text-white/85"
          placeholder="Style and world anchor applied across every segment"
        />
      </label>
    </div>
  );
}

/**
 * The track itself.
 *
 * Blocks are absolutely positioned by percentage so their widths stay
 * proportional at any container size — a six-second shot next to a
 * two-second one has to *look* like it, which is the entire reason this is a
 * track and not the list `ShotListSection` already shows.
 */
function Track({
  timeline,
  bySegment,
  selectedId,
  onSelect,
}: {
  timeline: TimelineView;
  bySegment: Map<number, TimelineIssueView[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const blocks = layoutBlocks(timeline.segments, timeline.totalDurationMs);
  const ticks = rulerTicks(timeline.totalDurationMs);
  const byId = new Map(blocks.map((block) => [block.id, block]));

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px] space-y-1">
        <div className="relative h-4">
          {ticks.map((tick) => (
            <span
              key={tick.ms}
              style={{ left: `${tick.percent}%` }}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] text-white/35"
            >
              {tick.label}
            </span>
          ))}
        </div>

        <div className="relative h-32 rounded-md border border-white/10 bg-black/30">
          {timeline.segments.map((segment) => {
            const block = byId.get(segment.id)!;
            const segmentIssues = bySegment.get(segment.index) ?? [];
            const hasError = segmentIssues.some((issue) => issue.severity === "error");
            const hasWarning = segmentIssues.length > 0 && !hasError;
            const selected = segment.id === selectedId;

            return (
              <button
                key={segment.id}
                type="button"
                onClick={() => onSelect(segment.id)}
                style={{ left: `${block.leftPercent}%`, width: `${block.widthPercent}%` }}
                title={`${segment.label} — ${formatTimecode(segment.startMs)} to ${formatTimecode(
                  segment.startMs + segment.durationMs,
                )}`}
                className={`absolute inset-y-1 overflow-hidden rounded border text-left transition ${
                  selected
                    ? "border-amber-300 ring-1 ring-amber-300/50"
                    : hasError
                      ? "border-red-400/70"
                      : hasWarning
                        ? "border-amber-400/50"
                        : "border-white/15 hover:border-white/35"
                }`}
              >
                {segment.startKeyframeAssetId ? (
                  <img
                    src={`/api/assets/${segment.startKeyframeAssetId}`}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover opacity-50"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/35">
                    no keyframe
                  </span>
                )}
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 text-[10px] text-white/80">
                  {segment.index + 1}. {formatDuration(segment.durationMs)}
                </span>
                {hasError && (
                  <span className="absolute right-1 top-1 rounded bg-red-500/80 px-1 text-[9px] text-white">!</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SegmentInspector({
  segment,
  issues,
  assets,
  busy,
  onPatchSegment,
}: {
  segment: TimelineSegmentView;
  issues: TimelineIssueView[];
  assets: { id: string; label: string }[];
  busy: boolean;
  onPatchSegment: (segmentId: string, patch: Record<string, unknown>) => void;
}) {
  const [videoPrompt, setVideoPrompt] = useState(segment.videoPrompt);
  const [notes, setNotes] = useState(segment.notes);
  const [durationSeconds, setDurationSeconds] = useState((segment.durationMs / 1000).toFixed(1));

  const commitDuration = () => {
    const ms = Math.round(Number(durationSeconds) * 1000);
    if (Number.isFinite(ms) && ms !== segment.durationMs) onPatchSegment(segment.id, { durationMs: ms });
  };

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-white/60">
        <span className="text-sm font-medium text-white/85">
          {segment.index + 1}. {segment.label}
        </span>
        <span>
          {formatTimecode(segment.startMs)} – {formatTimecode(segment.startMs + segment.durationMs)}
        </span>
        <span className="text-white/40">
          {segment.camera.shotType} · {segment.camera.angle} · {segment.camera.movement} · {segment.camera.lens}
        </span>
      </div>

      {issues.length > 0 && <IssueList issues={issues} />}

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-white/40">Video prompt (motion)</span>
        <textarea
          value={videoPrompt}
          disabled={busy}
          rows={3}
          onChange={(event) => setVideoPrompt(event.target.value)}
          onBlur={() => {
            if (videoPrompt !== segment.videoPrompt) onPatchSegment(segment.id, { videoPrompt });
          }}
          className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1.5 text-sm text-white/85"
        />
      </label>

      {/* The still register, shown but not editable here: it belongs to the
          shot list, and giving it a second editable home is exactly the
          two-owners-for-one-register mistake this codebase has paid for. */}
      <p className="text-[11px] text-white/50">
        <span className="text-white/35">Keyframe prompt (from the shot list): </span>
        {segment.keyframePrompt || "—"}
      </p>

      <DialogueList lines={segment.dialogue} />

      <div className="grid gap-3 sm:grid-cols-3">
        <AudioField
          label="Ambience"
          hint="the space itself"
          value={segment.ambience}
          busy={busy}
          onCommit={(ambience) => onPatchSegment(segment.id, { ambience })}
        />
        <AudioField
          label="Foley"
          hint="sounds tied to motion"
          value={segment.foley}
          busy={busy}
          onCommit={(foley) => onPatchSegment(segment.id, { foley })}
        />
        <AudioField
          label="Music"
          hint="genre, tempo, mood"
          value={segment.music}
          busy={busy}
          onCommit={(music) => onPatchSegment(segment.id, { music })}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <KeyframePicker
          label="Start keyframe"
          value={segment.startKeyframeAssetId}
          assets={assets}
          busy={busy}
          onChange={(assetId) => onPatchSegment(segment.id, { startKeyframeAssetId: assetId })}
        />
        <KeyframePicker
          label="End keyframe"
          value={segment.endKeyframeAssetId}
          assets={assets}
          busy={busy}
          onChange={(assetId) => onPatchSegment(segment.id, { endKeyframeAssetId: assetId })}
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs text-white/60">
          <span className="text-white/40">Duration</span>
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={durationSeconds}
            disabled={busy}
            onChange={(event) => setDurationSeconds(event.target.value)}
            onBlur={commitDuration}
            className="w-20 rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          />
          <span className="text-white/40">s</span>
        </label>

        <label className="flex items-center gap-2 text-xs text-white/60">
          <span className="text-white/40">Guide strength</span>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            defaultValue={segment.guideStrength}
            disabled={busy}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value !== segment.guideStrength) {
                onPatchSegment(segment.id, { guideStrength: value });
              }
            }}
            className="w-20 rounded border border-white/15 bg-black/40 px-2 py-1 text-white/85"
          />
        </label>
      </div>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-white/40">Notes</span>
        <input
          value={notes}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            if (notes !== segment.notes) onPatchSegment(segment.id, { notes });
          }}
          className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1 text-sm text-white/85"
        />
      </label>
    </div>
  );
}

/**
 * The lines spoken in this segment — read-only, on purpose.
 *
 * The words belong to the screenplay, which is their single owner. Editing
 * them here would leave the timeline disagreeing with the artifact they came
 * from — and because those exact words are what a caption shows once LTX has
 * spoken them, the caption would then disagree with the audio too. The fix
 * for a line that does not fit is the duration field, which is exactly what
 * the "would be cut off" warning asks for.
 */
function DialogueList({ lines }: { lines: TimelineSegmentView["dialogue"] }) {
  if (lines.length === 0) {
    return <p className="text-[11px] text-white/35">No dialogue in this shot.</p>;
  }
  return (
    <div className="space-y-1.5 rounded border border-white/10 bg-black/20 p-2.5">
      <span className="text-[11px] uppercase tracking-wide text-white/40">
        Dialogue — from the screenplay, spoken by the model
      </span>
      {lines.map((line, i) => (
        <p key={i} className="text-xs text-white/80">
          <span className="text-white/50">{line.characterName}</span>
          {line.delivery ? (
            <span className="text-white/35"> ({line.delivery})</span>
          ) : (
            <span className="text-amber-300/80"> (no locked voice)</span>
          )}
          <span className="text-white/50">: </span>
          {line.parenthetical && <span className="text-white/35">{line.parenthetical} </span>}
          &ldquo;{line.line}&rdquo;
        </p>
      ))}
    </div>
  );
}

function AudioField({
  label,
  hint,
  value,
  busy,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  busy: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-white/40">{label}</span>
      <input
        value={draft}
        disabled={busy}
        placeholder={hint}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        className="mt-1 w-full rounded border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/85"
      />
    </label>
  );
}

function KeyframePicker({
  label,
  value,
  assets,
  busy,
  onChange,
}: {
  label: string;
  value: string | null;
  assets: { id: string; label: string }[];
  busy: boolean;
  onChange: (assetId: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-[11px] uppercase tracking-wide text-white/40">{label}</span>
      <div className="flex items-start gap-2">
        {value ? (
          <img
            src={`/api/assets/${value}`}
            alt={label}
            className="h-16 w-16 rounded border border-white/10 object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded border border-white/10 text-[10px] text-white/35">
            none
          </div>
        )}
        <select
          value={value ?? ""}
          disabled={busy}
          onChange={(event) => onChange(event.target.value || null)}
          className="min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/85"
        >
          <option value="">— none —</option>
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.label || asset.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function IssueList({ issues }: { issues: TimelineIssueView[] }) {
  return (
    <ul className="space-y-1">
      {issues.map((issue, i) => (
        <li
          key={i}
          className={`text-[11px] ${issue.severity === "error" ? "text-red-300" : "text-amber-300/90"}`}
        >
          {issue.severity === "error" ? "✕" : "!"} {issue.message}
        </li>
      ))}
    </ul>
  );
}
