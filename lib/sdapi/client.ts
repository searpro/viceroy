export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SdApiOptions = {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: FetchLike;
};

export class SdApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: string,
    readonly body: string,
  ) {
    super(`sd-api ${route} failed: ${status} ${body}`);
    this.name = "SdApiError";
  }
}

export class SdApiHttp {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: SdApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  url(route: string): string {
    return `${this.baseUrl}${route}`;
  }

  async request(route: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(this.url(route), {
      ...init,
      headers: { ...this.authHeaders, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new SdApiError(response.status, route, await response.text().catch(() => ""));
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
