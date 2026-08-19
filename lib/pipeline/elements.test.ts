import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, characters, imageStyles, projects, providers, scenes } from "../db/schema";
import { claim, enqueue, listJobs } from "../queue";
import { createProject } from "../projects";
import { runElements } from "./elements";
import { filterLiveRefs, negativePromptFor, runCharacterImages, runSceneImages } from "./images";
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

/** The image style a project actually resolved to, for negative-prompt assertions. */
function imageStyleOf(project: { imageStyleId: string | null }) {
  return db.select().from(imageStyles).where(eq(imageStyles.id, project.imageStyleId!)).get()!;
}

describe("filterLiveRefs", () => {
  it("drops a candidate whose hasInput check fails and logs why", async () => {
    const logs: [string, string | undefined][] = [];
    const image = {
      hasInput: async (name: string) => name === "live.png",
    } as Parameters<typeof filterLiveRefs>[0];

    const live = await filterLiveRefs(
      image,
      [
        { id: "a", name: "Ada", refInputName: "live.png" },
        { id: "b", name: "Bea", refInputName: "dangling.png" },
        { id: "c", name: "Cid", refInputName: null },
      ],
      (message, level) => logs.push([message, level]),
    );

    expect([...live.entries()]).toEqual([["a", "live.png"]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toContain("Bea");
    expect(logs[0]![1]).toBe("warn");
  });
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

  // BUG-008: the model composing a scene prompt must see the register its
  // output will be wrapped in. Without this it wrote "richly saturated" into a
  // prompt about to get ", desaturated colour" appended, and the two halves
  // argued in the same positive prompt.
  it("shows the scene prompt writer both the world and the rendering register", async () => {
    const project = projectWithStory();
    const style = imageStyleOf(project);
    const job = enqueue(db, { type: "elements", projectId: project.id });

    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    const scenePrompt = (prompts[2]!.messages as { content: string }[])[0]!.content;
    expect(scenePrompt).toContain(style.renderGuidance);
    expect(scenePrompt).toContain("Institutional interiors");
  });

  // BUG-010: `description` is narrative prose by the template's own
  // definition. Substituting it for a missing appearance puts backstory into
  // the reference portrait and into every scene prompt built from it.
  it("drops a character returned without an appearance rather than using their description", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    const castWithGap = {
      json: {
        characters: [
          { name: "the plumber", description: "An unassuming tradesman.", appearance: "wiry man in his fifties, navy overalls" },
          { name: "the mayor", description: "A career politician who never returned a call." },
        ],
      },
    };

    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [castWithGap, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(cast.map((c) => c.name)).toEqual(["the plumber"]);

    // The dropped character's backstory must not reach a scene prompt either.
    const scenePrompt = (prompts[2]!.messages as { content: string }[])[0]!.content;
    expect(scenePrompt).not.toContain("career politician");
  });

  // BUG-013: an optional section's heading travels with its value, so a
  // non-redo run leaves no labelled blank for the model to fill in.
  it("omits the direction heading entirely when there is no direction", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "elements", projectId: project.id });

    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [CAST, BEATS, sceneDetail(1), sceneDetail(2), sceneDetail(3)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    const scenePrompt = (prompts[2]!.messages as { content: string }[])[0]!.content;
    expect(scenePrompt).not.toContain("Additional direction");
  });

  // BUG-018: the scoped scene is not necessarily the only one pending — a run
  // that died partway leaves others without a prompt, and the same pass picks
  // them up. Without the guard, a direction typed for one scene rewrites them
  // all. `runSceneImages` has always guarded this; `runElements` did not.
  it("applies a scoped direction to its own scene only, not to others still pending", async () => {
    const project = projectWithStory();
    db.insert(characters)
      .values({ projectId: project.id, name: "the plumber", description: "An unassuming tradesman." })
      .run();
    db.insert(scenes)
      .values([
        { projectId: project.id, index: 0, description: "the burst pipe", voiceoverScript: "a.", imagePrompt: null },
        { projectId: project.id, index: 1, description: "the election", voiceoverScript: "b.", imagePrompt: null },
      ])
      .run();
    const target = db.select().from(scenes).where(eq(scenes.index, 1)).get()!;

    const job = enqueue(db, {
      type: "elements",
      projectId: project.id,
      payload: { sceneId: target.id, direction: "make it rain" },
    });

    const prompts: Record<string, unknown>[] = [];
    await runElements(
      stubContext(db, job, {
        llm: [sceneDetail(1), sceneDetail(2)],
        onChatJsonRequest: (r) => prompts.push(r),
      }),
    );

    expect(prompts).toHaveLength(2);
    const contentFor = (index: number) =>
      (prompts[index]!.messages as { content: string }[])[0]!.content;

    expect(contentFor(0)).toContain("the burst pipe");
    expect(contentFor(0)).not.toContain("make it rain");
    expect(contentFor(1)).toContain("the election");
    expect(contentFor(1)).toContain("make it rain");
  });

  // BUG-6: a "redo prompt" click on one scene must not cascade into
  // portraits, scene images and voiceover behind the user's back. Setup
  // avoids an initial unscoped `runElements` pass, which would legitimately
  // enqueue `character_images` itself and mask the regression.
  it("does not enqueue the next stage after a sceneId-scoped redo", async () => {
    const project = projectWithStory();
    db.insert(characters)
      .values({ projectId: project.id, name: "the plumber", description: "An unassuming tradesman." })
      .run();
    db.insert(scenes)
      .values([
        { projectId: project.id, index: 0, description: "a", voiceoverScript: "a.", imagePrompt: "prompt a" },
        { projectId: project.id, index: 1, description: "b", voiceoverScript: "b.", imagePrompt: null },
        { projectId: project.id, index: 2, description: "c", voiceoverScript: "c.", imagePrompt: "prompt c" },
      ])
      .run();
    const target = db.select().from(scenes).where(eq(scenes.index, 1)).get()!;

    const job = enqueue(db, {
      type: "elements",
      projectId: project.id,
      payload: { sceneId: target.id },
    });
    await runElements(stubContext(db, job, { llm: [sceneDetail(9)] }));

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain(
      "character_images",
    );
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

  it("asks with the image provider's model and params, and the style's own negative prompt", async () => {
    const project = await elementsOnly();
    db.update(providers)
      .set({ model: "sdxl-turbo", defaultParams: { steps: 20, seed: 7 }, negativePrompt: "blurry" })
      .where(eq(providers.kind, "image"))
      .run();

    const job = enqueue(db, { type: "character_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    // Model and params are provider configuration; the negative prompt is
    // style guidance again (BUG-014) and falls back to the provider's only
    // when the style carries none.
    expect(requests[0]).toMatchObject({ model: "sdxl-turbo", steps: 20, seed: 7 });
    // Both lists, not one or the other: the provider's is the model-level floor
    // and the style's is its own look.
    expect(requests[0]!.negative_prompt).toContain("blurry");
    expect(requests[0]!.negative_prompt).toContain(imageStyleOf(project).negativePrompt);
  });

  // The floor must survive a style that says nothing, and a style must never
  // be able to drop it (BUG-025).
  it("still sends the provider's negative prompt when the style carries none", async () => {
    const project = await elementsOnly();
    db.update(providers)
      .set({ negativePrompt: "blurry" })
      .where(eq(providers.kind, "image"))
      .run();
    db.update(imageStyles)
      .set({ negativePrompt: "" })
      .where(eq(imageStyles.id, project.imageStyleId!))
      .run();

    const job = enqueue(db, { type: "character_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests[0]!.negative_prompt).toBe("blurry");
  });

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

  // BUG-5: manual mode's Cast step generates portraits one character at a
  // time, on request — before any character has a portrait, a
  // characterId-scoped job must not sweep up its still-imageless castmates.
  it("a characterId-scoped job only generates that character, even when others are also imageless", async () => {
    const project = await elementsOnly("manual");
    const second = db
      .insert(characters)
      .values({ projectId: project.id, name: "the neighbour", description: "Watches from the porch." })
      .returning()
      .all()[0]!;
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    const target = cast.find((c) => c.id !== second.id)!;

    const job = enqueue(db, {
      type: "character_images",
      projectId: project.id,
      payload: { characterId: target.id },
    });
    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(1);
    const after = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(after.find((c) => c.id === target.id)!.imageAssetId).toBeTruthy();
    expect(after.find((c) => c.id === second.id)!.imageAssetId).toBeNull();
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
    const prompt = requests[0]!.prompt as string;
    expect(prompt).toContain(", wearing a red scarf");
    expect(prompt.indexOf("wearing a red scarf")).toBeLessThan(
      prompt.indexOf("shallow depth of field"),
    );
  });

  // BUG-6: a "redo portrait" click on one character must not cascade into
  // scene images (and from there, voiceover) behind the user's back.
  it("does not enqueue the next stage after a characterId-scoped redo", async () => {
    // No unscoped `character_images` pass runs first — that would itself
    // legitimately cascade to `scene_images` and mask the regression this
    // test guards. `elementsOnly` already leaves the cast portrait-less.
    const project = await elementsOnly();
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();

    const job = enqueue(db, {
      type: "character_images",
      projectId: project.id,
      payload: { characterId: cast[0]!.id },
    });
    await runCharacterImages(stubContext(db, job));

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain("scene_images");
  });

  // VIC-002: an uploaded reference already has imageAssetId set, so the
  // existing `!character.imageAssetId` pending filter should already skip
  // it — this pins that down rather than assuming it from reading the code.
  it("skips a character with a user-supplied reference, even under an unscoped redo", async () => {
    const project = await elementsOnly();
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    db.update(characters)
      .set({
        imageAssetId: (
          db
            .insert(assets)
            .values({ kind: "image", path: "/tmp/upload.png", mimeType: "image/png", bytes: 1 })
            .returning()
            .all()[0]!
        ).id,
        refInputName: "uploaded-by-user.png",
        imageSource: "uploaded",
        imagePrompt: null,
      })
      .where(eq(characters.id, cast[0]!.id))
      .run();

    const job = enqueue(db, { type: "character_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runCharacterImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests).toHaveLength(0);
    const after = db.select().from(characters).where(eq(characters.id, cast[0]!.id)).get()!;
    expect(after.imageSource).toBe("uploaded");
    expect(after.refInputName).toBe("uploaded-by-user.png");
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

  it("asks for the configured source frame size and the provider's model", async () => {
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

  it("asks with the image provider's model and params, and the style's own negative prompt", async () => {
    const project = await elementsDone();
    db.update(providers)
      .set({ model: "sdxl-turbo", defaultParams: { steps: 20, seed: 7 }, negativePrompt: "blurry" })
      .where(eq(providers.kind, "image"))
      .run();

    const job = enqueue(db, { type: "scene_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    // Model and params are provider configuration; the negative prompt is
    // style guidance again (BUG-014) and falls back to the provider's only
    // when the style carries none.
    expect(requests[0]).toMatchObject({ model: "sdxl-turbo", steps: 20, seed: 7 });
    // Both lists, not one or the other: the provider's is the model-level floor
    // and the style's is its own look.
    expect(requests[0]!.negative_prompt).toContain("blurry");
    expect(requests[0]!.negative_prompt).toContain(imageStyleOf(project).negativePrompt);
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

  // BUG-6: a "redo image" click on one scene must not cascade into
  // voiceover generation behind the user's back.
  it("does not enqueue the next stage after a sceneId-scoped redo", async () => {
    // The other scenes' images are faked in directly rather than by running
    // `scene_images` unscoped first — that pass would itself legitimately
    // cascade to `voiceover` and mask the regression this test guards.
    const project = await elementsDone();
    const rows = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all();
    const [target, ...rest] = rows;
    for (const scene of rest) {
      const asset = db
        .insert(assets)
        .values({ kind: "image", path: "/tmp/fake.png", mimeType: "image/png", bytes: 1 })
        .returning()
        .all()[0]!;
      db.update(scenes).set({ imageAssetId: asset.id }).where(eq(scenes.id, scene.id)).run();
    }

    const job = enqueue(db, {
      type: "scene_images",
      projectId: project.id,
      payload: { sceneId: target!.id },
    });
    await runSceneImages(stubContext(db, job));

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain("voiceover");
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

  // ref_images is built from refInputName regardless of how it got there
  // (ADR 0001) — an uploaded reference must flow through identically to a
  // generated one, with zero branching in the scene-generation loop.
  it("passes an uploaded character's reference identically to a generated one", async () => {
    const project = await elementsDone();
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    db.update(characters)
      .set({ refInputName: "uploaded-by-user.png", imageSource: "uploaded" })
      .where(eq(characters.id, cast[0]!.id))
      .run();

    const job = enqueue(db, { type: "scene_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    await runSceneImages(stubContext(db, job, { onImageRequest: (r) => requests.push(r) }));

    expect(requests[0]!.ref_images).toEqual(["uploaded-by-user.png"]);
  });

  // ADR 0001's stated-but-unimplemented rule: a dangling reference name (the
  // upload cleared out of sd-api's own inputs directory) must degrade that
  // character's scenes to text-only rather than fail the stage.
  it("degrades to text-only for a character whose reference sd-api no longer holds", async () => {
    const project = await elementsDone();
    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    db.update(characters)
      .set({ refInputName: "dangling.png" })
      .where(eq(characters.id, cast[0]!.id))
      .run();

    // A second character with a live reference, in the same scene, to prove
    // the gating is per-character rather than all-or-nothing.
    db.insert(characters)
      .values({ projectId: project.id, name: "second", description: "another", refInputName: "live.png" })
      .run();
    const second = db
      .select()
      .from(characters)
      .where(eq(characters.projectId, project.id))
      .all()
      .find((c) => c.name === "second")!;
    const target = db.select().from(scenes).where(eq(scenes.projectId, project.id)).all()[0]!;
    db.update(scenes)
      .set({ characterIds: [cast[0]!.id, second.id] })
      .where(eq(scenes.id, target.id))
      .run();

    const job = enqueue(db, { type: "scene_images", projectId: project.id });
    const requests: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const ctx = stubContext(db, job, {
      onImageRequest: (r) => requests.push(r),
      hasInput: (name) => name !== "dangling.png",
    });
    await runSceneImages({ ...ctx, log: (message) => logs.push(message) });

    expect(requests[0]!.ref_images).toEqual(["live.png"]);
    expect(logs.some((l) => l.includes("no longer available"))).toBe(true);
  });
});

// BUG-025: letting a style replace the provider's list fixed a leak between
// styles and removed the model-level floor with it — both built-in styles then
// omitted the anatomy terms, so nothing guarded hands.
describe("negativePromptFor", () => {
  it("concatenates the model-level floor with the style's own look", () => {
    expect(
      negativePromptFor({ negativePrompt: "deformed hands" }, { negativePrompt: "cgi, glossy" }),
    ).toBe("deformed hands, cgi, glossy");
  });

  it("keeps the floor when the style contributes nothing", () => {
    expect(negativePromptFor({ negativePrompt: "deformed hands" }, { negativePrompt: "" })).toBe(
      "deformed hands",
    );
  });

  it("still works when only the style has terms", () => {
    expect(negativePromptFor({ negativePrompt: "" }, { negativePrompt: "cgi" })).toBe("cgi");
  });

  it("sends nothing rather than an empty string when neither has terms", () => {
    expect(negativePromptFor({ negativePrompt: "" }, { negativePrompt: "  " })).toBeUndefined();
  });
});
