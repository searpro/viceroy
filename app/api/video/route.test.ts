import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { createTestDb } from "@/lib/db/testing";
import { seed } from "@/lib/db/seed";
import type { VideoRequest } from "@/lib/video/client";

// Same seam as the character-image route test: this handler reaches its db and
// its video client through module-level singletons, so the modules are what
// gets mocked.
const { createJobMock } = vi.hoisted(() => ({
  createJobMock: vi.fn(async (_request: VideoRequest) => ({ id: "video_gen_1", status: "queued" })),
}));

let db: Db;
let close: () => void;

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => db };
});
vi.mock("@/lib/video/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/video/provider")>();
  return {
    ...actual,
    resolveVideoClient: (innerDb: Db, config: Parameters<typeof actual.resolveVideoClient>[1]) => ({
      provider: actual.resolveVideoClient(innerDb, config).provider,
      video: { createJob: createJobMock },
    }),
  };
});

const { POST } = await import("./route");

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
  createJobMock.mockClear();
});
afterEach(() => close());

function post(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return POST(new Request("http://test/api/video", { method: "POST", body: form }));
}

describe("POST /api/video", () => {
  it("rejects a body that is not multipart", async () => {
    const response = await POST(
      new Request("http://test/api/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "p" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("requires a prompt", async () => {
    const response = await post({ mode: "text", prompt: "  " });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/prompt/i);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  // The server would accept these and spend minutes of GPU time producing
  // something that ignores the mode entirely.
  it("refuses image-to-video with no reference image", async () => {
    const response = await post({ mode: "image", prompt: "a city" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/reference image/i);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("refuses speech-to-video with no driving audio", async () => {
    const response = await post({ mode: "speech", prompt: "singing", imageUrl: "http://x/a.png" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/driving audio/i);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("accepts text-to-video with no references at all", async () => {
    const response = await post({ mode: "text", prompt: "a city at sunset" });
    expect(response.status).toBe(202);
    expect(createJobMock.mock.calls[0]![0]).toMatchObject({ prompt: "a city at sunset" });
  });

  it("layers the request's params over the provider's defaults", async () => {
    await post({
      mode: "text",
      prompt: "p",
      params: JSON.stringify({ num_inference_steps: 8 }),
    });

    const sent = createJobMock.mock.calls[0]![0];
    // fps comes from the seeded provider, steps from the request.
    expect(sent.params).toMatchObject({ fps: 16, num_inference_steps: 8 });
  });

  it("falls back to the provider's negative prompt when the box is empty", async () => {
    await post({ mode: "text", prompt: "p" });
    expect(createJobMock.mock.calls[0]![0].negativePrompt).toMatch(/watermark/);

    await post({ mode: "text", prompt: "p", negativePrompt: "blurry" });
    expect(createJobMock.mock.calls[1]![0].negativePrompt).toBe("blurry");
  });

  // Inlining the bytes as a base64 data: URL puts them in a text form field,
  // which the server caps at 1024KB — the upload has to be a file part.
  it("sends an uploaded image as a file part, not an inline data URL", async () => {
    const form = new FormData();
    form.set("mode", "image");
    form.set("prompt", "p");
    form.set("imageFile", new File([new Uint8Array([1, 2, 3])], "ref.png", { type: "image/png" }));

    const response = await POST(
      new Request("http://test/api/video", { method: "POST", body: form }),
    );

    expect(response.status).toBe(202);
    const sent = createJobMock.mock.calls[0]![0];
    expect(sent.imageReference).toBeUndefined();
    expect(sent.upload).toMatchObject({ filename: "ref.png", contentType: "image/png" });
    expect([...sent.upload!.bytes]).toEqual([1, 2, 3]);
  });

  // A file and a URL for the same slot is a user correcting themselves; the
  // bytes they just picked are the newer intent. The server also refuses the
  // two together outright.
  it("drops the reference URL when a file is uploaded for the same slot", async () => {
    const form = new FormData();
    form.set("mode", "image");
    form.set("prompt", "p");
    form.set("imageUrl", "https://example.com/old.png");
    form.set("imageFile", new File([new Uint8Array([9])], "new.png", { type: "image/png" }));

    await POST(new Request("http://test/api/video", { method: "POST", body: form }));
    const sent = createJobMock.mock.calls[0]![0];
    expect(sent.imageReference).toBeUndefined();
    expect(sent.upload!.filename).toBe("new.png");
  });

  // `input_reference` is a single field; two files would silently lose one.
  it("refuses an image and a video upload together", async () => {
    const form = new FormData();
    form.set("mode", "image");
    form.set("prompt", "p");
    form.set("imageFile", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    form.set("videoFile", new File([new Uint8Array([2])], "b.mp4", { type: "video/mp4" }));

    const response = await POST(
      new Request("http://test/api/video", { method: "POST", body: form }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not both/i);
  });

  // Audio has no file-part field on this endpoint, so it must be inlined —
  // small clips go as-is, without ffmpeg being involved.
  it("inlines small uploaded audio as a data URL", async () => {
    const form = new FormData();
    form.set("mode", "speech");
    form.set("prompt", "p");
    form.set("imageUrl", "https://example.com/a.png");
    form.set("audioFile", new File([new Uint8Array([1, 2, 3])], "n.mp3", { type: "audio/mpeg" }));

    const response = await POST(
      new Request("http://test/api/video", { method: "POST", body: form }),
    );

    expect(response.status).toBe(202);
    expect(createJobMock.mock.calls[0]![0].audioReference).toBe("data:audio/mpeg;base64,AQID");
  });
});
