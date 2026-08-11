import { describe, it, expect, vi } from "vitest";
import { SdApiHttp, SdApiError } from "./client";

describe("SdApiHttp", () => {
  it("joins routes onto the base url and strips a trailing slash", () => {
    expect(new SdApiHttp({ baseUrl: "http://sd/" }).url("/v1/jobs")).toBe("http://sd/v1/jobs");
  });

  it("sends a bearer token when one is configured", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"));
    await new SdApiHttp({ baseUrl: "http://sd", apiKey: "k", fetch: fetchImpl }).request("/x");
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe(
      "Bearer k",
    );
  });

  it("raises SdApiError with the status and body on a failure response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
    const http = new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl });

    await expect(http.request("/x")).rejects.toBeInstanceOf(SdApiError);
    await expect(http.request("/x")).rejects.toThrow(/503 boom/);
  });

  /**
   * A transport failure arrives as a bare "fetch failed" with the real reason
   * buried in `cause`. Dropping it is what let a 300s client-side timeout
   * masquerade as a server problem through four identical failures — see
   * finding F19.
   */
  it("surfaces the underlying cause of a transport failure", async () => {
    const failure = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" },
    });
    const fetchImpl = vi.fn(async () => {
      throw failure;
    });

    const http = new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl });
    await expect(http.request("/v1/audio/tasks/run")).rejects.toThrow(
      /could not be reached.*UND_ERR_HEADERS_TIMEOUT/,
    );
  });

  it("names the route that failed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl }).request("/v1/audio/tasks/run"),
    ).rejects.toThrow(/\/v1\/audio\/tasks\/run/);
  });
});
