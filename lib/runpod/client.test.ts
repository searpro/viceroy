import { describe, it, expect, vi } from "vitest";
import { SdApiHttp } from "../sdapi/client";
import {
  RunpodClient,
  RunpodError,
  httpPorts,
  parseProxyUrl,
  podProxyUrl,
  uptimeMs,
  type RunpodPod,
} from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function runpod(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  const client = new RunpodClient(
    new SdApiHttp({ baseUrl: "https://rest.runpod.io/v1", apiKey: "k", fetch: fetchImpl, service: "RunPod" }),
  );
  return { client, fetchImpl };
}

describe("podProxyUrl / parseProxyUrl", () => {
  it("builds the proxy URL from the pod id and port", () => {
    expect(podProxyUrl("z24dr936kirjvh", 8188)).toBe(
      "https://z24dr936kirjvh-8188.proxy.runpod.net",
    );
  });

  // Existing providers were configured by pasting a URL, so adopting one into
  // pod-id form has to work without the user re-typing anything.
  it("recovers the pod id and port from a pasted URL", () => {
    expect(parseProxyUrl("https://z24dr936kirjvh-8188.proxy.runpod.net")).toEqual({
      podId: "z24dr936kirjvh",
      port: 8188,
    });
  });

  it("tolerates a trailing slash and surrounding space", () => {
    expect(parseProxyUrl("  https://abc123-3000.proxy.runpod.net/  ")).toEqual({
      podId: "abc123",
      port: 3000,
    });
  });

  it("returns null for a URL that is not a RunPod proxy", () => {
    expect(parseProxyUrl("http://localhost:8188")).toBeNull();
    expect(parseProxyUrl("https://example.com/8188")).toBeNull();
  });

  it("round-trips", () => {
    const parsed = parseProxyUrl(podProxyUrl("pod1", 8188))!;
    expect(podProxyUrl(parsed.podId, parsed.port)).toBe(podProxyUrl("pod1", 8188));
  });
});

describe("httpPorts", () => {
  it("keeps only the HTTP ports", () => {
    expect(httpPorts({ id: "p", ports: ["8188/http", "22/tcp", "3000/http"] })).toEqual([
      8188, 3000,
    ]);
  });

  it("copes with a pod that declares none", () => {
    expect(httpPorts({ id: "p" })).toEqual([]);
    expect(httpPorts({ id: "p", ports: null })).toEqual([]);
  });
});

describe("uptimeMs", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");

  it("measures from lastStartedAt while running", () => {
    const pod: RunpodPod = {
      id: "p",
      desiredStatus: "RUNNING",
      lastStartedAt: "2026-08-19T11:30:00Z",
    };
    expect(uptimeMs(pod, now)).toBe(30 * 60 * 1000);
  });

  // A stopped pod keeps its lastStartedAt, so without the status gate it would
  // report having been up since whenever it last ran — days, typically.
  it("reports nothing for a stopped pod that still has a start time", () => {
    const pod: RunpodPod = {
      id: "p",
      desiredStatus: "EXITED",
      lastStartedAt: "2026-08-01T00:00:00Z",
    };
    expect(uptimeMs(pod, now)).toBeNull();
  });

  it("returns null when there is no start time or it is unparseable", () => {
    expect(uptimeMs({ id: "p", desiredStatus: "RUNNING" }, now)).toBeNull();
    expect(uptimeMs({ id: "p", desiredStatus: "RUNNING", lastStartedAt: "nonsense" }, now)).toBeNull();
  });

  it("never goes negative on a clock skew", () => {
    const pod: RunpodPod = {
      id: "p",
      desiredStatus: "RUNNING",
      lastStartedAt: "2026-08-19T12:05:00Z",
    };
    expect(uptimeMs(pod, now)).toBe(0);
  });
});

describe("listPods", () => {
  it("sends the bearer token", async () => {
    const { client, fetchImpl } = runpod(() => json([]));
    await client.listPods();
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
  });

  it("accepts a bare array", async () => {
    const { client } = runpod(() => json([{ id: "a" }, { id: "b" }]));
    expect((await client.listPods()).map((pod) => pod.id)).toEqual(["a", "b"]);
  });

  // A wrapper shape must not silently read as "you have no pods", which would
  // look like an empty account rather than a parsing problem.
  it("accepts a wrapped array", async () => {
    const { client } = runpod(() => json({ pods: [{ id: "a" }] }));
    expect((await client.listPods()).map((pod) => pod.id)).toEqual(["a"]);
  });
});

describe("startPod / stopPod", () => {
  it.each([
    ["start", (c: RunpodClient) => c.startPod("pod1")],
    ["stop", (c: RunpodClient) => c.stopPod("pod1")],
  ])("POSTs to /pods/{id}/%s", async (action, call) => {
    const seen: { url: string; method?: string }[] = [];
    const { client } = runpod((url, init) => {
      seen.push({ url, method: init?.method });
      return new Response("", { status: 200 });
    });

    await call(client);
    expect(seen[0]!.url).toBe(`https://rest.runpod.io/v1/pods/pod1/${action}`);
    expect(seen[0]!.method).toBe("POST");
  });

  it("encodes an awkward pod id", async () => {
    const seen: string[] = [];
    const { client } = runpod((url) => {
      seen.push(url);
      return new Response("", { status: 200 });
    });
    await client.startPod("a/b");
    expect(seen[0]).toContain("pods/a%2Fb/start");
  });
});

describe("errors", () => {
  // RunPod's 401 has an empty body, so surfacing it raw tells the user nothing.
  it("explains a 401 as a key problem", async () => {
    const { client } = runpod(() => new Response("", { status: 401 }));
    await expect(client.listPods()).rejects.toThrow(/RUNPOD_API_KEY/);
    await expect(client.listPods()).rejects.toBeInstanceOf(RunpodError);
  });

  it("explains a 404 as an unknown pod", async () => {
    const { client } = runpod(() => new Response("", { status: 404 }));
    await expect(client.getPod("nope")).rejects.toThrow(/No such pod/);
  });
});

describe("spend", () => {
  it("asks for one pod over the requested window", async () => {
    let seen = "";
    const { client } = runpod((url) => {
      seen = url;
      return json([]);
    });

    await client.spend("pod1", new Date("2026-08-01T00:00:00Z"), new Date("2026-08-19T00:00:00Z"));
    expect(seen).toContain("podId=pod1");
    expect(seen).toContain("startTime=2026-08-01T00%3A00%3A00.000Z");
    expect(seen).toContain("grouping=podId");
  });

  it("sums the buckets into a total and a billed duration", async () => {
    const { client } = runpod(() =>
      json([
        { amount: 1.5, timeBilledMs: 3_600_000, podId: "pod1" },
        { amount: 2.25, timeBilledMs: 1_800_000, podId: "pod1" },
      ]),
    );

    const spend = await client.spend("pod1", new Date("2026-08-01T00:00:00Z"));
    expect(spend.total).toBeCloseTo(3.75);
    expect(spend.billedMs).toBe(5_400_000);
  });

  it("treats an empty window as zero rather than failing", async () => {
    const { client } = runpod(() => json([]));
    const spend = await client.spend("pod1", new Date("2026-08-01T00:00:00Z"));
    expect(spend).toMatchObject({ total: 0, billedMs: 0 });
  });

  it("tolerates records missing an amount", async () => {
    const { client } = runpod(() => json([{ podId: "pod1" }, { amount: 1, podId: "pod1" }]));
    expect((await client.spend("pod1", new Date())).total).toBe(1);
  });
});
