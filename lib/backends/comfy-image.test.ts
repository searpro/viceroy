import { describe, it, expect, vi } from "vitest";
import type { ComfyClient } from "../comfy/client";
import type { WorkflowVariable, workflows } from "../db/schema";
import { comfyImageBackend } from "./comfy-image";

type Workflow = typeof workflows.$inferSelect;

const GRAPH = {
  "4": { class_type: "CLIPTextEncode", inputs: { text: "{{positive}}", clip: ["2", 0] } },
  "5": { class_type: "CLIPTextEncode", inputs: { text: "{{negative}}", clip: ["2", 0] } },
  "6": { class_type: "EmptyFlux2LatentImage", inputs: { width: "{{w}}", height: "{{h}}" } },
  "7": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: "{{steps}}", positive: ["4", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } },
};

const BASE_VARIABLES: WorkflowVariable[] = [
  { name: "positive", type: "string", binds: "prompt" },
  { name: "negative", type: "string", binds: "negativePrompt" },
  { name: "w", type: "number", binds: "width" },
  { name: "h", type: "number", binds: "height" },
  { name: "seed", type: "number", binds: "seed" },
  { name: "steps", type: "number", binds: "free", defaultValue: 8 },
];

function workflow(over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf",
    providerId: "p",
    role: "text_to_image",
    name: "t2i",
    graph: GRAPH,
    variables: BASE_VARIABLES,
    outputNodeId: "9",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Workflow;
}

function backend(options: {
  workflows?: Partial<Record<"text_to_image" | "text_to_image_ref", Workflow>>;
  defaultParams?: Record<string, unknown>;
} = {}) {
  const submitted: Record<string, unknown>[] = [];
  const client = {
    generate: vi.fn(async (graph: Record<string, unknown>) => {
      submitted.push(graph);
      return { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } };
    }),
    fetchOutput: vi.fn(async () => Buffer.from("png-bytes")),
    uploadImage: vi.fn(async (_b: Buffer, name: string) => `viceroy/${name}`),
    hasInput: vi.fn(async (name: string) => name !== "gone.png"),
  } as unknown as ComfyClient;

  const available = options.workflows ?? { text_to_image: workflow() };

  return {
    submitted,
    client,
    image: comfyImageBackend({
      client,
      provider: { name: "comfy (runpod)", defaultParams: options.defaultParams ?? {} },
      workflowFor: (role) => {
        const found = available[role];
        if (!found) throw new Error(`Provider "comfy (runpod)" has no "${role}" workflow`);
        return found;
      },
    }),
  };
}

const request = {
  prompt: "a lighthouse",
  negativePrompt: "blurry",
  width: 432,
  height: 768,
  references: [] as string[],
};

describe("comfyImageBackend.generate", () => {
  it("binds the stage's request onto the workflow's own variable names", async () => {
    const { image, submitted } = backend();
    const bytes = await image.generate(request);

    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["4"]!.inputs.text).toBe("a lighthouse");
    expect(graph["5"]!.inputs.text).toBe("blurry");
    expect(graph["6"]!.inputs.width).toBe(432);
    expect(graph["6"]!.inputs.height).toBe(768);
    expect(bytes.toString()).toBe("png-bytes");
  });

  it("keeps node wiring intact", async () => {
    const { image, submitted } = backend();
    await image.generate(request);
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["7"]!.inputs.positive).toEqual(["4", 0]);
  });

  // ComfyUI caches node outputs, so an identical graph returns the previous
  // file without sampling again — a redo would hand back the very image it was
  // asked to replace.
  it("varies the seed between generations when none is given", async () => {
    const { image, submitted } = backend();
    await image.generate(request);
    await image.generate(request);

    const seedOf = (i: number) =>
      (submitted[i] as Record<string, { inputs: Record<string, unknown> }>)["7"]!.inputs.seed;
    expect(seedOf(0)).not.toBe(seedOf(1));
  });

  it("honours an explicit seed", async () => {
    const { image, submitted } = backend();
    await image.generate({ ...request, seed: 99 });
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["7"]!.inputs.seed).toBe(99);
  });

  it("fills a free variable from the provider's default params, over its own default", async () => {
    const { image, submitted } = backend({ defaultParams: { steps: 30 } });
    await image.generate(request);
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["7"]!.inputs.steps).toBe(30);
  });

  it("falls back to the variable's own default when the provider says nothing", async () => {
    const { image, submitted } = backend();
    await image.generate(request);
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["7"]!.inputs.steps).toBe(8);
  });
});

describe("comfyImageBackend references", () => {
  const refGraph = {
    ...GRAPH,
    "10": { class_type: "LoadImage", inputs: { image: "{{ref1}}" } },
    "11": { class_type: "LoadImage", inputs: { image: "{{ref2}}" } },
  };
  const refWorkflow = workflow({
    role: "text_to_image_ref",
    graph: refGraph,
    variables: [
      ...BASE_VARIABLES,
      { name: "ref1", type: "image", binds: "refImages" },
      { name: "ref2", type: "image", binds: "refImages" },
    ],
  });

  it("uses the ref workflow and fills slots in order", async () => {
    const { image, submitted } = backend({
      workflows: { text_to_image: workflow(), text_to_image_ref: refWorkflow },
    });
    await image.generate({ ...request, references: ["viceroy/a.png", "viceroy/b.png"] });

    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["10"]!.inputs.image).toBe("viceroy/a.png");
    expect(graph["11"]!.inputs.image).toBe("viceroy/b.png");
  });

  it("uses the plain workflow when the scene has nobody in it", async () => {
    const { image, submitted } = backend({
      workflows: { text_to_image: workflow(), text_to_image_ref: refWorkflow },
    });
    await image.generate(request);
    expect(submitted[0]).not.toHaveProperty("10");
  });

  it("reports the ref workflow's slot count as its capacity", () => {
    const { image } = backend({
      workflows: { text_to_image: workflow(), text_to_image_ref: refWorkflow },
    });
    expect(image.referenceCapacity()).toBe(2);
  });

  it("reports zero capacity when there is no ref workflow", () => {
    expect(backend().image.referenceCapacity()).toBe(0);
  });

  // Degrading to a reference-free generation would give every scene a
  // different face — the thing ADR 0001 exists to prevent — and it would look
  // finished. A missing workflow is a configuration gap, so it must be loud.
  it("fails naming the missing role rather than generating without references", async () => {
    const { image, client } = backend();
    await expect(image.generate({ ...request, references: ["viceroy/a.png"] })).rejects.toThrow(
      /text_to_image_ref/,
    );
    expect(client.generate).not.toHaveBeenCalled();
  });

  // A graph's reference slots are structural — both LoadImage nodes are wired
  // into the conditioning chain — while a scene's cast is not. Most scenes
  // have one character, so leaving the spare slot unresolved would fail the
  // common case rather than the rare one.
  it("repeats the last portrait into a spare slot, and warns", async () => {
    const logged: string[] = [];
    const { image, submitted } = backend({
      workflows: { text_to_image: workflow(), text_to_image_ref: refWorkflow },
    });
    await image.generate(
      { ...request, references: ["viceroy/a.png"] },
      { log: (message) => logged.push(message) },
    );

    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["10"]!.inputs.image).toBe("viceroy/a.png");
    expect(graph["11"]!.inputs.image).toBe("viceroy/a.png");
    expect(logged.join(" ")).toMatch(/repeating the last reference/);
  });

  it("drops characters beyond the slot count rather than failing the scene", async () => {
    const logged: string[] = [];
    const { image, submitted } = backend({
      workflows: { text_to_image: workflow(), text_to_image_ref: refWorkflow },
    });
    await image.generate(
      { ...request, references: ["a.png", "b.png", "c.png"] },
      { log: (message) => logged.push(message) },
    );

    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect([graph["10"]!.inputs.image, graph["11"]!.inputs.image]).toEqual(["a.png", "b.png"]);
    expect(logged.join(" ")).toMatch(/3 character reference\(s\).*2 slot\(s\)/);
  });
});

describe("comfyImageBackend progress", () => {
  it("reports sampling fractions and announces model loading once", async () => {
    const fractions: number[] = [];
    const logs: string[] = [];
    const client = {
      generate: vi.fn(async (_graph: unknown, options: { onProgress?: (p: unknown) => void }) => {
        options.onProgress?.({ phase: "loading" });
        options.onProgress?.({ phase: "loading", node: "7" });
        options.onProgress?.({ phase: "sampling", fraction: 0.5, node: "7" });
        return { "9": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } };
      }),
      fetchOutput: vi.fn(async () => Buffer.from("x")),
    } as unknown as ComfyClient;

    const image = comfyImageBackend({
      client,
      provider: { name: "comfy", defaultParams: {} },
      workflowFor: () => workflow(),
    });

    await image.generate(request, {
      onProgress: (f) => fractions.push(f),
      log: (message) => logs.push(message),
    });

    expect(fractions).toEqual([0, 0, 0.5]);
    expect(logs.filter((l) => l.includes("loading models"))).toHaveLength(1);
  });
});
