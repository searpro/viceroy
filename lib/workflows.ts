import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { checkApiFormat } from "./comfy/detect";
import { providers, workflows, WORKFLOW_ROLES, type WorkflowRole } from "./db/schema";
import type { ProviderKind } from "./providers";

/** Which roles belong to which provider kind. */
export const KIND_ROLES: Record<"image" | "video", readonly WorkflowRole[]> = {
  image: ["text_to_image", "text_to_image_ref"],
  video: ["image_to_video", "speech_to_video"],
};

const workflowVariableSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "image"]),
  binds: z.enum([
    "prompt",
    "negativePrompt",
    "width",
    "height",
    "seed",
    "refImages",
    "audio",
    "free",
  ]),
  defaultValue: z.unknown().optional(),
});

export const workflowSchema = z.object({
  providerId: z.string().trim().min(1),
  role: z.enum(WORKFLOW_ROLES),
  name: z.string().trim().min(1).max(100),
  graph: z.record(z.string(), z.unknown()),
  // No zod .default() here, for the same reason `providerSchema` avoids them:
  // .partial() (used for PATCH) still applies a default to a key that is
  // merely absent, which would wipe a workflow's variables on an unrelated
  // edit to its name.
  variables: z.array(workflowVariableSchema).optional(),
  outputNodeId: z.string().trim().min(1).nullable().optional(),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;

export type GraphProblem = { message: string };

/** Check a pasted graph is an API-format export before it is ever submitted. */
export function validateGraph(graph: Record<string, unknown>): GraphProblem | null {
  const problem = checkApiFormat(graph);
  return problem ? { message: problem } : null;
}

export function listWorkflows(db: Db, providerId?: string) {
  const query = db.select().from(workflows);
  return providerId ? query.where(eq(workflows.providerId, providerId)).all() : query.all();
}

/**
 * The workflow a stage should run for this provider and role.
 *
 * Throws rather than returning undefined, and names the role in the message:
 * a provider with no `text_to_image_ref` cannot hold a character's face steady
 * between frames, and discovering that as a silently reference-free generation
 * would be the image-side version of shipping desynced captions — it looks
 * finished and is wrong.
 */
export function resolveWorkflow(db: Db, providerId: string, role: WorkflowRole) {
  const workflow = db
    .select()
    .from(workflows)
    .where(and(eq(workflows.providerId, providerId), eq(workflows.role, role)))
    .get();

  if (!workflow) {
    const provider = db.select().from(providers).where(eq(providers.id, providerId)).get();
    throw new Error(
      `Provider "${provider?.name ?? providerId}" has no "${role}" workflow — ` +
        `add one on the Providers screen before running this stage`,
    );
  }
  return workflow;
}

function assertUsable(db: Db, input: Pick<WorkflowInput, "providerId" | "role">): void {
  const provider = db.select().from(providers).where(eq(providers.id, input.providerId)).get();
  if (!provider) throw new Error("No such provider");
  if (provider.adapter !== "comfyui") {
    throw new Error(`Only ComfyUI providers take workflows — "${provider.name}" is ${provider.adapter}`);
  }

  const allowed = KIND_ROLES[provider.kind as "image" | "video"] ?? [];
  if (!allowed.includes(input.role)) {
    throw new Error(
      `Role "${input.role}" does not apply to a ${provider.kind} provider — ` +
        `it takes ${allowed.join(", ")}`,
    );
  }
}

export function createWorkflow(db: Db, input: WorkflowInput) {
  assertUsable(db, input);
  const problem = validateGraph(input.graph);
  if (problem) throw new Error(problem.message);

  const [created] = db.insert(workflows).values(input).returning().all();
  return created!;
}

export function updateWorkflow(db: Db, id: string, input: Partial<WorkflowInput>) {
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) throw new Error("No such workflow");

  assertUsable(db, {
    providerId: input.providerId ?? existing.providerId,
    role: input.role ?? existing.role,
  });
  if (input.graph) {
    const problem = validateGraph(input.graph);
    if (problem) throw new Error(problem.message);
  }

  const [updated] = db.update(workflows).set(input).where(eq(workflows.id, id)).returning().all();
  return updated!;
}

export function deleteWorkflow(db: Db, id: string): void {
  const existing = db.select().from(workflows).where(eq(workflows.id, id)).get();
  if (!existing) throw new Error("No such workflow");
  db.delete(workflows).where(eq(workflows.id, id)).run();
}

export type { WorkflowRole, ProviderKind };
