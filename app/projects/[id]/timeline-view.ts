/**
 * Pure helpers for the production timeline's track view (M7.2).
 *
 * Its own module, without React, for the same reason `redo-warning.ts` and
 * `dev-stages.ts` are: this is the part with arithmetic in it, and arithmetic
 * that lays blocks out on a track is worth a test that does not need a DOM.
 *
 * The client cannot import `lib/timeline/targets` — that module is safe
 * enough on its own, but `lib/timeline/store.ts` next to it pulls in
 * better-sqlite3 via `lib/config`, and the constraint metadata a screen needs
 * arrives on the wire with the detail payload anyway. So the types here
 * mirror `lib/timeline/types.ts` the same hand-kept way `DEV_STAGE_LABELS`
 * mirrors `DEV_CHAIN_STAGES`.
 */

/** Mirrors `DialogueLine` in lib/timeline/speech.ts. */
export type DialogueLineView = {
  characterId: string | null;
  characterName: string;
  parenthetical: string;
  line: string;
  delivery: string;
};

/** Mirrors `TimelineSegment` in lib/timeline/types.ts. */
export type TimelineSegmentView = {
  id: string;
  index: number;
  sceneId: string;
  label: string;
  startMs: number;
  durationMs: number;
  videoPrompt: string;
  keyframePrompt: string;
  startKeyframeAssetId: string | null;
  endKeyframeAssetId: string | null;
  guideStrength: number;
  /** M7.2 — the audio register. Mirrors `TimelineSegment` in lib/timeline/types.ts. */
  dialogue: DialogueLineView[];
  ambience: string;
  foley: string;
  music: string;
  camera: { shotType: string; angle: string; movement: string; lens: string };
  characterIds: string[];
  notes: string;
};

/** Mirrors `Timeline` in lib/timeline/types.ts. */
export type TimelineView = {
  projectId: string;
  targetId: string;
  fps: number;
  width: number;
  height: number;
  aspectRatio: string;
  globalPrompt: string;
  totalDurationMs: number;
  segments: TimelineSegmentView[];
  audio: { assetId: string; durationMs: number } | null;
};

/** Mirrors `TimelineIssue`. */
export type TimelineIssueView = {
  severity: "error" | "warning";
  segmentIndex: number | null;
  message: string;
};

/**
 * `m:ss.s` — a film timeline reads in minutes and seconds, and a tenth is the
 * finest distinction a duration edit here can meaningfully make.
 *
 * Hours are shown only when there are any, rather than padding every short
 * film's timecodes with a permanent `0:`.
 */
export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const tenths = Math.floor((safe % 1000) / 100);
  const totalSeconds = Math.floor(safe / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${ss}.${tenths}`;
}

/** `4.0s` — for a duration, where a timecode would imply a position. */
export function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export type SegmentBlock = {
  id: string;
  /** Percentage of the track's width. */
  widthPercent: number;
  /** Percentage offset from the track's left edge. */
  leftPercent: number;
};

/**
 * Where each segment sits on a track of fixed width.
 *
 * Proportional to duration, which is the whole point of looking at a timeline
 * rather than a list — a six-second shot next to a two-second one should look
 * like it.
 *
 * `MIN_BLOCK_PERCENT` keeps a very short segment clickable. It deliberately
 * makes the track sum to slightly over 100% in the pathological case (many
 * sub-second segments), which is the right trade: an unclickable block is a
 * bug, a track that scrolls a little is not.
 */
const MIN_BLOCK_PERCENT = 2;

export function layoutBlocks(segments: TimelineSegmentView[], totalMs: number): SegmentBlock[] {
  if (segments.length === 0) return [];
  // A zero-length timeline would divide by zero; share the track equally
  // instead, so a malformed timeline still renders something clickable.
  const span = totalMs > 0 ? totalMs : segments.length;

  return segments.map((segment, i) => ({
    id: segment.id,
    widthPercent: Math.max(
      MIN_BLOCK_PERCENT,
      ((totalMs > 0 ? segment.durationMs : 1) / span) * 100,
    ),
    leftPercent: ((totalMs > 0 ? segment.startMs : i) / span) * 100,
  }));
}

/**
 * Tick marks for the ruler above the track.
 *
 * The interval is chosen so a timeline lands between six and twenty ticks
 * whatever its length — a 12-second animatic wants two-second marks and a
 * five-minute film wants thirty-second ones, and hard-coding either makes the
 * other unreadable.
 */
const TICK_INTERVALS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export function rulerTicks(totalMs: number): { ms: number; percent: number; label: string }[] {
  if (totalMs <= 0) return [];
  const interval =
    TICK_INTERVALS_MS.find((candidate) => totalMs / candidate <= 12) ??
    TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1]!;

  const ticks: { ms: number; percent: number; label: string }[] = [];
  for (let ms = 0; ms <= totalMs; ms += interval) {
    ticks.push({ ms, percent: (ms / totalMs) * 100, label: formatTimecode(ms) });
  }
  return ticks;
}

/** Issues that belong to one segment, plus the whole-timeline ones separately. */
export function groupIssues(issues: TimelineIssueView[]) {
  const bySegment = new Map<number, TimelineIssueView[]>();
  const overall: TimelineIssueView[] = [];
  for (const issue of issues) {
    if (issue.segmentIndex === null) {
      overall.push(issue);
      continue;
    }
    const existing = bySegment.get(issue.segmentIndex);
    if (existing) existing.push(issue);
    else bySegment.set(issue.segmentIndex, [issue]);
  }
  return { bySegment, overall };
}

/** "3 errors, 1 warning" — or null when a timeline is clean. */
export function issueSummary(issues: TimelineIssueView[]): string | null {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  if (errors === 0 && warnings === 0) return null;
  return [
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : null,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}
