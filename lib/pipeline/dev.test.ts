import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import {
  characters,
  devArtifacts,
  directionStyles,
  evaluations,
  locations,
  projects,
  props,
  providers,
  worldBuilding,
} from "../db/schema";
import { claim, enqueue, listJobs } from "../queue";
import { createProject, regenerate } from "../projects";
import { setPreference } from "../preferences";
import { advance, nextStep } from "./chain";
import { resolveProvider } from "./context";
import {
  parseScreenplay,
  runBeatSheet,
  runConcept,
  runDevCharacters,
  runLogline,
  runSceneBreakdown,
  runScreenplay,
  runScreenplayRevision,
  runScriptBreakdown,
  runStoryBible,
  runStoryStructure,
  runTreatment,
  runWorldBuilding,
} from "./dev";
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
const BEAT_SHEET = {
  content:
    "1. Reyna refuses the job outright. 2. The bank sets a deadline. 3. She takes the job for the money, not her brother. " +
    "4. She finds the first lock her father never taught her to pick. 5. She lets someone in. 6. She finds what's really behind the door.",
};
const TREATMENT = {
  content:
    "Reyna has spent her life trusting mechanisms more than people, and it has kept her safe until the bank sets a " +
    "deadline on her estranged brother's house. She takes the job, tells herself it is only for the money, and finds " +
    "a lock inside the house her father never taught her to pick — one that opens only if she lets someone in first.",
};

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

/** Drives a fresh project through concept..story_structure (PR2's five stages), auto mode. */
async function runThroughStoryStructure(): Promise<Awaited<ReturnType<typeof newDevProject>>> {
  const project = newDevProject("auto");
  await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
  await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
  await runDevCharacters(
    stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
  );
  await runWorldBuilding(
    stubContext(db, enqueue(db, { type: "world_building", projectId: project.id }), { llm: [WORLD] }),
  );
  await runStoryStructure(
    stubContext(db, enqueue(db, { type: "story_structure", projectId: project.id }), { llm: [STRUCTURE] }),
  );
  return project;
}

describe("Development chain stages (M7 PR3 — beat sheet & treatment)", () => {
  it("generates a beat sheet and a treatment as dev_artifacts rows, advancing devNextStep beat_sheet -> treatment -> screenplay", async () => {
    const project = await runThroughStoryStructure();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "beat_sheet" });

    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), { llm: [BEAT_SHEET] }),
    );
    const beatSheetRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "beat_sheet")!;
    expect(beatSheetRow.content).toBe(BEAT_SHEET.content);
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "treatment" });

    await runTreatment(
      stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), { llm: [TREATMENT] }),
    );
    const treatmentRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "treatment")!;
    expect(treatmentRow.content).toBe(TREATMENT.content);

    // "screenplay" has no STAGE_HANDLERS entry yet (PR4+) — landing there, not
    // generated, is what a correctly-advancing devNextStep looks like here,
    // the same interim state "beat_sheet" was in before this PR.
    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "screenplay",
      needsApproval: false,
    });
  });

  it("resolves beat_sheet's and treatment's provider via resolveDevProvider, not the ordinary default llm provider", async () => {
    const project = await runThroughStoryStructure();

    const [devProvider] = db
      .insert(providers)
      .values({ kind: "llm", name: "dev-tier", baseUrl: "http://dev-tier.example", model: "dev-tier-model" })
      .returning()
      .all();
    setPreference(db, "defaultDevLlmProvider", devProvider!.id);

    let seenModel: unknown;
    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), {
        llm: [BEAT_SHEET],
        onChatRequest: (request) => {
          seenModel = request.model;
        },
      }),
    );
    expect(seenModel).toBe(devProvider!.model);

    seenModel = undefined;
    await runTreatment(
      stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), {
        llm: [TREATMENT],
        onChatRequest: (request) => {
          seenModel = request.model;
        },
      }),
    );
    expect(seenModel).toBe(devProvider!.model);
  });

  it("keeps the narrative pipeline's default llm provider and the dev-tier preference from affecting each other's resolution", async () => {
    const project = await runThroughStoryStructure();

    // A second "llm" provider, made the ordinary default — this is what the
    // narrative pipeline's synopsis/story stages resolve via resolveProvider.
    // Only one "llm" row may be `isDefault` (providers.ts's own invariant),
    // so unset the seeded one before inserting this test's replacement.
    db.update(providers).set({ isDefault: false }).where(eq(providers.kind, "llm")).run();
    const [narrativeDefault] = db
      .insert(providers)
      .values({ kind: "llm", name: "fast-cheap", baseUrl: "http://fast.example", model: "fast-cheap-model", isDefault: true })
      .returning()
      .all();

    const [devProvider] = db
      .insert(providers)
      .values({ kind: "llm", name: "dev-tier", baseUrl: "http://dev-tier.example", model: "dev-tier-model" })
      .returning()
      .all();
    setPreference(db, "defaultDevLlmProvider", devProvider!.id);

    // Changing the narrative pipeline's default llm provider must not change
    // what a dev-chain stage resolves.
    let seenModel: unknown;
    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), {
        llm: [BEAT_SHEET],
        onChatRequest: (request) => {
          seenModel = request.model;
        },
      }),
    );
    expect(seenModel).toBe(devProvider!.model);
    expect(seenModel).not.toBe(narrativeDefault!.model);

    // And conversely: the dev-tier preference must not change what
    // resolveProvider(db, "llm") — the narrative pipeline's own resolution —
    // returns.
    expect(resolveProvider(db, "llm").id).toBe(narrativeDefault!.id);
  });

  it("threads Direction Style guidance into beat_sheet's and treatment's prompts, referencing the prior approved artifact", async () => {
    const project = await runThroughStoryStructure();
    const direction = db
      .select()
      .from(directionStyles)
      .where(eq(directionStyles.id, project.directionStyleId!))
      .get()!;

    let beatSheetPrompt = "";
    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), {
        llm: [BEAT_SHEET],
        onChatRequest: (request) => {
          beatSheetPrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );
    expect(beatSheetPrompt).toContain(direction.genreGuidance);
    expect(beatSheetPrompt).toContain(direction.pacingGuidance);
    expect(beatSheetPrompt).toContain(STRUCTURE.content);

    let treatmentPrompt = "";
    await runTreatment(
      stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), {
        llm: [TREATMENT],
        onChatRequest: (request) => {
          treatmentPrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );
    expect(treatmentPrompt).toContain(direction.genreGuidance);
    expect(treatmentPrompt).toContain(direction.toneGuidance);
    expect(treatmentPrompt).toContain(BEAT_SHEET.content);
  });
});

const SCREENPLAY = {
  content: `INT. REYNA'S SHOP - DAY

Reyna bends over a half-fixed lock, her father's pick set open beside her.

REYNA
(quietly)
Almost.

The bank's deadline notice sits unopened on the counter.

INT. BROTHER'S HOUSE - NIGHT

Reyna kneels at a door she doesn't recognize, working a lock her father
never taught her.

REYNA
This one's new.

She lets it click open, and the house exhales around her.`,
};

// Deliberately not Fountain at all — free prose, no sluglines, no cast in
// caps, no dialogue — the malformed-generation case `parseScreenplay` exists
// to catch. `fountain-js` does not throw on this (verified directly against
// the library: it just becomes a single `action` token), so this exercises
// the token-shape check, not a parser exception.
const MALFORMED_SCREENPLAY = {
  content:
    "Here is a summary of what happens: Reyna fixes the lock, worries about " +
    "the deadline, and eventually breaks into her brother's house to find " +
    "something she wasn't expecting. It's a story about trust.",
};

/** Drives a fresh project through concept..treatment (PR2/PR3's seven stages), auto mode. */
async function runThroughTreatment(): Promise<Awaited<ReturnType<typeof newDevProject>>> {
  const project = await runThroughStoryStructure();
  await runBeatSheet(
    stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), { llm: [BEAT_SHEET] }),
  );
  await runTreatment(
    stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), { llm: [TREATMENT] }),
  );
  return project;
}

describe("Development chain stages (M7 PR4 — screenplay)", () => {
  it("generates a screenplay as a dev_artifacts row, advancing devNextStep to screenplay_revision", async () => {
    const project = await runThroughTreatment();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "screenplay" });

    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), { llm: [SCREENPLAY] }),
    );

    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay")!;
    expect(row.content).toBe(SCREENPLAY.content);
    expect(row.approvedAt).not.toBeNull(); // auto mode approves its own draft

    // "screenplay_revision" has no STAGE_HANDLERS entry yet (PR5+) — landing
    // there, not generated, is the same interim state "screenplay" was in
    // before this PR.
    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "screenplay_revision",
      needsApproval: false,
    });
  });

  it("stores a screenplay that re-parses cleanly with fountain-js — non-empty scenes and dialogue, no parse failure", async () => {
    const project = await runThroughTreatment();
    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), { llm: [SCREENPLAY] }),
    );

    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay")!;

    const reparsed = parseScreenplay(row.content);
    const sceneHeadings = reparsed.tokens.filter((t) => t.type === "scene_heading");
    const dialogue = reparsed.tokens.filter((t) => t.type === "dialogue");
    expect(sceneHeadings.length).toBeGreaterThan(0);
    expect(dialogue.length).toBeGreaterThan(0);
  });

  it("rejects a malformed (non-Fountain) LLM response rather than storing it as an approved screenplay", async () => {
    const project = await runThroughTreatment();

    await expect(
      runScreenplay(
        stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), {
          llm: [MALFORMED_SCREENPLAY],
        }),
      ),
    ).rejects.toThrow(/valid Fountain/);

    // No dev_artifacts row for "screenplay" was created — the malformed draft
    // never got as far as `writeDevArtifact`.
    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay");
    expect(row).toBeUndefined();

    // devNextStep still reports "screenplay" as outstanding — the failed job
    // left nothing behind for the chain to advance past.
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "screenplay", needsApproval: false });
  });

  it("threads Direction Style guidance and the approved treatment into the screenplay prompt", async () => {
    const project = await runThroughTreatment();
    const direction = db
      .select()
      .from(directionStyles)
      .where(eq(directionStyles.id, project.directionStyleId!))
      .get()!;

    let seenPrompt = "";
    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), {
        llm: [SCREENPLAY],
        onChatRequest: (request) => {
          seenPrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );

    expect(seenPrompt).toContain(direction.genreGuidance);
    expect(seenPrompt).toContain(direction.toneGuidance);
    expect(seenPrompt).toContain(TREATMENT.content);
  });

  it("resolves the screenplay stage's provider via resolveDevProvider, not the ordinary default llm provider", async () => {
    const project = await runThroughTreatment();

    const [devProvider] = db
      .insert(providers)
      .values({ kind: "llm", name: "dev-tier", baseUrl: "http://dev-tier.example", model: "dev-tier-model" })
      .returning()
      .all();
    setPreference(db, "defaultDevLlmProvider", devProvider!.id);

    let seenModel: unknown;
    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), {
        llm: [SCREENPLAY],
        onChatRequest: (request) => {
          seenModel = request.model;
        },
      }),
    );
    expect(seenModel).toBe(devProvider!.model);
  });
});

/** Drives a fresh project through concept..screenplay (PR2-PR4's eight stages), auto mode. */
async function runThroughScreenplay(): Promise<Awaited<ReturnType<typeof newDevProject>>> {
  const project = await runThroughTreatment();
  await runScreenplay(
    stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), { llm: [SCREENPLAY] }),
  );
  return project;
}

const REVISION_KEYS = ["scene_structure", "character_voice", "dialogue_quality", "pacing", "fountain_cleanliness"];

function passingEvaluation() {
  return {
    verdict: "pass",
    dimensions: Object.fromEntries(REVISION_KEYS.map((k) => [k, { score: 5, comment: "solid" }])),
    issues: [],
  };
}

function failingEvaluation(note: string) {
  return {
    verdict: "revise",
    dimensions: Object.fromEntries(
      REVISION_KEYS.map((k, i) => [k, { score: i === 0 ? 1 : 4, comment: i === 0 ? note : "fine" }]),
    ),
    issues: [{ severity: "high", note }],
  };
}

const REVISED_SCREENPLAY = {
  content: `INT. REYNA'S SHOP - DAY

Reyna bends over a half-fixed lock, her father's pick set open beside her,
the bank's notice still unopened.

REYNA
(quietly, to the lock)
Almost. Just a little more trust than that.

INT. BROTHER'S HOUSE - NIGHT

Reyna kneels at a door she doesn't recognize, working a lock her father
never taught her.

REYNA
This one's new. This one's yours.

She lets it click open, and the house exhales around her.`,
};

describe("Development chain stages (M7 PR5 — screenplay revision & story bible)", () => {
  it("passes the screenplay on first evaluation, writes an approved screenplay_revision row, and advances to story_bible", async () => {
    const project = await runThroughScreenplay();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "screenplay_revision" });

    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [{ json: passingEvaluation() }],
      }),
    );

    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay_revision")!;
    expect(row.content).toBe(SCREENPLAY.content);
    expect(row.approvedAt).not.toBeNull(); // auto mode approves its own draft

    const evalRow = db.select().from(evaluations).where(eq(evaluations.projectId, project.id)).get()!;
    expect(evalRow.verdict).toBe("pass");
    expect(evalRow.iteration).toBe(1);

    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_bible" });
  });

  it("loops through revision attempts, feeding each rewrite back into the next evaluation", async () => {
    const project = await runThroughScreenplay();

    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [{ json: failingEvaluation("dialogue is generic") }, REVISED_SCREENPLAY, { json: passingEvaluation() }],
      }),
    );

    const evalRows = db.select().from(evaluations).where(eq(evaluations.projectId, project.id)).all();
    expect(evalRows.map((r) => r.verdict)).toEqual(["revise", "pass"]);

    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay_revision")!;
    // The passing draft written is the *revised* screenplay, not the original
    // — the loop's rewrite fed forward into the evaluation that passed it.
    expect(row.content).toBe(REVISED_SCREENPLAY.content);
    expect(row.approvedAt).not.toBeNull();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_bible" });
  });

  // Mirrors runStoryEval's own QC-threshold test: a model that never converges
  // must stop burning attempts rather than loop forever.
  it("stops at the QC threshold and parks the project for review instead of looping forever", async () => {
    const project = await runThroughScreenplay();

    // qcMaxIterations defaults to 3: eval-fail, revise, eval-fail, revise,
    // eval-fail (>= threshold) — no third revise.
    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [
          { json: failingEvaluation("still generic") },
          REVISED_SCREENPLAY,
          { json: failingEvaluation("still generic") },
          REVISED_SCREENPLAY,
          { json: failingEvaluation("still generic") },
        ],
      }),
    );

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.awaitingReview).toBe(true);
    expect(after.failureReason).toMatch(/QC threshold/);

    const evalRows = db.select().from(evaluations).where(eq(evaluations.projectId, project.id)).all();
    expect(evalRows).toHaveLength(3);
    expect(evalRows.every((r) => r.verdict === "revise")).toBe(true);

    // The latest (still-failing) draft is left behind unapproved, not
    // discarded — a human reviewing this project has something to look at,
    // and can approve it as-is via the ordinary "continue" mechanism.
    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "screenplay_revision")!;
    expect(row.content).toBe(REVISED_SCREENPLAY.content);
    expect(row.approvedAt).toBeNull();

    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "screenplay_revision",
      needsApproval: true,
    });
  });

  it("parks for review after a pass in manual mode too, the same as every other dev-chain stage", async () => {
    const project = newDevProject("manual");
    // Drive the manual-mode project through concept..screenplay, approving
    // each stage's draft via `advance` (as "continue" would) before running
    // the next one directly — `devStageStatus`/`devNextStep` gate on
    // `approvedAt`, so a manual-mode chain has to actually approve its way
    // through, unlike the auto-mode helpers above.
    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    advance(db, project.id);
    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
    advance(db, project.id);
    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
    );
    advance(db, project.id);
    await runWorldBuilding(
      stubContext(db, enqueue(db, { type: "world_building", projectId: project.id }), { llm: [WORLD] }),
    );
    advance(db, project.id);
    await runStoryStructure(
      stubContext(db, enqueue(db, { type: "story_structure", projectId: project.id }), { llm: [STRUCTURE] }),
    );
    advance(db, project.id);
    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), { llm: [BEAT_SHEET] }),
    );
    advance(db, project.id);
    await runTreatment(
      stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), { llm: [TREATMENT] }),
    );
    advance(db, project.id);
    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), { llm: [SCREENPLAY] }),
    );
    advance(db, project.id);

    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [{ json: passingEvaluation() }],
      }),
    );

    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "screenplay_revision", needsApproval: true });
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(true);
  });

  it("assembles the story bible from every upstream approved artifact, without calling the LLM provider", async () => {
    const project = await runThroughScreenplay();
    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [{ json: passingEvaluation() }],
      }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_bible" });

    await runStoryBible(
      stubContext(db, enqueue(db, { type: "story_bible", projectId: project.id }), {
        // No `llm` entries configured — `nextLlm()` throws if either chat
        // path is ever reached, which is exactly the "never calls the LLM
        // provider" assertion this test needs.
        onChatRequest: () => {
          throw new Error("story_bible must never call the LLM provider (chat)");
        },
        onChatJsonRequest: () => {
          throw new Error("story_bible must never call the LLM provider (chatJson)");
        },
      }),
    );

    const row = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "story_bible")!;

    expect(row.content).toContain(CONCEPT.content);
    expect(row.content).toContain("Reyna"); // a character name, from the `characters` table
    expect(row.content).toContain("Reyna's shop"); // a location name, from the `locations` table
    expect(row.content).toContain(SCREENPLAY.content); // the final screenplay/revision content
    // Left unapproved — the generic "approve and continue" mechanism gates
    // this, not an auto-approval path this stage would have to invent.
    expect(row.approvedAt).toBeNull();
    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "story_bible",
      needsApproval: true,
    });
  });

  // The capstone proof for the entire M7 Development milestone: a full
  // end-to-end walk through all ten `DEV_CHAIN_STAGES`, concept through
  // story_bible, ending at the exact terminal state `devNextStep` promises.
  it("walks a project through the entire ten-stage Development chain to devNextStep's terminal 'complete' state", async () => {
    const project = newDevProject("auto");

    await runConcept(stubContext(db, enqueue(db, { type: "concept", projectId: project.id }), { llm: [CONCEPT] }));
    await runLogline(stubContext(db, enqueue(db, { type: "logline", projectId: project.id }), { llm: [LOGLINE] }));
    await runDevCharacters(
      stubContext(db, enqueue(db, { type: "characters", projectId: project.id }), { llm: [CHARACTERS] }),
    );
    await runWorldBuilding(
      stubContext(db, enqueue(db, { type: "world_building", projectId: project.id }), { llm: [WORLD] }),
    );
    await runStoryStructure(
      stubContext(db, enqueue(db, { type: "story_structure", projectId: project.id }), { llm: [STRUCTURE] }),
    );
    await runBeatSheet(
      stubContext(db, enqueue(db, { type: "beat_sheet", projectId: project.id }), { llm: [BEAT_SHEET] }),
    );
    await runTreatment(
      stubContext(db, enqueue(db, { type: "treatment", projectId: project.id }), { llm: [TREATMENT] }),
    );
    await runScreenplay(
      stubContext(db, enqueue(db, { type: "screenplay", projectId: project.id }), { llm: [SCREENPLAY] }),
    );
    await runScreenplayRevision(
      stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
        llm: [{ json: passingEvaluation() }],
      }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_bible" });

    await runStoryBible(stubContext(db, enqueue(db, { type: "story_bible", projectId: project.id }), {}));

    // story_bible is left unapproved even in auto mode (it is an assembly
    // stage, not a generation one) — "continue" is what a human uses to sign
    // off on Development and reach `complete`.
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "story_bible", needsApproval: true });

    // Development's own terminal state, before M7 PR6 extended
    // `DEV_CHAIN_STAGES` with Preproduction's first two stages: approving
    // story_bible now lands on "script_breakdown" rather than "complete" —
    // see the PR6 describe block below for the walk past that point.
    const finalStep = advance(db, project.id);
    expect(finalStep).toMatchObject({ kind: "dev", stage: "script_breakdown" });
    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "script_breakdown",
      needsApproval: false,
    });
  });
});

/**
 * Drives a fresh project through concept..story_bible (PR2-PR5's ten
 * stages) and approves the bible — the same "continue" a human would click
 * once Development is signed off — so `nextStep` lands on Preproduction's
 * first stage, "script_breakdown".
 */
async function runThroughApprovedStoryBible(): Promise<Awaited<ReturnType<typeof newDevProject>>> {
  const project = await runThroughScreenplay();
  await runScreenplayRevision(
    stubContext(db, enqueue(db, { type: "screenplay_revision", projectId: project.id }), {
      llm: [{ json: passingEvaluation() }],
    }),
  );
  await runStoryBible(stubContext(db, enqueue(db, { type: "story_bible", projectId: project.id }), {}));
  advance(db, project.id);
  return project;
}

const SCRIPT_BREAKDOWN = {
  content:
    "SCENE 1 — INT. REYNA'S SHOP — DAY\nCast: Reyna\nKey props: Her father's pick set\nNotes: none\n\n" +
    "SCENE 2 — INT. BROTHER'S HOUSE — NIGHT\nCast: Reyna\nKey props: Her father's pick set\nNotes: none",
};

const SCENE_BREAKDOWN = {
  content:
    "SCENE 1\nProps: Her father's pick set (carried by Reyna)\nBlocking: Reyna enters, kneels at the " +
    "workbench\nContinuity: none\nSpecial requirements: none\n\nSCENE 2\nProps: Her father's pick set " +
    "(carried by Reyna)\nBlocking: Reyna enters through the front door, kneels at a new door\n" +
    "Continuity: matches her posture from scene 1\nSpecial requirements: none",
};

describe("Preproduction stages (M7 PR6 — script & scene breakdown)", () => {
  it("generates a script breakdown then a scene breakdown, advancing devNextStep script_breakdown -> scene_breakdown -> complete", async () => {
    const project = await runThroughApprovedStoryBible();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "script_breakdown", needsApproval: false });

    await runScriptBreakdown(
      stubContext(db, enqueue(db, { type: "script_breakdown", projectId: project.id }), {
        llm: [SCRIPT_BREAKDOWN],
      }),
    );
    const scriptRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "script_breakdown")!;
    expect(scriptRow.content).toBe(SCRIPT_BREAKDOWN.content);
    expect(scriptRow.approvedAt).not.toBeNull(); // auto mode auto-approves
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "scene_breakdown", needsApproval: false });

    await runSceneBreakdown(
      stubContext(db, enqueue(db, { type: "scene_breakdown", projectId: project.id }), {
        llm: [SCENE_BREAKDOWN],
      }),
    );
    const sceneRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "scene_breakdown")!;
    expect(sceneRow.content).toBe(SCENE_BREAKDOWN.content);

    // Nothing is defined past "scene_breakdown" in `DEV_CHAIN_STAGES` yet —
    // the same "no handler yet" interim landing every earlier PR's own
    // terminal stage sat in before the next PR extended the chain further.
    expect(nextStep(db, project.id)).toEqual({
      kind: "complete",
      reason: "every Development/Preproduction stage built so far is approved",
    });
  });

  it("parks for review after each stage in manual mode, requiring an explicit approve-and-continue", async () => {
    const project = await runThroughApprovedStoryBible();
    // `advance` above already ran in auto mode via `runThroughApprovedStoryBible`'s
    // helper chain — switch this project to manual before generating either
    // Preproduction stage, so this test observes manual mode's own behaviour.
    db.update(projects).set({ mode: "manual" }).where(eq(projects.id, project.id)).run();

    await runScriptBreakdown(
      stubContext(db, enqueue(db, { type: "script_breakdown", projectId: project.id }), {
        llm: [SCRIPT_BREAKDOWN],
      }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "script_breakdown", needsApproval: true });
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(true);

    advance(db, project.id); // approve script_breakdown, enqueue scene_breakdown
    await runSceneBreakdown(
      stubContext(db, enqueue(db, { type: "scene_breakdown", projectId: project.id }), {
        llm: [SCENE_BREAKDOWN],
      }),
    );
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "scene_breakdown", needsApproval: true });
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview).toBe(true);
  });

  it("reads the approved story bible for script_breakdown and the prior breakdown plus cast/world for scene_breakdown, without threading Direction Style guidance into either (logistics documents, not prose)", async () => {
    const project = await runThroughApprovedStoryBible();
    const bibleRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "story_bible")!;
    const direction = db
      .select()
      .from(directionStyles)
      .where(eq(directionStyles.id, project.directionStyleId!))
      .get()!;

    let scriptPrompt = "";
    await runScriptBreakdown(
      stubContext(db, enqueue(db, { type: "script_breakdown", projectId: project.id }), {
        llm: [SCRIPT_BREAKDOWN],
        onChatRequest: (request) => {
          scriptPrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );
    expect(scriptPrompt).toContain(bibleRow.content);
    expect(scriptPrompt).not.toContain(direction.genreGuidance);
    expect(scriptPrompt).not.toContain(direction.toneGuidance);

    let scenePrompt = "";
    await runSceneBreakdown(
      stubContext(db, enqueue(db, { type: "scene_breakdown", projectId: project.id }), {
        llm: [SCENE_BREAKDOWN],
        onChatRequest: (request) => {
          scenePrompt = (request.messages as { content: string }[])[0]!.content;
        },
      }),
    );
    expect(scenePrompt).toContain(SCRIPT_BREAKDOWN.content);
    expect(scenePrompt).toContain("Reyna"); // castSummary
    expect(scenePrompt).not.toContain(direction.genreGuidance);
    expect(scenePrompt).not.toContain(direction.pacingGuidance);
  });

  it("redoing script_breakdown invalidates scene_breakdown, per ADR 0003 / INVALIDATION_CHAIN", async () => {
    const project = await runThroughApprovedStoryBible();
    await runScriptBreakdown(
      stubContext(db, enqueue(db, { type: "script_breakdown", projectId: project.id }), {
        llm: [SCRIPT_BREAKDOWN],
      }),
    );
    await runSceneBreakdown(
      stubContext(db, enqueue(db, { type: "scene_breakdown", projectId: project.id }), {
        llm: [SCENE_BREAKDOWN],
      }),
    );
    expect(nextStep(db, project.id)).toEqual({
      kind: "complete",
      reason: "every Development/Preproduction stage built so far is approved",
    });

    // `regenerate` returns the job it enqueues — used directly rather than
    // `claim(db)`, since every earlier stage in this walk left its own
    // already-run job row sitting "queued" (this file's `run*` helpers pass
    // jobs to stage handlers directly rather than through `claim`), and
    // `claim` would otherwise hand back the oldest of those instead of this
    // redo's own job.
    const job = regenerate(db, project.id, { target: "script_breakdown", direction: "tighten the props list" });

    const sceneRow = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()
      .find((r) => r.stage === "scene_breakdown")!;
    // Cleared, not deleted — `directionHistory` (empty here) would still
    // survive a redo the same way every other dev-artifact discard preserves
    // it, per `devArtifactDiscard`'s own doc comment.
    expect(sceneRow.content).toBe("");
    expect(sceneRow.approvedAt).toBeNull();

    expect(job.type).toBe("script_breakdown");
    expect(job.payload.direction).toBe("tighten the props list");

    await runScriptBreakdown(
      stubContext(db, job, { llm: [{ content: "revised, tighter breakdown" }] }),
    );
    // The redone script_breakdown auto-approves (auto mode) and hands off to
    // scene_breakdown, which the invalidation cleared — exactly the state a
    // fresh run of the two-stage chain would be in.
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "scene_breakdown", needsApproval: false });
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
