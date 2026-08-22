// Shared shape of the client-side project detail payload, used by
// `project-view.tsx` and every step/stepper component that consumes it.
// Kept in its own module (rather than only in `project-view.tsx`) so
// `stepper.tsx` and `jobs-bar.tsx` can import the types without importing
// the whole page component.

export type Job = {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "aborted";
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: string | null;
};

export type Evaluation = {
  id: string;
  iteration: number;
  verdict: string;
  overallScore: number | null;
  dimensions: Record<string, { score: number; comment: string }>;
  issues: { severity: string; note: string }[];
};

export type Scene = {
  id: string;
  index: number;
  description: string;
  storyboard: string | null;
  imagePrompt: string | null;
  voiceoverScript: string;
  imageAssetId: string | null;
};

export type Character = {
  id: string;
  name: string;
  description: string;
  arc: string | null;
  appearanceTag: string | null;
  imagePrompt: string | null;
  imageAssetId: string | null;
  imageSource: "generated" | "uploaded";
};

// One row per Development-chain stage that owns a `dev_artifacts` row —
// "characters" and "world_building" write their own tables instead (see
// `characters`/`worldBuilding` below), same as the API's `latestDevArtifactsByStage`.
export type DevArtifact = {
  id: string;
  stage: string;
  version: number;
  content: string;
  approvedAt: string | null;
};

export type WorldBuilding = {
  id: string;
  content: string;
  approvedAt: string | null;
};

export type LocationOrProp = {
  id: string;
  name: string;
  description: string;
  imageAssetId: string | null;
};

// M7 PR7. Same "own table, not a `dev_artifacts` row" story as `Character`/
// `WorldBuilding` above — "continuity" is a `DEV_CHAIN_STAGES` entry that
// writes `continuity_facts` directly.
export type ContinuityFact = {
  id: string;
  sceneId: string | null;
  subjectType: "character" | "location" | "prop";
  subjectName: string;
  fact: string;
  source: "extracted" | "conflict" | "resolved";
  resolvedAt: string | null;
};

// M7 PR10. Same "own table, not a `dev_artifacts` row" story as
// `ContinuityFact`/`LocationOrProp` above — "storyboards" is a
// `DEV_CHAIN_STAGES` entry that writes `storyboard_panels` directly. The four
// cinematography fields are surfaced independently, per the M7 detail page's
// own "selects, not prose" acceptance bar — never baked into
// `panelImagePrompt` as the only place they show up.
export type StoryboardPanel = {
  id: string;
  sceneId: string;
  index: number;
  panelImagePrompt: string;
  shotType: string;
  cameraAngle: string;
  cameraMovement: string;
  lens: string;
  panelImageAssetId: string | null;
  approvedAt: string | null;
};

export type Cue = {
  id: string;
  index: number;
  text: string;
  heardText: string | null;
  startMs: number;
  endMs: number;
};

export type Detail = {
  project: {
    id: string;
    idea: string;
    synopsis: string | null;
    story: string | null;
    stage: string;
    // What kind of thing this project is making (M7 PR1). Anything other
    // than "short_video_narrative" runs the Development chain instead of
    // the narrative pipeline every other field/step here still describes.
    format: string;
    mode: string;
    awaitingReview: boolean;
    failureReason: string | null;
  };
  narrativeStyle?: { name: string };
  voiceStyle?: { name: string };
  evaluations: Evaluation[];
  // "dev" is the Development chain's counterpart to "run" — it names a
  // dev_artifacts stage instead of a job type, because that chain has no
  // generation logic yet (PR2+ scope).
  nextStep: { kind: "run" | "dev" | "complete"; type?: string; stage?: string; reason: string };
  stalled: boolean;
  scenes: Scene[];
  characters: Character[];
  devArtifacts: DevArtifact[];
  worldBuilding?: WorldBuilding | null;
  locations: LocationOrProp[];
  props: LocationOrProp[];
  continuityFacts: ContinuityFact[];
  storyboardPanels: StoryboardPanel[];
  render?: { id: string; assetId: string | null; status: string } | null;
  voiceover?: {
    id: string;
    ttsInstruct: string;
    audioAssetId: string | null;
    durationMs: number | null;
  } | null;
  cues: Cue[];
  jobs: Job[];
};

export const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

export function statusColour(status: Job["status"]): string {
  if (status === "succeeded") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "aborted") return "text-white/40";
  if (status === "running") return "text-amber-300";
  return "text-white/50";
}
