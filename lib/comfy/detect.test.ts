import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkApiFormat,
  collectSites,
  guessBinds,
  guessOutputNode,
  guessType,
  type VariableSite,
} from "./detect";

const REAL_WORKFLOW = JSON.parse(
  readFileSync(new URL("./fixtures/flux2-klein-t2i.workflow.json", import.meta.url), "utf8"),
) as { graph: Record<string, unknown> };

const site = (partial: Partial<VariableSite>): VariableSite => ({
  name: "x",
  classType: "",
  title: "",
  inputKey: "",
  ...partial,
});

describe("checkApiFormat", () => {
  it("accepts a real exported graph", () => {
    expect(checkApiFormat(REAL_WORKFLOW.graph)).toBeNull();
  });

  it("names the editor save format specifically", () => {
    expect(checkApiFormat({ nodes: [{ id: 1 }], links: [] })).toMatch(/Export \(API\)/);
  });

  it.each([
    ["a non-object", "not json", /must be a JSON object/],
    ["an array", [], /must be a JSON object/],
    ["an empty graph", {}, /empty/],
    ["a node without class_type", { "1": { title: "x" } }, /class_type/],
    ["a node whose inputs is not an object", { "1": { class_type: "X", inputs: 7 } }, /inputs/],
  ])("rejects %s", (_label, graph, pattern) => {
    expect(checkApiFormat(graph)).toMatch(pattern);
  });
});

describe("guessBinds", () => {
  // The structural signals: what node the hole sits in beats what it is called.
  it("reads a LoadImage input as a reference slot whatever it is named", () => {
    expect(guessBinds(site({ name: "startFrame", classType: "LoadImage", inputKey: "image" }))).toBe(
      "refImages",
    );
  });

  it("reads a LoadAudio input as audio", () => {
    expect(guessBinds(site({ name: "narration", classType: "LoadAudio", inputKey: "audio" }))).toBe(
      "audio",
    );
  });

  it("separates the two text encoders by their titles", () => {
    const positive = site({
      name: "a",
      classType: "CLIPTextEncode",
      inputKey: "text",
      title: "CLIP Text Encode (Positive Prompt)",
    });
    const negative = site({
      name: "b",
      classType: "CLIPTextEncode",
      inputKey: "text",
      title: "CLIP Text Encode (Negative Prompt)",
    });
    expect(guessBinds(positive)).toBe("prompt");
    expect(guessBinds(negative)).toBe("negativePrompt");
  });

  it.each([
    ["w", "width", "width"],
    ["h", "height", "height"],
    ["noise_seed", "noise_seed", "seed"],
    ["myPrompt", "value", "prompt"],
  ])("maps %s to %s by input key", (name, inputKey, expected) => {
    expect(guessBinds(site({ name, inputKey }))).toBe(expected);
  });

  // A loose pattern here turned `num_frames` — a plain integer knob — into a
  // reference slot, which then failed as an unresolved variable at generation
  // time rather than at paste time.
  it.each(["num_frames", "frame_rate", "steps", "cfg", "batch_size"])(
    "leaves %s as a free knob",
    (name) => {
      expect(guessBinds(site({ name, inputKey: name }))).toBe("free");
    },
  );

  it("still recognises a reference threaded through some other node", () => {
    expect(guessBinds(site({ name: "ref_image", inputKey: "ref_image" }))).toBe("refImages");
    expect(guessBinds(site({ name: "portrait", inputKey: "portrait" }))).toBe("refImages");
  });
});

describe("guessType", () => {
  it.each([
    ["width", "number"],
    ["height", "number"],
    ["seed", "number"],
    ["refImages", "image"],
    ["audio", "image"],
    ["prompt", "string"],
    ["free", "string"],
  ] as const)("types %s as %s", (binds, expected) => {
    expect(guessType(binds)).toBe(expected);
  });
});

describe("collectSites", () => {
  it("carries the node's class_type and title alongside each variable", () => {
    const sites = collectSites({
      "3": { class_type: "LoadImage", _meta: { title: "Load Image" }, inputs: { image: "{{ref}}" } },
      "5": { class_type: "KSampler", inputs: { seed: "{{noise_seed}}" } },
    });
    expect(sites).toEqual([
      { name: "ref", classType: "LoadImage", title: "Load Image", inputKey: "image" },
      { name: "noise_seed", classType: "KSampler", title: "", inputKey: "seed" },
    ]);
  });

  it("reports each variable once, at its first site", () => {
    const sites = collectSites({
      "1": { class_type: "A", inputs: { x: "{{v}}" } },
      "2": { class_type: "B", inputs: { y: "{{v}}" } },
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]!.classType).toBe("A");
  });

  // The stored fixture is the templated form of the user's export, so its
  // holes are the ones the pipeline actually fills.
  it("finds every hole in the real templated workflow, with its node context", () => {
    const sites = collectSites(REAL_WORKFLOW.graph);
    expect(sites.map((s) => s.name).sort()).toEqual([
      "cfg",
      "height",
      "negativePrompt",
      "prompt",
      "seed",
      "steps",
      "width",
    ]);

    // The prompt sits on a Primitive node that feeds the encoder by wire, not
    // on the encoder itself — so the classifier has to read it from there.
    const prompt = sites.find((s) => s.name === "prompt")!;
    expect(prompt.classType).toBe("PrimitiveStringMultiline");
    expect(guessBinds(prompt)).toBe("prompt");

    const negative = sites.find((s) => s.name === "negativePrompt")!;
    expect(guessBinds(negative)).toBe("negativePrompt");
  });

  it("classifies every hole in the real workflow the way it is stored", () => {
    const stored = (REAL_WORKFLOW as unknown as { variables: { name: string; binds: string }[] })
      .variables;
    for (const site of collectSites(REAL_WORKFLOW.graph)) {
      const expected = stored.find((v) => v.name === site.name)!;
      expect({ name: site.name, binds: guessBinds(site) }).toEqual({
        name: site.name,
        binds: expected.binds,
      });
    }
  });
});

describe("guessOutputNode", () => {
  it("picks the single save node", () => {
    expect(
      guessOutputNode({ "8": { class_type: "VAEDecode" }, "9": { class_type: "SaveImage" } }),
    ).toBe("9");
  });

  // Choosing between two would be an invisible guess, and collecting the wrong
  // node's file is a silent wrong answer rather than an error.
  it("declines to choose between several", () => {
    expect(
      guessOutputNode({ "9": { class_type: "SaveImage" }, "10": { class_type: "SaveVideo" } }),
    ).toBeNull();
  });

  it("returns null when there is none", () => {
    expect(guessOutputNode({ "1": { class_type: "KSampler" } })).toBeNull();
  });
});
