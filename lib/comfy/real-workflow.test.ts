import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { WorkflowVariable } from "../db/schema";
import { bindVariables, referenceSlots } from "../backends/comfy-bind";
import { validateGraph } from "../workflows";
import { applyTemplate, collectVariables } from "./template";
import { selectOutput } from "./client";

/**
 * A real Flux 2 Klein workflow, exported from ComfyUI by the user.
 *
 * Worth its own test file because it is unlike anything written here by hand:
 * its node ids come from an expanded subgraph and contain colons (`75:65`),
 * it carries `_meta` blocks the API ignores, and its prompt and dimensions are
 * fed by `Primitive*` nodes rather than being literals on the sampler. All
 * three are exactly the kind of thing that "works on my hand-made graph" and
 * then does not.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/flux2-klein-t2i.workflow.json", import.meta.url), "utf8"),
) as {
  outputNodeId: string;
  variables: WorkflowVariable[];
  graph: Record<string, { inputs: Record<string, unknown> }>;
};

const request = {
  prompt: "a weathered fisherman mending a net on a harbour wall",
  negativePrompt: "text, watermark, deformed hands",
  width: 432,
  height: 768,
  seed: 4242,
};

function render() {
  const values = bindVariables(FIXTURE.variables, request);
  return applyTemplate(FIXTURE.graph, values) as Record<string, { inputs: Record<string, unknown> }>;
}

describe("the exported Flux 2 Klein workflow", () => {
  it("is recognised as an API-format export despite its _meta blocks", () => {
    expect(validateGraph(FIXTURE.graph)).toBeNull();
  });

  it("declares a value for every hole in the graph", () => {
    const declared = new Set(FIXTURE.variables.map((v) => v.name));
    expect(collectVariables(FIXTURE.graph).filter((name) => !declared.has(name))).toEqual([]);
  });

  // Both EmptyFlux2LatentImage and Flux2Scheduler read the same two Primitive
  // nodes, so one binding each covers the whole graph — unlike the reference
  // workflow, where the size had to be unpicked from GetImageSize.
  it("sizes the latent and the scheduler from the same two bindings", () => {
    const graph = render();
    expect(graph["75:66"]!.inputs.width).toEqual(["75:68", 0]);
    expect(graph["75:62"]!.inputs.width).toEqual(["75:68", 0]);
    expect(graph["75:68"]!.inputs.value).toBe(432);
    expect(graph["75:69"]!.inputs.value).toBe(768);
  });

  it("routes the prompt to the Primitive node the encoder reads from", () => {
    const graph = render();
    // 76 (PrimitiveStringMultiline) feeds 75:74's `text` input by wire, so the
    // prompt has to land on the primitive's value — writing it onto the
    // encoder would be overwritten by the link.
    expect(graph["76"]!.inputs.value).toBe(request.prompt);
    expect(graph["75:74"]!.inputs.text).toEqual(["76", 0]);
  });

  it("fills dimensions, negative prompt and seed", () => {
    const graph = render();
    expect(graph["75:68"]!.inputs.value).toBe(432);
    expect(graph["75:69"]!.inputs.value).toBe(768);
    expect(graph["75:67"]!.inputs.text).toBe(request.negativePrompt);
    expect(graph["75:73"]!.inputs.noise_seed).toBe(4242);
  });

  it("keeps numbers as numbers rather than stringifying them", () => {
    const graph = render();
    for (const [node, key] of [
      ["75:68", "value"],
      ["75:69", "value"],
      ["75:73", "noise_seed"],
      ["75:62", "steps"],
      ["75:63", "cfg"],
    ] as const) {
      expect(typeof graph[node]!.inputs[key]).toBe("number");
    }
  });

  // The step-distilled Klein settings: four steps at cfg 1.
  it("applies the declared defaults for free variables", () => {
    const graph = render();
    expect(graph["75:62"]!.inputs.steps).toBe(4);
    expect(graph["75:63"]!.inputs.cfg).toBe(1);
  });

  it("lets the provider override a free variable", () => {
    const values = bindVariables(FIXTURE.variables, request, { steps: 8 });
    const graph = applyTemplate(FIXTURE.graph, values) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(graph["75:62"]!.inputs.steps).toBe(8);
  });

  // Colons in node ids are the part most likely to break a naive
  // implementation, since they look like a path separator.
  it("preserves colon-bearing node ids and their wiring", () => {
    const graph = render();
    expect(graph["75:64"]!.inputs.sigmas).toEqual(["75:62", 0]);
    expect(graph["9"]!.inputs.images).toEqual(["75:65", 0]);
    expect(Object.keys(graph).filter((id) => id.includes(":")).length).toBeGreaterThan(10);
  });

  it("leaves the loaders alone — the checkpoint is the user's choice", () => {
    const graph = render();
    expect(graph["75:70"]!.inputs.unet_name).toBe("flux-2-klein-4b-fp8.safetensors");
    expect(graph["75:72"]!.inputs.vae_name).toBe("flux2-vae.safetensors");
  });

  it("names node 9 as the output, and that node is the SaveImage", () => {
    expect(FIXTURE.outputNodeId).toBe("9");
    const outputs = { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } };
    expect(selectOutput(outputs, FIXTURE.outputNodeId).filename).toBe("a.png");
  });

  // No LoadImage nodes: this is the text-only half. Character consistency
  // needs a second workflow with reference slots (ADR 0001).
  it("exposes no reference slots, so it cannot serve text_to_image_ref", () => {
    expect(referenceSlots(FIXTURE.variables)).toBe(0);
  });
});
