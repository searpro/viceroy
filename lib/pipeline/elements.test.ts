import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, characters, projects, scenes } from "../db/schema";
import { claim, enqueue, listJobs } from "../queue";
import { createProject } from "../projects";
import { runElements } from "./elements";
import { runCharacterImages, runSceneImages } from "./images";
import { stubContext } from "./test-support";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

const STORY =
  "The pipes burst on a Tuesday. Nobody at city hall answered the phone. " +
  "He fixed it himself before noon. The photograph went everywhere. " +
  "By spring he was on the ballot. He won by four votes.";

function projectWithStory(mode: "auto" | "manual" = "auto") {
  const project = createProject(db, { idea: "a plumber became mayor by wits", mode });
  claim(db);
  db.update(projects)
    .set({ synopsis: "A synopsis.", story: STORY })
    .where(eq(projects.id, project.id))
    .run();
  return project;
}

const CAST = {
  json: {
    characters: [
      { name: "the plumber", description: "An unassuming tradesman.", appearance: "wiry man in his fifties, navy overalls" },
    ],
  },
};

const BEATS = {
  json: {
    scenes: [
      { startSentence: 0, endSentence: 1, description: "The burst pipe" },
      { startSentence: 2, endSentence: 3, description: "The fix and the photo" },
      { startSentence: 4, endSentence: 5, description: "The election" },
    ],
  },
};

const sceneDetail = (n: number) => ({
  json: {
    storyboard: `Storyboard ${n}`,
    imagePrompt: `wiry man in his fifties, navy overalls, scene ${n}`,
    characters: ["the plumber"],
  },
});

describe("runElements", () => {
  it("extracts a cast, splits the story, and visualises every scene", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(cast).toHaveLength(1);
    expect(cast[0]!.appearanceTag).toBe("wiry man in his fifties, navy overalls");

    const rows = db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.index))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.every((s) => s.imagePrompt && s.storyboard)).toBe(true);
    expect(rows[0]!.characterIds).toEqual([cast[0]!.id]);
  });

  // The property the whole design rests on: the voiceover is generated once,
  // from the whole narration, so the scene scripts must reassemble it exactly.
  it("stores verbatim narration spans that concatenate back to the story", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );

    const rows = db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.index))
      .all();
    expect(rows.map((s) => s.voiceoverScript).join(" ")).toBe(STORY);
  });

  // Portraits must come first: scene images reference them (ADR 0001).
  it("queues character portraits, not scene images, in auto mode", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );

    const queued = listJobs(db, { projectId: project.id }).map((j) => j.type);
    expect(queued).toContain("character_images");
    expect(queued).not.toContain("scene_images");
  });

  it("stops for review in manual mode", async () => {
    const project = projectWithStory("manual");
    const job = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );

    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(
      true,
    );
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain(
      "character_images",
    );
  });

  // On this hardware a restart costs minutes, so a retry must not redo work.
  it("resumes rather than restarting when scenes are already visualised", async () => {
    const project = projectWithStory();
    const first = enqueue(db, { type: "elements", projectId: project.id });

    // Fail partway: two scene details, then nothing left to serve.
    await expect(
      runElements(stubContext(db, first, { llm: [CAST, BEATS, sceneDetail(1)] })),
    ).resolves.toBeUndefined();

    const afterFirst = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all();
    expect(afterFirst).toHaveLength(3);

    // A second run must not create a second cast or a second set of scenes.
    const second = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(stubContext(db, second, { llm: [sceneDetail(9)] }));

    expect(db.select().from(characters).where(eq(characters.projectId, project.id)).all()).toHaveLength(1);
    expect(db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()).toHaveLength(3);
  });

  it("fails when a scene comes back without an image prompt", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    await expect(
      runElements(
        stubContext(db, job, { llm: [CAST, BEATS, { json: { storyboard: "x", imagePrompt: "" } }] }),
      ),
    ).rejects.toThrow(/without an image prompt/);
  });

  it("refuses a project with no story", async () => {
    const project = createProject(db, { idea: "an idea with enough length" });
    const job = enqueue(db, { type: "elements", projectId: project.id });
    await expect(runElements(stubContext(db, job, { llm: [CAST] }))).rejects.toThrow(/no story/);
  });

  // A per-scene redo clears only that scene's prompt before enqueueing; the
  // direction supplied with the job must reach the one scene being redone.
  it("threads a direction into the visualisation prompt for a redone scene", async () => {
    const project = await (async () => {
      const p = projectWithStory();
      const first = enqueue(db, { type: "elements", projectId: p.id });
      await runElements(
        stubContext(db, first, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
      );
      return p;
    })();

    const target = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()[0]!;
    db.update(scenes)
      .set({ imagePrompt: null, storyboard: null })
      .where(eq(scenes.id, target.id))
      .run();

    const job = enqueue(db, {
      type: "elements",
      projectId: project.id,
      payload: { sceneId: target.id, direction: "make it rain" },
    });

    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, { llm: [sceneDetail(9)], onChatJsonRequest: (r) => prompts.push(r) }),
    );

    expect(prompts).toHaveLength(1);
    const messages = prompts[0]!.messages as { content: string }[];
    expect(messages[0]!.content).toContain("make it rain");
  });

  it("carries on when the story has no characters in it", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    await runElements(
      stubContext(db, job, {
        llm: [{ json: { characters: [] } }, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
      }),
    );

    expect(db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()).toHaveLength(3);
  });

  // VIC-003: character/scene invention is where fabrication tends to
  // reappear even when the story text stayed faithful, so the grounding
  // clause must reach elements.characters and elements.scene, not just the
  // synopsis/story stages.
  it("threads the grounding clause into the character and scene prompts in Context mode", async () => {
    const project = createProject(db, {
      inputMode: "context",
      context: "The plumber, Hal Griffin, fixed the main on March 3rd and later ran for mayor.",
    });
    claim(db);
    db.update(projects)
      .set({ synopsis: "A synopsis.", story: STORY })
      .where(eq(projects.id, project.id))
      .run();

    const job = enqueue(db, { type: "elements", projectId: project.id });
    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    const contents = prompts.map((p) => (p.messages as { content: string }[])[0]!.content);
    // Prompt order is characters, then beats, then one per scene.
    expect(contents[0]).toContain("do not introduce");
    expect(contents[2]).toContain("do not introduce");
  });

  it("leaves the character and scene prompts free of the grounding clause in Idea mode", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });
    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    const contents = prompts.map((p) => (p.messages as { content: string }[])[0]!.content);
    expect(contents[0]).not.toContain("do not introduce");
    expect(contents[2]).not.toContain("do not introduce");
  });
});

describe("runCharacterImages", () => {
  async function elementsOnly(mode: "auto" | "manual" = "auto") {
    const project = projectWithStory(mode);
    const job = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );
    return project;
  }

  // The name is what scenes point at; without storing it every frame would
  // have to re-upload the same portrait.
  it("uploads each portrait to sd-api and stores the returned name", async () => {
    const project = await elementsOnly();
    const job = enqueue(db, { type: "character_images", projectId: project.id });

    await runCharacterImages(stubContext(db, job));

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(cast[0]!.imageAssetId).toBeTruthy();
    expect(cast[0]!.refInputName).toBe(`uploaded-${cast[0]!.id}.png`);
  });

  it("continues to scene images in auto mode", async () => {
    const project = await elementsOnly();
    const job = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, job));
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("scene_images");
  });

  // A malformed portrait propagates into every frame it appears in, so manual
  // mode gets a chance to catch it before eight minutes of generation.
  it("stops for portrait review in manual mode", async () => {
    const project = await elementsOnly("manual");
    const job = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, job));

    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(
      true,
    );
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain("scene_images");
  });

  it("passes straight through when the story depicts nobody", async () => {
    const project = projectWithStory();
    const elements = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(
      stubContext(db, elements, {
        llm: [{ json: { characters: [] } }, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
      }),
    );

    const job = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, job));

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("scene_images");
  });

  it("skips a character that already has a portrait", async () => {
    const project = await elementsOnly();

    const first = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, first));

    const second = enqueue(db, { type: "character_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, second, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(0);
  });

  // A per-character redo clears just that portrait; the direction supplied
  // with the job must land on that character's prompt.
  it("appends a direction to the redone character's prompt only", async () => {
    const project = await elementsOnly();
    const first = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, first));

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    db.update(characters)
      .set({ imageAssetId: null, refInputName: null })
      .where(eq(characters.id, cast[0]!.id))
      .run();

    const job = enqueue(db, {
      type: "character_images",
      projectId: project.id,
      payload: { characterId: cast[0]!.id, direction: "wearing a red scarf" },
    });

    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toMatch(/wearing a red scarf$/);
  });
});

describe("runSceneImages", () => {
  async function elementsDone(mode: "auto" | "manual" = "auto") {
    const project = projectWithStory(mode);
    const job = enqueue(db, { type: "elements", projectId: project.id });
    await runElements(
      stubContext(db, job, { llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)] }),
    );
    return project;
  }

  /** Elements, then portraits — the state scene images actually run against. */
  async function portraitsDone() {
    const project = await elementsDone();
    const job = enqueue(db, { type: "character_images", projectId: project.id });
    await runCharacterImages(stubContext(db, job));
    return project;
  }

  it("passes the portraits of characters appearing in the scene as references", async () => {
    const project = await portraitsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(requests[0]!.ref_images).toEqual([cast[0]!.refInputName]);
  });

  // Without a portrait there is nothing to reference, and sending an empty
  // array would be a different request than sending none.
  it("omits ref_images entirely when no character has a portrait", async () => {
    const project = await elementsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests[0]).not.toHaveProperty("ref_images");
  });

  it("sets increase_ref_index only when a frame carries more than one face", async () => {
    const project = await portraitsDone();
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();

    const single = enqueue(db, { type: "scene_images", projectId: project.id });
    const singleRequests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, single, { onImageRequest: (r) => singleRequests.push(r) }));
    expect(singleRequests[0]).not.toHaveProperty("increase_ref_index");

    // Put two characters in one scene and regenerate it.
    db.insert(characters)
      .values({
        projectId: project.id,
        name: "second",
        description: "another",
        refInputName: "uploaded-second.png",
      })
      .run();
    const second = db
      .select()
      .from(characters)
      .where(eq(characters.projectId, project.id))
      .all()
      .find((c) => c.name === "second")!;

    const target = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()[0]!;
    db.update(scenes)
      .set({ imageAssetId: null, characterIds: [cast[0]!.id, second.id] })
      .where(eq(scenes.id, target.id))
      .run();

    const multi = enqueue(db, { type: "scene_images", projectId: project.id });
    const multiRequests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, multi, { onImageRequest: (r) => multiRequests.push(r) }));

    expect(multiRequests[0]!.ref_images).toHaveLength(2);
    expect(multiRequests[0]!.increase_ref_index).toBe(true);
  });

  it("generates one image per scene and stores each as an asset", async () => {
    const project = await elementsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(
      stubContext(db, job, {
        images: [Buffer.from("png-1"), Buffer.from("png-2"), Buffer.from("png-3")],
        onImageRequest: (request) => requests.push(request),
      }),
    );

    expect(requests).toHaveLength(3);
    const rows = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all();
    expect(rows.every((s) => s.imageAssetId)).toBe(true);
  });

  it("asks for the configured source frame size and the style's model", async () => {
    const project = await elementsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests[0]).toMatchObject({
      width: 432,
      height: 768,
      model: "flux2-klein-4b",
      steps: 4,
    });
  });

  it("wraps the scene prompt in the image style's prefix and suffix", async () => {
    const project = await elementsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests[0]!.prompt).toMatch(/^documentary photograph, available light, /);
    expect(requests[0]!.prompt).toMatch(/shallow depth of field$/);
  });

  it("skips scenes that already have an image", async () => {
    const project = await elementsDone();

    const first = enqueue(db, { type: "scene_images", projectId: project.id });
    await runSceneImages(stubContext(db, first));

    const second = enqueue(db, { type: "scene_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, second, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(0);
  });

  it("refuses a project with no scenes", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });
    await expect(runSceneImages(stubContext(db, job))).rejects.toThrow(/no scenes/);
  });

  // A per-scene redo clears just that scene's image; the direction supplied
  // with the job must land in that scene's prompt, between the base prompt
  // and the image style's suffix.
  it("inserts a direction before the image style's suffix for a redone scene", async () => {
    const project = await elementsDone();
    const first = enqueue(db, { type: "scene_images", projectId: project.id });
    await runSceneImages(stubContext(db, first));

    const target = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()[0]!;
    db.update(scenes).set({ imageAssetId: null }).where(eq(scenes.id, target.id)).run();

    const job = enqueue(db, {
      type: "scene_images",
      projectId: project.id,
      payload: { sceneId: target.id, direction: "storm clouds overhead" },
    });

    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(1);
    const prompt = requests[0]!.prompt as string;
    expect(prompt).toContain(", storm clouds overhead");
    expect(prompt.indexOf("storm clouds overhead")).toBeLessThan(
      prompt.indexOf("shallow depth of field"),
    );
  });

  // The render reads bytes off disk, not out of the database, so the asset row
  // pointing at a file that exists is the thing worth asserting.
  it("writes the image bytes to disk where the render can find them", async () => {
    const project = await elementsDone();
    const job = enqueue(db, { type: "scene_images", projectId: project.id });
    await runSceneImages(stubContext(db, job, { images: [Buffer.from("real-png-bytes")] }));

    const scene = db.select().from(scenes).where(eq(scenes.projectId, project.id)).get()!;
    expect(scene.imageAssetId).toBeTruthy();

    const stored = db.select().from(assets).where(eq(assets.id, scene.imageAssetId!)).get()!;
    expect(fs.readFileSync(stored.path).toString()).toBe("real-png-bytes");
    expect(stored.bytes).toBe("real-png-bytes".length);
  });
});
