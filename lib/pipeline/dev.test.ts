import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import {
  characters,
  devArtifacts,
  directionStyles,
  locations,
  projects,
  props,
  worldBuilding,
} from "../db/schema";
import { claim, enqueue, listJobs } from "../queue";
import { createProject, regenerate } from "../projects";
import { advance, nextStep } from "./chain";
import { runConcept, runDevCharacters, runLogline, runStoryStructure, runWorldBuilding } from "./dev";
import { filterLiveRefs } from "./images";
import { stubContext } from "./test-support";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

function newDevProject(mode: "auto" | "manual" = "auto") {
  const project = createProject(db, {
    idea: "a locksmith who can't lock her own door",
    format: "short_movie",
    mode,
  });
  // Nothing is queued for a dev-format project on creation (PR1) — clear the
  // queue so each test starts quiet, the same way the narrative tests do.
  for (const job of listJobs(db, { projectId: project.id })) {
    claim(db);
  }
  return project;
}

const CONCEPT = { content: "A locksmith who can pick any lock but can't let anyone in." };
const LOGLINE = { content: "A gifted locksmith must break into her estranged brother's house before the bank does, or lose the one thing he left her." };
const CHARACTERS = {
  json: {
    characters: [
      { name: "Reyna", description: "A locksmith who trusts mechanisms more than people.", arc: "Learns to let someone in before it's too late." },
    ],
  },
};
const WORLD = {
  json: {
    rules: "A working-class city of trades and debts, where a lock is a promise and breaking one is a moral act, not just a mechanical one.",
    locations: [{ name: "Reyna's shop", description: "A cramped storefront lined with keys and half-fixed locks." }],
    props: [{ name: "Her father's pick set", description: "A worn leather roll of picks, the one thing of his she kept." }],
  },
};
const STRUCTURE = { content: "1. Reyna refuses the job. 2. The deadline forces her hand. 3. She finds what's really behind the door." };

describe("Development chain stages (M7 PR2)", () => {
  it("advances devNextStep through all five PR2 stages in order (auto mode)", async () => {
    const project = newDevProject("auto");

    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "logline" });

    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "characters" });

    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "world_building" });

    await runWorldBuilding(
      stubContext(db, enqueue(db, { type: "world_building", projectId: project.id }), { llm: [WORLD] }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_structure" });

    await runStoryStructure(
      stubContext(db, enqueue(db, { type: "story_structure", projectId: project.id }), { llm: [STRUCTURE] }),
    );
    // "beat_sheet" has no STAGE_HANDLERS entry yet (PR3+) — landing there,
    // not generated, is exactly what this criterion asks for.
    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "beat_sheet",
      needsApproval: false,
    });
  });

  it("writes the concept's content to a dev_artifacts row and never touches the image backend", async () => {
    const project = newDevProject("auto");
    await runConcept(
      stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), {
        llm: [CONCEPT],
        onImageRequest: () => {
          throw new Error("concept generation must never call an image backend");
        },
      }),
    );
    const row = db.select().from(devArtifacts).where(eq(devArtifacts.projectId, project.id)).get()!;
    expect(row.content).toBe(CONCEPT.content);
  });

  it("parks for review after each stage in manual mode, and 'continue' approves and dispatches the next one", async () => {
    const project = newDevProject("manual");

    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));

    // Generated but not yet approved.
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "concept", needsApproval: true });
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(true);

    // "Continue" approves the concept draft and enqueues the next stage.
    const step = advance(db, project.id);
    expect(step).toMatchObject({ kind: "dev", stage: "logline" });
    expect(listJobs(db, { projectId: project.id }).some((j) => j.type === "logline")).toBe(true);

    const concept = db.select().from(devArtifacts).where(eq(devArtifacts.projectId, project.id)).get()!;
    expect(concept.approvedAt).not.toBeNull();
  });

  it("redoing 'characters' replaces the cast and records the direction, without touching concept/logline", async () => {
    const project = newDevProject("auto");
    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
    );

    const REDONE_CHARACTERS = {
      json: { characters: [{ name: "Marisol", description: "The brother's widow.", arc: "Stops blaming Reyna for what happened." }] },
    };

    const job = regenerate(db, project.id, { target: "characters", direction: "make it about the sister-in-law instead" });
    await runDevCharacters(stubContext(db, job, { llm: [REDONE_CHARACTERS] }));

    const cast = db.select().from(characters).where(eq(characters.projectId, project.id)).all();
    expect(cast).toHaveLength(1);
    expect(cast[0]!.name).toBe("Marisol");

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.charactersDirectionHistory).toContain("make it about the sister-in-law instead");

    // concept/logline untouched by a "characters" redo — ADR 0003: only what
    // is *downstream* of the redone stage is invalidated.
    const concept = db.select().from(devArtifacts).where(eq(devArtifacts.projectId, project.id)).get()!;
    expect(concept.content).toBe(CONCEPT.content);
  });

  it("redoing 'logline' cascades to clear world_building's locations/props, per ADR 0003", async () => {
    const project = newDevProject("auto");
    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
    );
    await runWorldBuilding(
      stubContext(db, enqueue(db, { type: "world_building", projectId: project.id }), { llm: [WORLD] }),
    );

    expect(db.select().from(locations).where(eq(locations.projectId, project.id)).all()).toHaveLength(1);
    expect(db.select().from(props).where(eq(props.projectId, project.id)).all()).toHaveLength(1);

    // Redoing "logline" invalidates everything after it: characters, and the
    // world it fed — locations/props go with it, cascade-deleted along with
    // the `world_building` row's own content, the same way `elements`
    // clears `scenes`+`characters` together.
    regenerate(db, project.id, { target: "logline" });

    expect(db.select().from(characters).where(eq(characters.projectId, project.id)).all()).toHaveLength(0);
    expect(db.select().from(locations).where(eq(locations.projectId, project.id)).all()).toHaveLength(0);
    expect(db.select().from(props).where(eq(props.projectId, project.id)).all()).toHaveLength(0);
    const world = db.select().from(worldBuilding).where(eq(worldBuilding.projectId, project.id)).get()!;
    expect(world.content).toBe("");
    expect(world.approvedAt).toBeNull();

    // "logline" itself is untouched by its own redo (ADR 0003: the redone
    // stage's own output is left alone — the enqueued job overwrites it).
    // Only what was downstream of it — characters, then world_building's
    // locations/props — is cleared, so "characters" is next.
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "characters" });
  });

  // Register discipline (ADR 0002 / the M7 detail page's warning): Direction
  // Style's genre/tone guidance must reach the text-register prompt and must
  // never be threaded into an image-generation call.
  it("threads the direction style's genre/tone guidance into the characters+arcs prompt", async () => {
    const project = newDevProject("auto");
    const direction = db
      .select()
      .from(directionStyles)
      .where(eq(directionStyles.id, project.directionStyleId!))
      .get()!;

    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));

    let seenPrompt = "";
    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), {
        llm: [CHARACTERS],
        onChatJsonRequest: (request) => {
          seenPrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );

    expect(seenPrompt).toContain(direction.genreGuidance);
    expect(seenPrompt).toContain(direction.toneGuidance);
  });
});

describe("filterLiveRefs — reused unchanged for locations and props", () => {
  it("degrades a location with a dangling reference to text-only, the same way it does for a character", async () => {
    const backend = {
      label: "stub-image",
      hasReference: async (name: string) => name === "live.png",
    } satisfies Parameters<typeof filterLiveRefs>[0];

    const logs: [string, string | undefined][] = [];
    const live = await filterLiveRefs(
      backend,
      [
        { id: "loc-1", name: "Reyna's shop", refInputName: "live.png" },
        { id: "loc-2", name: "The bank", refInputName: "dangling.png" },
        { id: "prop-1", name: "The pick set", refInputName: null },
      ],
      (message, level) => logs.push([message, level]),
    );

    expect([...live.entries()]).toEqual([["loc-1", "live.png"]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toContain("The bank");
    expect(logs[0]![1]).toBe("warn");
  });
});
