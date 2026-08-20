import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { providers, workflows } from "./db/schema";
import { createProvider } from "./providers";
import {
  createWorkflow,
  deleteWorkflow,
  resolveWorkflow,
  updateWorkflow,
  validateGraph,
} from "./workflows";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

/** A minimal but genuine API-format graph, shaped like the probe's. */
const GRAPH = {
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: "flux-2-klein-base-4b-fp8.safetensors", weight_dtype: "default" },
  },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["2", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "viceroy" } },
};

function comfyImageProvider(db: Db) {
  return createProvider(db, {
    kind: "image",
    adapter: "comfyui",
    name: "comfy (runpod)",
    baseUrl: "https://example-8188.proxy.runpod.net",
    model: "",
  });
}

describe("validateGraph", () => {
  it("accepts an API-format export", () => {
    expect(validateGraph(GRAPH)).toBeNull();
  });

  // Pasting the editor's save format instead of the API export is the mistake
  // everyone makes once; it must not reach ComfyUI to be diagnosed there.
  it("names the editor save format specifically rather than failing generically", () => {
    const uiFormat = { nodes: [{ id: 1, type: "UNETLoader" }], links: [], version: 0.4 };
    expect(validateGraph(uiFormat)!.message).toMatch(/Export \(API\)/);
  });

  it("rejects a graph whose entries are not API nodes", () => {
    expect(validateGraph({ "1": { title: "no class_type" } })!.message).toMatch(/class_type/);
  });

  it("rejects an empty graph", () => {
    expect(validateGraph({})!.message).toMatch(/empty/);
  });
});

describe("createWorkflow", () => {
  it("stores the graph verbatim, including nodes it does not understand", () => {
    const provider = comfyImageProvider(db);
    const exotic = { ...GRAPH, "99": { class_type: "SomeCustomNode", inputs: { whatever: 7 } } };

    const created = createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "Flux 2 Klein t2i",
      graph: exotic,
    });

    const raw = db.select().from(workflows).where(eq(workflows.id, created.id)).get()!;
    expect(raw.graph).toEqual(exotic);
  });

  it("refuses a workflow on a non-ComfyUI provider", () => {
    const sdapi = db.select().from(providers).where(eq(providers.kind, "image")).get()!;
    expect(() =>
      createWorkflow(db, {
        providerId: sdapi.id,
        role: "text_to_image",
        name: "nope",
        graph: GRAPH,
      }),
    ).toThrow(/Only ComfyUI providers/);
  });

  it("refuses a role that does not belong to the provider's kind", () => {
    const provider = comfyImageProvider(db);
    expect(() =>
      createWorkflow(db, {
        providerId: provider.id,
        role: "speech_to_video",
        name: "wrong kind",
        graph: GRAPH,
      }),
    ).toThrow(/does not apply to a image provider/);
  });

  it("refuses a second workflow for the same role", () => {
    const provider = comfyImageProvider(db);
    const input = {
      providerId: provider.id,
      role: "text_to_image" as const,
      name: "first",
      graph: GRAPH,
    };
    createWorkflow(db, input);
    expect(() => createWorkflow(db, { ...input, name: "second" })).toThrow();
  });
});

describe("resolveWorkflow", () => {
  it("returns the workflow for the requested role", () => {
    const provider = comfyImageProvider(db);
    const created = createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
    });
    expect(resolveWorkflow(db, provider.id, "text_to_image").id).toBe(created.id);
  });

  // A missing ref workflow must not silently degrade to a reference-free
  // generation — that produces a different face per frame and looks finished.
  it("throws naming the provider and the missing role", () => {
    const provider = comfyImageProvider(db);
    createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
    });

    expect(() => resolveWorkflow(db, provider.id, "text_to_image_ref")).toThrow(
      /comfy \(runpod\).*text_to_image_ref/,
    );
  });
});

describe("updateWorkflow", () => {
  it("validates a replacement graph", () => {
    const provider = comfyImageProvider(db);
    const created = createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
    });

    expect(() =>
      updateWorkflow(db, created.id, { graph: { nodes: [], links: [] } }),
    ).toThrow(/Export \(API\)/);
  });

  it("leaves variables alone when the patch does not mention them", () => {
    const provider = comfyImageProvider(db);
    const created = createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
      variables: [{ name: "prompt", type: "string", binds: "prompt" }],
    });

    updateWorkflow(db, created.id, { name: "renamed" });

    const raw = db.select().from(workflows).where(eq(workflows.id, created.id)).get()!;
    expect(raw.name).toBe("renamed");
    expect(raw.variables).toHaveLength(1);
  });
});

describe("deleteWorkflow", () => {
  it("removes the row", () => {
    const provider = comfyImageProvider(db);
    const created = createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
    });
    deleteWorkflow(db, created.id);
    expect(db.select().from(workflows).all()).toHaveLength(0);
  });

  // Workflows are worthless without their provider, and leaving them behind
  // would let a recreated provider inherit a stranger's graph.
  it("cascades when the provider is deleted", () => {
    const provider = comfyImageProvider(db);
    createWorkflow(db, {
      providerId: provider.id,
      role: "text_to_image",
      name: "t2i",
      graph: GRAPH,
    });

    db.delete(providers).where(eq(providers.id, provider.id)).run();
    expect(db.select().from(workflows).all()).toHaveLength(0);
  });
});
