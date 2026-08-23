/**
 * Reachability of the providers the pipeline will actually call.
 *
 * The home page used to show one badge — "sd-api reachable" — derived from a
 * single `GET /health` against `config.sdApiUrl`. That was true when sd-api
 * served everything; it stopped being true once images could come from
 * ComfyUI, video always did, and the LLM could be a hosted OpenAI-compatible
 * endpoint. A green badge then meant "one host answered", which is not the
 * question anyone is asking before starting a two-hour movie run.
 *
 * So this probes the *default provider for each kind* — the exact rows
 * `resolveProvider` will pick — and reports them one by one.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { providers } from "./db/schema";
import { PROVIDER_KINDS, type ProviderAdapter, type ProviderKind } from "./providers";

export type ProviderHealthStatus = "ok" | "unreachable" | "unconfigured";

export type ProviderHealth = {
  kind: ProviderKind;
  status: ProviderHealthStatus;
  providerId: string | null;
  name: string | null;
  adapter: ProviderAdapter | null;
  model: string | null;
  /** Host only — a base URL can carry a key in its query string on some hosts. */
  host: string | null;
  detail: string | null;
  latencyMs: number | null;
  checkedAt: string;
};

/**
 * Short on purpose. This runs on every page load behind the nav indicator, and
 * a stopped RunPod pod simply does not answer — waiting 30s to discover that
 * would make the whole app feel broken because one optional backend is asleep.
 * A slow-but-alive host reports `unreachable` here and still works for a job,
 * which is the right way round: the badge is a hint, `resolveProvider` is the
 * authority.
 */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * The paths each adapter answers, in the order worth trying.
 *
 * sd-api serves `/health`; an OpenAI-compatible host (the "Google" provider row
 * points at `generativelanguage.googleapis.com/v1beta/openai/`) does not, but
 * does serve `/models`. ComfyUI has no health endpoint at all — `/system_stats`
 * is what its own front end polls.
 */
const PROBE_PATHS: Record<ProviderAdapter, string[]> = {
  sdapi: ["/health", "/models", "/v1/models"],
  comfyui: ["/system_stats", "/queue"],
};

export async function probeProviders(db: Db): Promise<ProviderHealth[]> {
  return Promise.all(PROVIDER_KINDS.map((kind) => probeKind(db, kind)));
}

async function probeKind(db: Db, kind: ProviderKind): Promise<ProviderHealth> {
  const row =
    db
      .select()
      .from(providers)
      .where(and(eq(providers.kind, kind), eq(providers.isDefault, true)))
      .get() ?? db.select().from(providers).where(eq(providers.kind, kind)).get();

  const checkedAt = new Date().toISOString();

  if (!row) {
    return {
      kind,
      status: "unconfigured",
      providerId: null,
      name: null,
      adapter: null,
      model: null,
      host: null,
      detail: `No ${kind} provider configured`,
      latencyMs: null,
      checkedAt,
    };
  }

  const base = { kind, providerId: row.id, name: row.name, adapter: row.adapter, model: row.model || null, host: hostOf(row.baseUrl), checkedAt };
  const startedAt = Date.now();
  const result = await reach(row.baseUrl, row.adapter, row.apiKey);

  return {
    ...base,
    status: result.ok ? "ok" : "unreachable",
    detail: result.detail,
    latencyMs: Date.now() - startedAt,
  };
}

async function reach(
  baseUrl: string,
  adapter: ProviderAdapter,
  apiKey: string | null,
): Promise<{ ok: boolean; detail: string | null }> {
  const root = baseUrl.replace(/\/$/, "");
  let lastDetail: string | null = null;

  for (const path of PROBE_PATHS[adapter]) {
    try {
      const response = await fetch(`${root}${path}`, {
        method: "GET",
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: "no-store",
      });
      if (response.ok) return { ok: true, detail: null };
      // A 401/403 means the host is up and the credential is the problem —
      // worth saying, because "unreachable" would send someone to check their
      // network when the fix is a key.
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `${response.status} — the host answered but rejected the credential` };
      }
      lastDetail = `${path} returned ${response.status}`;
    } catch (error) {
      lastDetail = error instanceof Error && error.name === "TimeoutError"
        ? `No answer within ${PROBE_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    }
  }

  return { ok: false, detail: lastDetail };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** One-line summary for the nav badge: how many kinds are answering. */
export function healthSummary(rows: ProviderHealth[]): {
  ok: number;
  total: number;
  degraded: boolean;
  worst: ProviderHealthStatus;
} {
  const ok = rows.filter((row) => row.status === "ok").length;
  const worst: ProviderHealthStatus = rows.some((row) => row.status === "unreachable")
    ? "unreachable"
    : rows.some((row) => row.status === "unconfigured")
      ? "unconfigured"
      : "ok";
  return { ok, total: rows.length, degraded: ok < rows.length, worst };
}
