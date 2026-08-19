import { describe, it, expect, vi } from "vitest";
import { SdApiHttp } from "../sdapi/client";
import { VideoClient, describeVideoError, encodeVideoRequest } from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function videoClient(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return {
    fetchImpl,
    video: new VideoClient(new SdApiHttp({ baseUrl: "http://omni", fetch: fetchImpl })),
  };
}

const queued = (over: Record<string, unknown> = {}) => ({
  id: "video_gen_1",
  object: "video",
  status: "queued",
  model: "Wan-AI/Wan2.2-S2V-14B",
  prompt: "a person singing",
  progress: 0,
  ...over,
});

describe("encodeVideoRequest", () => {
  it("wraps each reference in its own per-modality key", () => {
    const form = encodeVideoRequest({
      prompt: "p",
      imageReference: "https://example.com/a.png",
      audioReference: "data:audio/mpeg;base64,AAAA",
      videoReference: "https://example.com/a.mp4",
    });

    expect(form.get("image_reference")).toBe('{"image_url":"https://example.com/a.png"}');
    expect(form.get("audio_reference")).toBe('{"audio_url":"data:audio/mpeg;base64,AAAA"}');
    expect(form.get("video_reference")).toBe('{"video_url":"https://example.com/a.mp4"}');
  });

  it("omits references that were not supplied", () => {
    const form = encodeVideoRequest({ prompt: "p" });
    expect(form.get("image_reference")).toBeNull();
    expect(form.get("audio_reference")).toBeNull();
    expect(form.get("video_reference")).toBeNull();
  });

  it("sends the negative prompt under the server's field name", () => {
    const form = encodeVideoRequest({ prompt: "p", negativePrompt: "watermark" });
    expect(form.get("negative_prompt")).toBe("watermark");
  });

  it("passes arbitrary params through as form fields", () => {
    const form = encodeVideoRequest({
      prompt: "p",
      params: { width: 832, fps: 16, guidance_scale: 4.5, enable_frame_interpolation: true },
    });

    expect(form.get("width")).toBe("832");
    expect(form.get("fps")).toBe("16");
    expect(form.get("guidance_scale")).toBe("4.5");
    expect(form.get("enable_frame_interpolation")).toBe("true");
  });

  // "let the server decide" has to mean an absent field: the string "null"
  // fails the field's own type validation instead.
  it("drops null and undefined params rather than stringifying them", () => {
    const form = encodeVideoRequest({ prompt: "p", params: { seed: null, width: undefined } });
    expect(form.get("seed")).toBeNull();
    expect(form.get("width")).toBeNull();
  });
});

describe("VideoClient.createJob", () => {
  it("posts multipart to /v1/videos without naming a content-type", async () => {
    const { video, fetchImpl } = videoClient(() => json(queued()));
    await video.createJob({ prompt: "a person singing", model: "wan" });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://omni/v1/videos");
    expect(init!.method).toBe("POST");
    // Setting content-type by hand would strip the multipart boundary.
    expect(init!.headers).not.toHaveProperty("content-type");
    expect((init!.body as FormData).get("prompt")).toBe("a person singing");
  });
});

describe("VideoClient.awaitJob", () => {
  it("polls to completion and reports each status", async () => {
    const statuses = [
      queued({ status: "queued" }),
      queued({ status: "in_progress" }),
      queued({ status: "completed", completed_at: 2 }),
    ];
    const seen: string[] = [];

    const { video } = videoClient(() => json(statuses.shift()!));
    const finished = await video.awaitJob("video_gen_1", {
      pollIntervalMs: 1,
      onStatus: (job) => seen.push(job.status),
    });

    expect(seen).toEqual(["queued", "in_progress", "completed"]);
    expect(finished.status).toBe("completed");
  });

  it("surfaces the upstream error message on failure", async () => {
    const { video } = videoClient(() =>
      json(queued({ status: "failed", error: { code: 500, message: "CUDA out of memory" } })),
    );
    await expect(video.awaitJob("video_gen_1", { pollIntervalMs: 1 })).rejects.toThrow(
      /CUDA out of memory/,
    );
  });

  it("drops the job record upstream when asked to abort", async () => {
    const deleted: string[] = [];
    const { video } = videoClient((url, init) => {
      if (init?.method === "DELETE") {
        deleted.push(url);
        return json({ id: "video_gen_1", deleted: true });
      }
      return json(queued({ status: "in_progress" }));
    });

    await expect(
      video.awaitJob("video_gen_1", { pollIntervalMs: 1, shouldAbort: () => true }),
    ).rejects.toThrow(/aborted/);
    expect(deleted).toEqual(["http://omni/v1/videos/video_gen_1"]);
  });
});

describe("VideoClient.generate", () => {
  it("creates, waits, then downloads the mp4", async () => {
    const { video, fetchImpl } = videoClient((url, init) => {
      if (init?.method === "POST") return json(queued());
      if (url.endsWith("/content")) return new Response(Buffer.from("mp4-bytes"));
      return json(queued({ status: "completed" }));
    });

    const bytes = await video.generate({ prompt: "p" }, { pollIntervalMs: 1 });

    expect(bytes.toString()).toBe("mp4-bytes");
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("http://omni/v1/videos/video_gen_1/content");
  });
});

// vllm-omni's error envelope is not sd-api's, so the readable half has to be
// dug out rather than read off SdApiError directly.
describe("describeVideoError", () => {
  it("extracts the message from a vllm-omni error envelope", async () => {
    const { video } = videoClient(() =>
      json({ error: { message: "Field required", type: "Bad Request", code: 400 } }, 400),
    );

    const error = await video.createJob({ prompt: "p" }).catch((e: unknown) => e);
    expect(describeVideoError(error)).toBe("Field required");
  });

  it("falls back to the raw error for anything else", () => {
    expect(describeVideoError(new Error("connection refused"))).toBe("connection refused");
  });
});
