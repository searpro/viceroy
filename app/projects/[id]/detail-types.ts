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
  appearanceTag: string | null;
  imageAssetId: string | null;
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
    mode: string;
    awaitingReview: boolean;
    failureReason: string | null;
  };
  narrativeStyle?: { name: string };
  voiceStyle?: { name: string };
  evaluations: Evaluation[];
  nextStep: { kind: "run" | "complete"; type?: string; reason: string };
  stalled: boolean;
  scenes: Scene[];
  characters: Character[];
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
