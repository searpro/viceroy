import { SdApiHttp, type SdApiOptions } from "../sdapi/client";

/**
 * Client for RunPod's public REST API.
 *
 * Shapes here come from RunPod's own OpenAPI document
 * (https://rest.runpod.io/v1/openapi.json) rather than from prose docs, so the
 * field names and enums below are the ones the server declares. Where the spec
 * says a response body is empty — `start` and `stop` both do — this client
 * treats it as empty rather than inventing a return value.
 *
 * Reuses `SdApiHttp` for its Bearer handling and its error reporting, which
 * keeps a dead network reported the same way here as everywhere else. The long
 * generation timeouts it also carries are irrelevant to these calls: every one
 * of them is a short control-plane request.
 */

export const RUNPOD_API_URL = "https://rest.runpod.io/v1";

/** RunPod's own vocabulary: what the pod is *meant* to be doing. */
export type PodStatus = "RUNNING" | "EXITED" | "TERMINATED";

export type RunpodPod = {
  id: string;
  name?: string;
  desiredStatus?: PodStatus;
  /** Credits per hour while running. */
  costPerHr?: number;
  /** Effective rate once any savings plan is applied — bill this, not costPerHr. */
  adjustedCostPerHr?: number;
  /** UTC timestamp of the last start, which is what uptime is measured from. */
  lastStartedAt?: string | null;
  lastStatusChange?: string | null;
  /** e.g. ["8188/http", "22/tcp"] */
  ports?: string[] | null;
  portMappings?: Record<string, number> | null;
  publicIp?: string | null;
  machineId?: string | null;
  gpu?: { id?: string; count?: number } | null;
  interruptible?: boolean;
};

/** One row of `GET /billing/pods`. */
export type BillingRecord = {
  /** USD charged for this bucket. */
  amount?: number;
  /** Start of the period this record covers. */
  time?: string;
  timeBilledMs?: number;
  diskSpaceBilledGb?: number;
  podId?: string;
};

export type PodSpend = {
  /** USD across the requested window. */
  total: number;
  /** Milliseconds of billed runtime across the window. */
  billedMs: number;
  from: string;
  to: string;
};

/**
 * The public URL RunPod's proxy gives a pod's HTTP port.
 *
 * This is the whole reason a pod id is worth storing: the base URL is derived
 * from it, so a pod recreated under a new id needs one field changed rather
 * than a URL re-copied from the dashboard.
 */
export function podProxyUrl(podId: string, port: number): string {
  return `https://${podId}-${port}.proxy.runpod.net`;
}

/** Recover a pod id and port from a proxy URL, for adopting an existing row. */
export function parseProxyUrl(url: string): { podId: string; port: number } | null {
  const match = /^https?:\/\/([a-z0-9]+)-(\d+)\.proxy\.runpod\.net\/?$/i.exec(url.trim());
  if (!match) return null;
  return { podId: match[1]!, port: Number(match[2]) };
}

/** The HTTP ports a pod exposes, parsed out of `["8188/http", "22/tcp"]`. */
export function httpPorts(pod: RunpodPod): number[] {
  return (pod.ports ?? [])
    .map((entry) => /^(\d+)\/http$/i.exec(entry.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

/**
 * How long the pod has been up, in milliseconds, or null if it is not running.
 *
 * Derived from `lastStartedAt` rather than read from a field, because the API
 * has no uptime field — and a stopped pod's `lastStartedAt` is still set, so
 * the status has to gate it or a stopped pod appears to have been running for
 * days.
 */
export function uptimeMs(pod: RunpodPod, now = Date.now()): number | null {
  if (pod.desiredStatus !== "RUNNING" || !pod.lastStartedAt) return null;
  const started = Date.parse(pod.lastStartedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, now - started);
}

export class RunpodError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RunpodError";
  }
}

export class RunpodClient {
  constructor(private readonly http: SdApiHttp) {}

  async listPods(): Promise<RunpodPod[]> {
    const payload = await this.call<RunpodPod[] | { pods?: RunpodPod[] }>("/pods");
    // The spec names the response `Pods`; accept either a bare array or a
    // wrapper so a shape change does not silently produce an empty list.
    if (Array.isArray(payload)) return payload;
    return payload.pods ?? [];
  }

  async getPod(podId: string): Promise<RunpodPod> {
    return this.call<RunpodPod>(`/pods/${encodeURIComponent(podId)}`);
  }

  /**
   * Start or resume a pod.
   *
   * Returns nothing useful — the spec declares an empty 200 body — so the
   * caller must poll `getPod` to learn when it is actually up. "Started"
   * means RunPod accepted the request, not that ComfyUI is answering: on a
   * cold pod the model load alone is ~33 s after that (finding F26).
   */
  async startPod(podId: string): Promise<void> {
    await this.request(`/pods/${encodeURIComponent(podId)}/start`, { method: "POST" });
  }

  async stopPod(podId: string): Promise<void> {
    await this.request(`/pods/${encodeURIComponent(podId)}/stop`, { method: "POST" });
  }

  /**
   * What a pod has actually cost over a window.
   *
   * Real billing records rather than `costPerHr × uptime`: the rate is what a
   * pod costs while running, and it says nothing about the storage a stopped
   * pod still bills for. Multiplying the rate would therefore under-report the
   * bill precisely when the user is trying to check whether stopping helped.
   */
  async spend(podId: string, since: Date, until = new Date()): Promise<PodSpend> {
    const query = new URLSearchParams({
      podId,
      startTime: since.toISOString(),
      endTime: until.toISOString(),
      grouping: "podId",
      bucketSize: "day",
    });

    const records = await this.call<BillingRecord[] | { records?: BillingRecord[] }>(
      `/billing/pods?${query.toString()}`,
    );
    const rows = Array.isArray(records) ? records : (records.records ?? []);

    return {
      total: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
      billedMs: rows.reduce((sum, row) => sum + (row.timeBilledMs ?? 0), 0),
      from: since.toISOString(),
      to: until.toISOString(),
    };
  }

  private async call<T>(route: string): Promise<T> {
    try {
      return await this.http.json<T>(route);
    } catch (error) {
      throw toRunpodError(error);
    }
  }

  private async request(route: string, init: RequestInit): Promise<void> {
    try {
      await this.http.request(route, init);
    } catch (error) {
      throw toRunpodError(error);
    }
  }
}

/**
 * Turn a transport error into something that names the likely cause.
 *
 * A 401 here means one specific thing — the key is missing, wrong, or lacks
 * permission — and saying so beats surfacing RunPod's bare empty body, which
 * is what its 401 actually returns.
 */
function toRunpodError(error: unknown): RunpodError {
  const status = (error as { status?: number }).status;
  if (status === 401) {
    return new RunpodError(
      "RunPod rejected the API key — check RUNPOD_API_KEY is set and has Pod read/write permission",
      401,
    );
  }
  if (status === 404) {
    return new RunpodError("No such pod — check the pod id", 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RunpodError(message, status);
}

export function createRunpodClient(
  apiKey: string,
  options: Partial<SdApiOptions> = {},
): RunpodClient {
  return new RunpodClient(
    new SdApiHttp({
      baseUrl: RUNPOD_API_URL,
      apiKey,
      service: "RunPod",
      // Control-plane calls, not generations: fail fast rather than hanging
      // the Providers screen behind the 30-minute default.
      timeoutMs: 30_000,
      ...options,
    }),
  );
}
