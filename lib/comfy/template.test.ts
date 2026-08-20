import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { applyTemplate, collectVariables, UnresolvedVariableError } from "./template";

/** The graph measured working against the live pod, with holes punched in it. */
const REAL_GRAPH = JSON.parse(
  readFileSync(new URL("./fixtures/flux2-t2i.graph.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("collectVariables", () => {
  it("finds every distinct variable, in first-seen order", () => {
    const graph = {
      "4": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}, {{style}}" } },
      "6": { class_type: "EmptyFlux2LatentImage", inputs: { width: "{{width}}", height: "{{width}}" } },
    };
    expect(collectVariables(graph)).toEqual(["prompt", "style", "width"]);
  });

  it("returns nothing for a graph with no holes", () => {
    expect(collectVariables(REAL_GRAPH)).toEqual([]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(collectVariables({ a: "{{  seed  }}" })).toEqual(["seed"]);
  });
});

describe("applyTemplate", () => {
  it("gives a whole-string variable the value's own type", () => {
    const out = applyTemplate({ inputs: { seed: "{{seed}}", steps: "{{steps}}" } }, {
      seed: 42,
      steps: 8,
    });
    expect(out).toEqual({ inputs: { seed: 42, steps: 8 } });
  });

  it("stringifies a variable embedded in surrounding text", () => {
    const out = applyTemplate({ text: "a portrait of {{subject}}, {{count}} of them" }, {
      subject: "a keeper",
      count: 2,
    });
    expect(out).toEqual({ text: "a portrait of a keeper, 2 of them" });
  });

  // Node wiring is `["4", 0]` — an array of a string and a number. A
  // substitution that stringified or rewrote those would silently unwire the
  // graph, and ComfyUI would report a confusing type error somewhere else.
  it("leaves node wiring untouched", () => {
    const graph = {
      "7": { class_type: "KSampler", inputs: { positive: ["4", 0], latent_image: ["6", 0] } },
    };
    expect(applyTemplate(graph, {})).toEqual(graph);
  });

  it("does not mutate the graph it was given", () => {
    const graph = { "4": { inputs: { text: "{{prompt}}" } } };
    const before = JSON.stringify(graph);
    applyTemplate(graph, { prompt: "a city" });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("substitutes into a real exported graph", () => {
    type Node = { inputs: Record<string, unknown> };
    const holed = JSON.parse(JSON.stringify(REAL_GRAPH)) as Record<string, Node>;
    holed["4"]!.inputs.text = "{{prompt}}";
    holed["6"]!.inputs.width = "{{width}}";

    const out = applyTemplate(holed, { prompt: "a lighthouse", width: 432 }) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expect(out["4"]!.inputs.text).toBe("a lighthouse");
    expect(out["6"]!.inputs.width).toBe(432);
    // Everything it did not touch survives, including the wiring.
    expect(out["7"]!.inputs.positive).toEqual(["4", 0]);
    expect(out["1"]!.inputs.unet_name).toBe("flux-2-klein-base-4b-fp8.safetensors");
  });

  // An unresolved {{prompt}} would be sent to the sampler as literal text, and
  // FLUX.2 renders text well enough to stencil it into the frame (F14) — so
  // the failure would arrive as a plausible image rather than an error.
  it("throws rather than leaving an unresolved variable in the graph", () => {
    expect(() => applyTemplate({ text: "{{prompt}}" }, {})).toThrow(UnresolvedVariableError);
    expect(() => applyTemplate({ text: "{{prompt}}" }, {})).toThrow(/\{\{prompt\}\}/);
  });

  it("reports every missing variable at once, not just the first", () => {
    try {
      applyTemplate({ a: "{{one}}", b: "{{two}}" }, {});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as UnresolvedVariableError).names.sort()).toEqual(["one", "two"]);
    }
  });

  it("treats an explicit undefined as missing", () => {
    expect(() => applyTemplate({ a: "{{one}}" }, { one: undefined })).toThrow(
      UnresolvedVariableError,
    );
  });

  it("allows a deliberately empty string", () => {
    expect(applyTemplate({ a: "{{neg}}" }, { neg: "" })).toEqual({ a: "" });
  });
});
