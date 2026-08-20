import { describe, it, expect } from "vitest";
import type { SdApi } from "../sdapi";
import { sdApiImageBackend } from "./sdapi-image";

/**
 * These assertions used to live in the stage tests, back when a stage built
 * sd-api's request shape itself. They belong here now: translating Viceroy's
 * request into `ref_images`, `increase_ref_index`, `model` and `defaultParams`
 * is exactly what this adapter is for, and it is the half that must not change
 * behaviour just because the interface moved.
 */
function backend(provider: Partial<Parameters<typeof sdApiImageBackend>[1]> = {}) {
  const requests: Record<string, unknown>[] = [];
  const sdApi = {
    image: {
      generate: async (request: Record<string, unknown>) => {
        requests.push(request);
        return Buffer.from("png");
      },
      uploadInput: async (_bytes: Buffer, filename: string) => `uploaded-${filename}`,
      hasInput: async (name: string) => name !== "gone.png",
    },
  } as unknown as SdApi;

  return {
    requests,
    image: sdApiImageBackend(sdApi, {
      name: "sd-api (local)",
      model: "flux2-klein-4b",
      defaultParams: {},
      ...provider,
    }),
  };
}

const request = {
  prompt: "a lighthouse",
  negativePrompt: "",
  width: 432,
  height: 768,
  references: [] as string[],
};

describe("sdApiImageBackend.generate", () => {
  it("sends the provider's model and default params", async () => {
    const { image, requests } = backend({ model: "sdxl-turbo", defaultParams: { steps: 20, seed: 7 } });
    await image.generate(request);
    expect(requests[0]).toMatchObject({ model: "sdxl-turbo", steps: 20, seed: 7 });
  });

  it("maps references onto ref_images", async () => {
    const { image, requests } = backend();
    await image.generate({ ...request, references: ["a.png"] });
    expect(requests[0]!.ref_images).toEqual(["a.png"]);
  });

  // Distinct reference slots, so two people in one frame stay two people.
  it("sets increase_ref_index only when a frame carries more than one face", async () => {
    const { image, requests } = backend();
    await image.generate({ ...request, references: ["a.png"] });
    await image.generate({ ...request, references: ["a.png", "b.png"] });

    expect(requests[0]).not.toHaveProperty("increase_ref_index");
    expect(requests[1]!.increase_ref_index).toBe(true);
  });

  it("omits ref_images entirely for a text-only generation", async () => {
    const { image, requests } = backend();
    await image.generate(request);
    expect(requests[0]).not.toHaveProperty("ref_images");
    expect(requests[0]).not.toHaveProperty("increase_ref_index");
  });

  // An empty avoid-list must not become `negative_prompt: ""` — sd-api would
  // treat the empty string as a real, if useless, prompt.
  it("omits an empty negative prompt rather than sending a blank one", async () => {
    const { image, requests } = backend();
    await image.generate(request);
    expect(requests[0]).not.toHaveProperty("negative_prompt");

    await image.generate({ ...request, negativePrompt: "blurry" });
    expect(requests[1]!.negative_prompt).toBe("blurry");
  });
});

describe("sdApiImageBackend references", () => {
  it("reports no practical slot limit", () => {
    // sd-api takes an arbitrary-length array, so a crowded scene is never
    // truncated on its account.
    expect(backend().image.referenceCapacity()).toBe(Number.POSITIVE_INFINITY);
  });

  it("uploads through sd-api's input endpoint", async () => {
    expect(await backend().image.uploadReference(Buffer.from("png"), "x.png")).toBe("uploaded-x.png");
  });

  it("reports a dangling reference as absent", async () => {
    const { image } = backend();
    expect(await image.hasReference("live.png")).toBe(true);
    expect(await image.hasReference("gone.png")).toBe(false);
  });
});
