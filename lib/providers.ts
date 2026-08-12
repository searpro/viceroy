import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client";
import { providers } from "./db/schema";

export const PROVIDER_KINDS = ["llm", "image", "audio", "asr"] as const;

export const providerSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  // No zod .default() here: .partial() (used for PATCH) still applies a
  // field's default to a key that is simply absent from the patch, which
  // would silently un-default a provider or wipe its params on an unrelated
  // edit. Omitted fields fall through to the column's own default instead.
  defaultParams: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});
export type ProviderInput = z.infer<typeof providerSchema>;

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
