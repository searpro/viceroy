import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { providers } from "./db/schema";

export const PROVIDER_KINDS = ["llm", "image", "audio", "asr", "video"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_ADAPTERS = ["sdapi", "comfyui"] as const;
export type ProviderAdapter = (typeof PROVIDER_ADAPTERS)[number];

/** Which kinds a given adapter can actually serve. */
export const ADAPTER_KINDS: Record<ProviderAdapter, readonly ProviderKind[]> = {
  sdapi: ["llm", "image", "audio", "asr"],
  // Image and video only. The pod carries no text-to-speech model — its audio
  // nodes are music generation and paid cloud wrappers — and an LLM or ASR
  // workflow would be a strange way to reach models sd-api already serves.
  // See finding F27.
  comfyui: ["image", "video"],
};

const computeSchema = z.object({
  kind: z.literal("runpod"),
  podId: z.string().trim().min(1),
  port: z.number().int().positive(),
  idleStopMinutes: z.number().int().positive().optional(),
});

export const providerSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  adapter: z.enum(PROVIDER_ADAPTERS).optional(),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  // Deliberately not `.min(1)`, even though the column is NOT NULL: a ComfyUI
  // provider has no model name to give, because the checkpoint is a node
  // inside the workflow. The "sd-api needs one" half of that rule is a
  // cross-field check, and lives with the other cross-field rules below
  // rather than here, so `.partial()` keeps working for PATCH.
  model: z.string().trim().max(200),
  // No zod .default() here: .partial() (used for PATCH) still applies a
  // field's default to a key that is simply absent from the patch, which
  // would silently un-default a provider or wipe its params on an unrelated
  // edit. Omitted fields fall through to the column's own default instead.
  defaultParams: z.record(z.string(), z.unknown()).optional(),
  // Diffusion-specific; meaningless outside kinds "image" and "video" but
  // kept on the shared schema like every other column here. No .default() for
  // the same .partial()-PATCH reason as defaultParams above.
  negativePrompt: z.string().trim().optional(),
  isDefault: z.boolean().optional(),
  compute: computeSchema.nullable().optional(),
});
export type ProviderInput = z.infer<typeof providerSchema>;

/**
 * The rules that span two fields, and so cannot live on the Zod object
 * without giving up `.partial()` for PATCH.
 *
 * `adapter` and `kind` are checked together because the pair is what decides
 * whether a row is reachable at all: a `comfyui` row of kind `llm` would pass
 * every single-field check and then fail at resolve time, when a project is
 * already half-generated.
 */
function assertCoherent(input: {
  kind: ProviderKind;
  adapter: ProviderAdapter;
  model: string;
}): void {
  const allowed = ADAPTER_KINDS[input.adapter];
  if (!allowed.includes(input.kind)) {
    throw new Error(
      `The ${input.adapter} adapter cannot serve "${input.kind}" providers — it supports ` +
        `${allowed.join(", ")}`,
    );
  }
  // ComfyUI is exempt: its checkpoint is a loader node inside the workflow,
  // so there is no model name for the row to carry.
  if (input.adapter === "sdapi" && input.model.trim() === "") {
    throw new Error(`An sd-api provider needs a model name`);
  }
}

/** Never send a stored key back over the wire — only whether one is set. */
function redact<T extends { apiKey: string | null }>(row: T): Omit<T, "apiKey"> & { hasApiKey: boolean } {
  const { apiKey, ...rest } = row;
  return { ...rest, hasApiKey: apiKey !== null && apiKey !== "" };
}

export function listProviders(db: Db) {
  return db.select().from(providers).all().map(redact);
}

// Only one provider per kind can be the default — `resolveProvider` picks
// whichever row has `isDefault`, and a second one would make that pick
// order-dependent rather than deliberate. Clearing siblings happens in the
// same transaction as the write that sets the new default.

export function createProvider(db: Db, input: ProviderInput) {
  assertCoherent({ ...input, adapter: input.adapter ?? "sdapi" });
  return db.transaction((tx) => {
    const [created] = tx.insert(providers).values(input).returning().all();
    if (input.isDefault) {
      tx.update(providers)
        .set({ isDefault: false })
        .where(and(eq(providers.kind, input.kind), ne(providers.id, created!.id)))
        .run();
    }
    return redact(created!);
  });
}

export function updateProvider(db: Db, id: string, input: Partial<ProviderInput>) {
  return db.transaction((tx) => {
    const existing = tx.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) throw new Error("No such provider");

    // A patch that touches one of these three has to be judged against the
    // other two as they will be *after* the write, not as they are now.
    assertCoherent({
      kind: input.kind ?? existing.kind,
      adapter: input.adapter ?? existing.adapter,
      model: input.model ?? existing.model,
    });

    const [updated] = tx.update(providers).set(input).where(eq(providers.id, id)).returning().all();
    if (input.isDefault) {
      tx.update(providers)
        .set({ isDefault: false })
        .where(and(eq(providers.kind, existing.kind), ne(providers.id, id)))
        .run();
    }
    return redact(updated!);
  });
}

export function deleteProvider(db: Db, id: string): void {
  const existing = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!existing) throw new Error("No such provider");

  const siblingCount = db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.kind, existing.kind))
    .all().length;
  if (siblingCount <= 1) {
    throw new Error(
      `Cannot delete the only ${existing.kind} provider — every stage that needs one would fail`,
    );
  }

  db.delete(providers).where(eq(providers.id, id)).run();
}
