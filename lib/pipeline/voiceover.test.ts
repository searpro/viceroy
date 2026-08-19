import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { characters, projects, scenes, subtitleCues, voiceovers } from "../db/schema";
import { claim, enqueue, listJobs } from "../queue";
import { createProject } from "../projects";
import {
  assertPlausibleDuration,
  readWavSampleRate,
  runSubtitleAlign,
  runVoiceover,
} from "./voiceover";
import { silentWav, stubContext } from "./test-support";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

const SCENE_SCRIPTS = [
  "The pipes burst on a Tuesday.",
  "Nobody at city hall answered.",
  "He fixed it himself before noon.",
];
const NARRATION = SCENE_SCRIPTS.join(" ");

function projectWithScenes(mode: "auto" | "manual" = "auto") {
  const project = createProject(db, { idea: "a plumber became mayor by wits", mode });
  claim(db);
  db.update(projects).set({ story: NARRATION }).where(eq(projects.id, project.id)).run();
  db.insert(scenes)
    .values(
      SCENE_SCRIPTS.map((script, index) => ({
        projectId: project.id,
        index,
        description: `Scene ${index}`,
        voiceoverScript: script,
      })),
    )
    .run();
  return project;
}

describe("runVoiceover", () => {
  it("speaks the whole narration in a single call", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runVoiceover(stubContext(db, job, { onSpeechRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toBe(NARRATION);
  });

  // Per-scene synthesis drifts audibly between clips; this is why scenes carry
  // verbatim spans in the first place.
  it("narrates exactly the approved story, reassembled from the scenes", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });
    await runVoiceover(stubContext(db, job));

    const row = db.select().from(voiceovers).where(eq(voiceovers.projectId, project.id)).get()!;
    expect(row.script).toBe(
      db.select().from(projects).where(eq(projects.id, project.id)).get()!.story,
    );
  });

  it("sends the voice style's design cues as the instruction", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runVoiceover(stubContext(db, job, { onSpeechRequest: (r) => requests.push(r) }));

    expect(requests[0]!.instruct).toMatch(/gravelly/i);
  });

  it("lets the user's redirection override the style's cues", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, {
      type: "voiceover",
      projectId: project.id,
      payload: { ttsInstruct: "a breathless young woman speaking fast" },
    });

    const requests: Record<string, unknown>[] = [];
    await runVoiceover(stubContext(db, job, { onSpeechRequest: (r) => requests.push(r) }));

    expect(requests[0]!.instruct).toBe("a breathless young woman speaking fast");
    expect(
      db.select().from(voiceovers).where(eq(voiceovers.projectId, project.id)).get()!.ttsInstruct,
    ).toBe("a breathless young woman speaking fast");
  });

  it("stores the audio and its duration", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });
    await runVoiceover(stubContext(db, job, { speech: { durationMs: 12_340 } }));

    const row = db.select().from(voiceovers).where(eq(voiceovers.projectId, project.id)).get()!;
    expect(row.audioAssetId).toBeTruthy();
    expect(row.durationMs).toBe(12_340);
    expect(row.sampleRate).toBe(24_000);
  });

  // Cues are offsets into an audio file that no longer exists.
  it("discards existing cues when the narration is regenerated", async () => {
    const project = projectWithScenes();
    const scene = db.select().from(scenes).where(eq(scenes.projectId, project.id)).get()!;
    db.insert(subtitleCues)
      .values({ projectId: project.id, sceneId: scene.id, index: 0, text: "stale", startMs: 0, endMs: 1 })
      .run();

    const job = enqueue(db, { type: "voiceover", projectId: project.id });
    await runVoiceover(stubContext(db, job));

    expect(db.select().from(subtitleCues).where(eq(subtitleCues.projectId, project.id)).all()).toHaveLength(0);
  });

  it("queues alignment in auto mode and stops for review in manual", async () => {
    const auto = projectWithScenes();
    await runVoiceover(stubContext(db, enqueue(db, { type: "voiceover", projectId: auto.id })));
    expect(listJobs(db, { projectId: auto.id }).map((j) => j.type)).toContain("subtitle_align");

    const manual = projectWithScenes("manual");
    await runVoiceover(stubContext(db, enqueue(db, { type: "voiceover", projectId: manual.id })));
    expect(db.select().from(projects).where(eq(projects.id, manual.id)).get()!.awaitingReview).toBe(
      true,
    );
    expect(listJobs(db, { projectId: manual.id }).map((j) => j.type)).not.toContain(
      "subtitle_align",
    );
  });

  it("refuses a project with no scenes", async () => {
    const project = createProject(db, { idea: "an idea long enough to pass" });
    const job = enqueue(db, { type: "voiceover", projectId: project.id });
    await expect(runVoiceover(stubContext(db, job))).rejects.toThrow(/no scenes/);
  });

  // A model that truncates a long input returns a valid shorter clip and no
  // error. Nothing downstream notices: the transcript matches the audio, and
  // the video just stops narrating halfway through.
  it("refuses narration too short to be the whole script", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });

    await expect(
      runVoiceover(stubContext(db, job, { speech: { durationMs: 1_000 } })),
    ).rejects.toThrow(/truncated/);
    expect(db.select().from(voiceovers).where(eq(voiceovers.projectId, project.id)).get()).toBeUndefined();
  });

  it("refuses narration too long to be speech", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "voiceover", projectId: project.id });

    await expect(
      runVoiceover(stubContext(db, job, { speech: { durationMs: 600_000 } })),
    ).rejects.toThrow(/looped or stalled/);
  });

  it("accepts an unusual but plausible delivery", () => {
    const script = new Array(100).fill("word").join(" ");
    // 100 words in 30s is 200wpm — brisk, and not truncation.
    expect(() => assertPlausibleDuration(script, 30_000)).not.toThrow();
    // 100 words in 90s is 67wpm — slow and grave, still speech.
    expect(() => assertPlausibleDuration(script, 90_000)).not.toThrow();
  });
});

describe("runSubtitleAlign", () => {
  /** Transcript matching NARRATION, 400ms a word. */
  function heardNarration() {
    return NARRATION.split(" ").map((word, index) => ({
      word: word.toLowerCase().replace(/[^a-z]/g, ""),
      startMs: index * 400,
      endMs: (index + 1) * 400,
    }));
  }

  async function narrated() {
    const project = projectWithScenes();
    await runVoiceover(
      stubContext(db, enqueue(db, { type: "voiceover", projectId: project.id }), {
        speech: { durationMs: NARRATION.split(" ").length * 400 },
      }),
    );
    return project;
  }

  it("writes cues carrying the authored wording, scoped to their scene", async () => {
    const project = await narrated();
    const job = enqueue(db, { type: "subtitle_align", projectId: project.id });

    await runSubtitleAlign(stubContext(db, job, { transcript: heardNarration() }));

    const cues = db
      .select()
      .from(subtitleCues)
      .where(eq(subtitleCues.projectId, project.id))
      .orderBy(asc(subtitleCues.index))
      .all();

    expect(cues.length).toBeGreaterThan(0);
    // Every cue belongs to a scene, and the text is the writer's, capitals and
    // punctuation intact — not the lowercase stripped transcript.
    expect(cues.every((c) => c.sceneId)).toBe(true);
    expect(cues.map((c) => c.text).join(" ")).toBe(NARRATION);
  });

  it("gives each scene a start and end on the timeline", async () => {
    const project = await narrated();
    const job = enqueue(db, { type: "subtitle_align", projectId: project.id });
    await runSubtitleAlign(stubContext(db, job, { transcript: heardNarration() }));

    const rows = db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.index))
      .all();

    expect(rows.every((s) => s.startMs !== null && s.endMs !== null)).toBe(true);
    expect(rows[0]!.startMs).toBe(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.startMs!).toBeGreaterThanOrEqual(rows[i - 1]!.endMs!);
    }
  });

  it("passes the known duration so the drift guard can fire", async () => {
    const project = await narrated();
    const job = enqueue(db, { type: "subtitle_align", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSubtitleAlign(
      stubContext(db, job, { transcript: heardNarration(), onTranscribeRequest: (r) => requests.push(r) }),
    );

    expect(requests[0]!.expectedDurationMs).toBe(NARRATION.split(" ").length * 400);
    // The stored narration goes up as bytes; there is no upload hop anymore.
    expect(Buffer.isBuffer(requests[0]!.audio)).toBe(true);
    expect((requests[0]!.audio as Buffer).toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("re-running replaces cues rather than duplicating them", async () => {
    const project = await narrated();
    for (const _ of [0, 1]) {
      const job = enqueue(db, { type: "subtitle_align", projectId: project.id });
      await runSubtitleAlign(stubContext(db, job, { transcript: heardNarration() }));
    }

    const cues = db.select().from(subtitleCues).where(eq(subtitleCues.projectId, project.id)).all();
    expect(new Set(cues.map((c) => c.index)).size).toBe(cues.length);
    expect(cues.map((c) => c.text).join(" ")).toBe(NARRATION);
  });

  // If the scenes no longer partition the narration, cues cannot be assigned
  // to images and silently mis-timing them would be worse than stopping.
  it("refuses when the scenes no longer account for the narration", async () => {
    const project = await narrated();
    const scene = db.select().from(scenes).where(eq(scenes.projectId, project.id)).get()!;
    db.update(scenes)
      .set({ voiceoverScript: "completely different words entirely here" })
      .where(eq(scenes.id, scene.id))
      .run();

    const job = enqueue(db, { type: "subtitle_align", projectId: project.id });
    await expect(
      runSubtitleAlign(stubContext(db, job, { transcript: heardNarration() })),
    ).rejects.toThrow(/no longer partition/);
  });

  it("refuses a project with no narration", async () => {
    const project = projectWithScenes();
    const job = enqueue(db, { type: "subtitle_align", projectId: project.id });
    await expect(runSubtitleAlign(stubContext(db, job))).rejects.toThrow(/no generated narration/);
  });
});

describe("readWavSampleRate", () => {
  it("reads the rate out of a WAV header", () => {
    expect(readWavSampleRate(silentWav(44_100))).toBe(44_100);
  });

  it("returns null for something that is not a WAV", () => {
    expect(readWavSampleRate(Buffer.from("not audio at all"))).toBeNull();
  });
});
