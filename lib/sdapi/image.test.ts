import { describe, it, expect, vi } from "vitest";
import { SdApiHttp } from "./client";
import { ImageClient } from "./image";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function imageClient(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { fetchImpl, image: new ImageClient(new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl })) };
}

const request = { prompt: "a city", model: "ssd-1b", width: 432, height: 768 };

describe("ImageClient.createJob (finding F4)", () => {
  it.each([
    ["width", { ...request, width: 360 }],
    ["height", { ...request, height: 1080 }],
  ])("refuses a %s that is not a multiple of 16", async (_name, bad) => {
    const { image, fetchImpl } = imageClient(() => json({}));
    await expect(image.createJob(bad)).rejects.toThrow(/multiple of 16/);
    // The point is to fail before sd-api quietly rounds it up.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the size it would have been rounded to", async () => {
    const { image } = imageClient(() => json({}));
    await expect(image.createJob({ ...request, width: 360 })).rejects.toThrow(/368/);
  });

  it("posts a conforming request", async () => {
    const { image, fetchImpl } = imageClient(() => json({ id: "j1", status: "queued", progress: 0 }));
    await image.createJob(request);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://sd/v1/jobs");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toMatchObject(request);
  });
});

describe("ImageClient.generate", () => {
  it("polls to completion, reports progress, and fetches the image", async () => {
    const statuses = [
      { id: "j1", status: "running", progress: 0.5 },
      { id: "j1", status: "completed", progress: 1, result: { image_url: "/v1/outputs/a.png" } },
    ];
    const progress: number[] = [];

    const { image, fetchImpl } = imageClient((url) => {
      if (url.endsWith("/v1/jobs")) return json({ id: "j1", status: "queued", progress: 0 });
      if (url.endsWith("/v1/outputs/a.png")) return new Response(Buffer.from("png-bytes"));
      return json(statuses.shift()!);
    });

    const result = await image.generate(request, {
      pollIntervalMs: 1,
      onProgress: (p) => progress.push(p),
    });

    expect(result.toString()).toBe("png-bytes");
    expect(progress).toEqual([0.5, 1]);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("http://sd/v1/outputs/a.png");
  });

  it("cancels upstream when asked to abort, rather than just abandoning the job", async () => {
    const deleted: string[] = [];
    const { image } = imageClient((url, init) => {
      if (url.endsWith("/v1/jobs")) return json({ id: "j1", status: "queued", progress: 0 });
      if (init?.method === "DELETE") {
        deleted.push(url);
        return json({});
      }
      return json({ id: "j1", status: "running", progress: 0.1 });
    });

    await expect(
      image.generate(request, { pollIntervalMs: 1, shouldAbort: () => true }),
    ).rejects.toThrow(/aborted/);
    expect(deleted).toEqual(["http://sd/v1/jobs/j1"]);
  });

  it("surfaces the upstream error message on failure", async () => {
    const { image } = imageClient((url) => {
      if (url.endsWith("/v1/jobs")) return json({ id: "j1", status: "queued", progress: 0 });
      return json({
        id: "j1",
        status: "failed",
        progress: 0,
        error: { code: "OOM", message: "out of memory" },
      });
    });

    await expect(image.generate(request, { pollIntervalMs: 1 })).rejects.toThrow(/out of memory/);
  });

  it("resolves an absolute image_path to an outputs route", async () => {
    const { image, fetchImpl } = imageClient((url) => {
      if (url.endsWith("/v1/jobs")) return json({ id: "j1", status: "queued", progress: 0 });
      if (url.includes("/v1/outputs/")) return new Response(Buffer.from("bytes"));
      return json({
        id: "j1",
        status: "completed",
        progress: 1,
        result: { image_path: "/abs/path/to/outputs/b.png" },
      });
    });

    await image.generate(request, { pollIntervalMs: 1 });
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("http://sd/v1/outputs/b.png");
  });
});
