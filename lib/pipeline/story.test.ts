import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { evaluations, narrativeStyles, projects } from "../db/schema";
import { resolveConfig } from "../config";
import { claim, enqueue, listJobs, type Job } from "../queue";
import { createProject } from "../projects";
import { runStory, runStoryEval, runStoryRevise, runSynopsis, parseEvaluation } from "./story";
import type { StageContext } from "./context";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

const CHECKLIST_KEYS = ["specificity", "restraint", "escalation", "payoff", "spoken_clarity"];

function goodEvaluation(score = 4) {
  return {
    verdict: "pass",
    dimensions: Object.fromEntries(
      CHECKLIST_KEYS.map((key) => [key, { score, comment: "fine" }]),
    ),
    issues: [],
  };
}

/** A context whose LLM returns canned responses, so no model is ever called. */
function contextFor(job: Job, responses: { content?: string; json?: unknown }[]): StageContext {
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)]!;

  return {
    db,
    config: resolveConfig({ VICEROY_DATA_DIR: "./data" }),
    job,
    log: () => {},
    progress: () => {},
    shouldAbort: () => false,
    // Story stages are LLM-only; reaching for an image or video backend here
    // would be the bug, so the stub says so rather than quietly providing one.
    imageBackend: () => {
      throw new Error("story stages must not resolve an image backend");
    },
    videoBackend: () => {
      throw new Error("story stages must not resolve a video backend");
    },
    sdApi: {
      llm: {
        chat: async () => ({ content: next().content ?? "", completionTokens: 10 }),
        chatJson: async () => next().json,
      },
      image: {} as never,
      audio: {} as never,
      http: {} as never,
      health: async () => true,
    } as unknown as StageContext["sdApi"],
  };
}

function startProject(mode: "auto" | "manual" = "auto") {
  const project = createProject(db, { idea: "a plumber became mayor by wits", mode });
  return { project, job: claim(db)! };
}

/** Like `contextFor`, but also records every prompt sent to the fake LLM. */
function capturingContextFor(
  job: Job,
  responses: { content?: string; json?: unknown }[],
): { ctx: StageContext; prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)]!;

  const ctx: StageContext = {
    db,
    config: resolveConfig({ VICEROY_DATA_DIR: "./data" }),
    job,
    log: () => {},
    progress: () => {},
    shouldAbort: () => false,
    // Story stages are LLM-only; reaching for an image or video backend here
    // would be the bug, so the stub says so rather than quietly providing one.
    imageBackend: () => {
      throw new Error("story stages must not resolve an image backend");
    },
    videoBackend: () => {
      throw new Error("story stages must not resolve a video backend");
    },
    sdApi: {
      llm: {
        chat: async ({ messages }: { messages: { content: string }[] }) => {
          prompts.push(messages[0]!.content);
          return { content: next().content ?? "", completionTokens: 10 };
        },
        chatJson: async ({ messages }: { messages: { content: string }[] }) => {
          prompts.push(messages[0]!.content);
          return next().json;
        },
      },
      image: {} as never,
      audio: {} as never,
      http: {} as never,
      health: async () => true,
    } as unknown as StageContext["sdApi"],
  };
  return { ctx, prompts };
}

describe("runSynopsis", () => {
  it("writes the synopsis and moves the project on", async () => {
    const { project, job } = startProject();
    await runSynopsis(contextFor(job, [{ content: "A plumber runs for mayor." }]));

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.synopsis).toBe("A plumber runs for mayor.");
    expect(after.stage).toBe("synopsis");
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("story");
  });

  // Manual mode's whole point is that a human sees each stage before the next.
  it("stops for review in manual mode instead of queueing the story", async () => {
    const { project, job } = startProject("manual");
    await runSynopsis(contextFor(job, [{ content: "A synopsis." }]));

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.awaitingReview).toBe(true);
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain("story");
  });

  it("uses the refine template once a synopsis exists and a direction is given", async () => {
    const { project } = startProject();
    claim(db);
    db.update(projects).set({ synopsis: "Existing." }).where(eq(projects.id, project.id)).run();

    const job = enqueue(db, {
      type: "synopsis",
      projectId: project.id,
      payload: { direction: "make it colder" },
    });
    // Refine's template references {{direction}}; rendering would throw if the
    // stage picked the generate template while a direction was supplied.
    await expect(
      runSynopsis(contextFor(job, [{ content: "Colder." }])),
    ).resolves.toBeUndefined();
  });

  // VIC-003: Context mode sources the synopsis from `project.context` rather
  // than `project.idea`, and the prompt instructs the model to stay inside the
  // supplied material.
  //
  // BUG-011: it does that through its own template now. `synopsis.generate`
  // quotes its input as a one-line idea and asks for it to be *developed* —
  // the wrong instruction for several thousand words of source material to be
  // condensed — so the grounding wording lives in `synopsis.fromContext`
  // rather than being appended to a template describing a different task.
  it("uses the Context-mode template, sourced from context and grounded in it", async () => {
    const project = createProject(db, {
      inputMode: "context",
      context: "On March 3rd, a plumber in Millbrook fixed a burst main and later ran for mayor.",
    });
    const job = claim(db)!;

    const { ctx, prompts } = capturingContextFor(job, [{ content: "A synopsis." }]);
    await runSynopsis(ctx);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "On March 3rd, a plumber in Millbrook fixed a burst main and later ran for mayor.",
    );
    expect(prompts[0]).toContain("Source material:");
    expect(prompts[0]).toContain("introduce no people, events, dates");
    // The Idea-mode framing must not survive into it.
    expect(prompts[0]).not.toContain("Develop the following into a synopsis");

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.synopsis).toBe("A synopsis.");
  });

  // A regression here is the signal Context mode stopped being additive.
  it("leaves Idea-mode prompts free of the grounding clause", async () => {
    const { job } = startProject();
    const { ctx, prompts } = capturingContextFor(job, [{ content: "A synopsis." }]);
    await runSynopsis(ctx);

    expect(prompts[0]).not.toContain("do not introduce");
  });
});

describe("runStory", () => {
  it("writes the story and queues evaluation", async () => {
    const { project } = startProject();
    claim(db);
    db.update(projects).set({ synopsis: "A synopsis." }).where(eq(projects.id, project.id)).run();

    const job = enqueue(db, { type: "story", projectId: project.id });
    await runStory(contextFor(job, [{ content: "The story text." }]));

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.story).toBe("The story text.");
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("story_eval");
  });

  it("refuses to write from a project with no synopsis", async () => {
    const { project } = startProject();
    const job = enqueue(db, { type: "story", projectId: project.id });
    await expect(runStory(contextFor(job, [{ content: "x" }]))).rejects.toThrow(/no synopsis/);
  });

  it("uses the refine template once a story exists and a direction is given", async () => {
    const { project } = startProject();
    claim(db);
    db.update(projects)
      .set({ synopsis: "A synopsis.", story: "Existing story." })
      .where(eq(projects.id, project.id))
      .run();

    const job = enqueue(db, {
      type: "story",
      projectId: project.id,
      payload: { direction: "make it colder" },
    });
    // Refine's template references {{direction}}; rendering would throw if the
    // stage picked the write template while a direction was supplied.
    await expect(
      runStory(contextFor(job, [{ content: "Colder story." }])),
    ).resolves.toBeUndefined();
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.story).toBe(
      "Colder story.",
    );
  });

  // Evaluation is not gated on auto mode: a manual reviewer should see the
  // evaluator's read alongside the draft.
  it("queues evaluation even in manual mode", async () => {
    const { project } = startProject("manual");
    db.update(projects).set({ synopsis: "S." }).where(eq(projects.id, project.id)).run();

    const job = enqueue(db, { type: "story", projectId: project.id });
    await runStory(contextFor(job, [{ content: "Story." }]));

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("story_eval");
  });
});

describe("runStoryEval", () => {
  function projectWithStory(mode: "auto" | "manual" = "auto") {
    const { project } = startProject(mode);
    claim(db);
    db.update(projects)
      .set({ synopsis: "S.", story: "The story." })
      .where(eq(projects.id, project.id))
      .run();
    return project;
  }

  it("records a passing evaluation and moves on to element extraction", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "story_eval", projectId: project.id });

    await runStoryEval(contextFor(job, [{ json: goodEvaluation() }]));

    const [evaluation] = db.select().from(evaluations).where(eq(evaluations.projectId, project.id)).all();
    expect(evaluation!.verdict).toBe("pass");
    expect(evaluation!.iteration).toBe(1);
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("elements");
  });

  it("parks a passing story for review in manual mode instead of continuing", async () => {
    const project = projectWithStory("manual");
    const job = enqueue(db, { type: "story_eval", projectId: project.id });

    await runStoryEval(contextFor(job, [{ json: goodEvaluation() }]));

    expect(
      db.select().from(projects).where(eq(projects.id, project.id)).get()!.awaitingReview,
    ).toBe(true);
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).not.toContain("elements");
  });

  it("queues a revision when the story falls short", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "story_eval", projectId: project.id });

    await runStoryEval(
      contextFor(job, [
        {
          json: {
            verdict: "revise",
            dimensions: { specificity: { score: 2, comment: "vague" } },
            issues: [{ severity: "high", note: "The opening is a generality." }],
          },
        },
      ]),
    );

    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("story_revise");
  });

  // The threshold exists so a model that will not converge stops burning
  // inference instead of looping forever.
  it("stops at the QC threshold instead of revising again", async () => {
    const project = projectWithStory();
    const failing = {
      verdict: "revise",
      dimensions: { specificity: { score: 1, comment: "vague" } },
      issues: [{ severity: "high", note: "Still vague." }],
    };

    // qcMaxIterations defaults to 3.
    for (let i = 0; i < 3; i++) {
      const job = enqueue(db, { type: "story_eval", projectId: project.id });
      await runStoryEval(contextFor(job, [{ json: failing }]));
    }

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.awaitingReview).toBe(true);
    expect(after.failureReason).toMatch(/QC threshold/);

    const revisions = listJobs(db, { projectId: project.id }).filter((j) => j.type === "story_revise");
    expect(revisions).toHaveLength(2);
  });

  it("refuses an evaluation that names none of the style's checklist keys", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "story_eval", projectId: project.id });

    await expect(
      runStoryEval(
        contextFor(job, [
          { json: { verdict: "pass", dimensions: { vibes: { score: 5, comment: "good" } } } },
        ]),
      ),
    ).rejects.toThrow(/none of this style's checklist keys/);
  });

  // VIC-003: Context mode adds a `factual_grounding` checklist dimension at
  // evaluation time, without touching the narrative style's own rows.
  it("accepts a factual_grounding verdict and shows the evaluator the context in Context mode", async () => {
    const project = createProject(db, {
      inputMode: "context",
      context: "The plumber fixed the main on March 3rd and later ran for mayor.",
    });
    claim(db);
    db.update(projects)
      .set({ synopsis: "S.", story: "The story." })
      .where(eq(projects.id, project.id))
      .run();

    const job = enqueue(db, { type: "story_eval", projectId: project.id });
    const { ctx, prompts } = capturingContextFor(job, [
      { json: { ...goodEvaluation(), dimensions: { ...goodEvaluation().dimensions, factual_grounding: { score: 5, comment: "faithful" } } } },
    ]);
    await runStoryEval(ctx);

    expect(prompts[0]).toContain("factual_grounding");
    expect(prompts[0]).toContain("The plumber fixed the main on March 3rd and later ran for mayor.");

    const [evaluation] = db.select().from(evaluations).where(eq(evaluations.projectId, project.id)).all();
    expect(evaluation!.dimensions.factual_grounding).toEqual({ score: 5, comment: "faithful" });
  });

  // Idea-mode projects never see the dimension — nothing in the checklist
  // sent to the evaluator should name it, and the prompt should carry no
  // context block.
  it("omits factual_grounding entirely in Idea mode", async () => {
    const project = projectWithStory();
    const job = enqueue(db, { type: "story_eval", projectId: project.id });
    const { ctx, prompts } = capturingContextFor(job, [{ json: goodEvaluation() }]);
    await runStoryEval(ctx);

    expect(prompts[0]).not.toContain("factual_grounding");
  });
});

describe("runStoryRevise", () => {
  it("rewrites against the latest issues and re-queues evaluation", async () => {
    const { project } = startProject();
    claim(db);
    db.update(projects).set({ story: "Old story." }).where(eq(projects.id, project.id)).run();
    db.insert(evaluations)
      .values({
        projectId: project.id,
        iteration: 1,
        verdict: "revise",
        dimensions: { specificity: { score: 2, comment: "vague" } },
        issues: [{ severity: "high", note: "Too vague." }],
        model: "test",
      })
      .run();

    const job = enqueue(db, { type: "story_revise", projectId: project.id });
    await runStoryRevise(contextFor(job, [{ content: "New story." }]));

    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.story).toBe(
      "New story.",
    );
    expect(listJobs(db, { projectId: project.id }).map((j) => j.type)).toContain("story_eval");
  });

  it("refuses to revise with no issues to revise against", async () => {
    const { project } = startProject();
    db.update(projects).set({ story: "Story." }).where(eq(projects.id, project.id)).run();

    const job = enqueue(db, { type: "story_revise", projectId: project.id });
    await expect(runStoryRevise(contextFor(job, [{ content: "x" }]))).rejects.toThrow(
      /no evaluation issues/,
    );
  });
});

describe("parseEvaluation", () => {
  it("averages the dimension scores", () => {
    const parsed = parseEvaluation(
      { verdict: "pass", dimensions: { a: { score: 4 }, b: { score: 2 } } },
      ["a", "b"],
    );
    expect(parsed.overallScore).toBe(3);
  });

  // Models routinely say "pass" while scoring a dimension at 2. The checklist
  // is the contract, not the model's summary of it.
  it("overrides a stated pass when a dimension is failing", () => {
    const parsed = parseEvaluation(
      { verdict: "pass", dimensions: { a: { score: 2, comment: "weak" } }, issues: [{ severity: "high", note: "x" }] },
      ["a"],
    );
    expect(parsed.verdict).toBe("revise");
    expect(parsed.issues).toHaveLength(1);
  });

  it("drops checklist keys the style does not define", () => {
    const parsed = parseEvaluation(
      { verdict: "pass", dimensions: { a: { score: 5 }, invented: { score: 1 } } },
      ["a"],
    );
    expect(Object.keys(parsed.dimensions)).toEqual(["a"]);
    expect(parsed.verdict).toBe("pass");
  });

  it("clamps a score outside 1-5", () => {
    const parsed = parseEvaluation({ dimensions: { a: { score: 99 } } }, ["a"]);
    expect(parsed.dimensions.a!.score).toBe(5);
  });

  it("defaults an unrecognised severity to medium", () => {
    const parsed = parseEvaluation(
      { verdict: "revise", dimensions: { a: { score: 3 } }, issues: [{ severity: "spicy", note: "x" }] },
      ["a"],
    );
    expect(parsed.issues[0]!.severity).toBe("medium");
  });

  it("clears issues on a pass so a stale list cannot drive a revision", () => {
    const parsed = parseEvaluation(
      { verdict: "pass", dimensions: { a: { score: 5 } }, issues: [{ severity: "low", note: "nit" }] },
      ["a"],
    );
    expect(parsed.issues).toEqual([]);
  });
});

describe("seeded narrative styles", () => {
  it("gives every style a non-empty checklist, since it is what the evaluator is held to", () => {
    for (const style of db.select().from(narrativeStyles).all()) {
      expect(style.evaluationChecklist.length).toBeGreaterThan(0);
      for (const item of style.evaluationChecklist) {
        expect(item.key).toMatch(/^[a-z_]+$/);
        expect(item.description.length).toBeGreaterThan(0);
      }
    }
  });
});
