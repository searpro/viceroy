import { Agent, fetch as undiciFetch, FormData as UndiciFormData } from "undici";

/**
 * Multipart bodies must be built with the same undici that sends them.
 *
 * Node's global `FormData` belongs to its bundled undici; handing one to this
 * package's `fetch` serialises to something sd-api rejects with a 400.
 * Measured: global FormData → 400, undici FormData → 201, same endpoint and
 * same bytes.
 */
export { UndiciFormData as SdFormData };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SdApiOptions = {
  baseUrl: string;
  /**
   * What to call this host in error messages.
   *
   * Defaults to sd-api because that is what almost every caller is talking to
   * — but not all of them are, and a video host's 400 reported as "sd-api
   * failed" sends whoever reads it to the wrong machine.
   */
  service?: string;
  apiKey?: string | undefined;
  fetch?: FetchLike;
  /** Overall per-request ceiling, in ms. Defaults to 30 minutes. */
  timeoutMs?: number;
};

/**
 * Node's global `fetch` gives up after 300 s waiting for response headers.
 *
 * That default is invisible until an inference runs longer than five minutes,
 * and then it is silent and total: the client abandons the request with a bare
 * "fetch failed" while sd-api carries on generating. The next attempt then
 * collides with the still-running one and gets a "model is busy" 503, which
 * reads like a server problem rather than a client timeout.
 *
 * A one-shot narration of a full story takes ~6 minutes (finding F18), so this
 * default is squarely inside viceroy's normal operating range. Both timeouts
 * are therefore lifted well clear of it, and bounded rather than disabled so a
 * genuinely dead connection still fails eventually.
 *
 * See docs/findings.md F19.
 */
function createAgent(timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    // Long generations are idle on the wire while the model works; without
    // this the connection is reaped as stale mid-inference.
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: timeoutMs,
  });
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export class SdApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    readonly body: string,
    readonly service = "sd-api",
  ) {
    super(`${service} ${route} failed: ${status} ${body}`);
    this.name = "SdApiError";
  }
}

export class SdApiHttp {
  readonly baseUrl: string;
  readonly service: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: SdApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.service = options.service ?? "sd-api";
    this.apiKey = options.apiKey;

    if (options.fetch) {
      this.fetchImpl = options.fetch;
    } else {
      const dispatcher = createAgent(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      // undici's own fetch, not the global one: Node's built-in fetch rejects
      // an Agent from a separate undici install with UND_ERR_INVALID_ARG,
      // since it validates the dispatcher against its own bundled copy.
      this.fetchImpl = (input, init) =>
        undiciFetch(input, { ...init, dispatcher } as never) as unknown as Promise<Response>;
    }
  }

  get authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  url(route: string): string {
    return `${this.baseUrl}${route}`;
  }

  async request(route: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(route), {
        ...init,
        headers: { ...this.authHeaders, ...(init?.headers ?? {}) },
      });
    } catch (error) {
      // Node reports every transport failure as a bare "fetch failed" and
      // hides the reason in `cause`. Losing it turns a client-side timeout
      // into an unattributable error — which is exactly how F19 stayed hidden
      // through four identical 301-second failures.
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ?? cause?.message;
      throw new Error(
        `${this.service} ${route} could not be reached: ${(error as Error).message}` +
          (detail ? ` (${detail})` : ""),
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new SdApiError(
        response.status,
        route,
        await response.text().catch(() => ""),
        this.service,
      );
    }
    return response;
  }

  async json<T>(route: string, init?: RequestInit): Promise<T> {
    const response = await this.request(route, init);
    return (await response.json()) as T;
  }

  async postJson<T>(route: string, body: unknown): Promise<T> {
    return this.json<T>(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
