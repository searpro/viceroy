import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WORKFLOW_ROLES, type WorkflowRole } from "../db/schema";
import { bindVariables, fillReferenceSlots, referenceSlots } from "../backends/comfy-bind";
import { applyTemplate, collectVariables } from "./template";
import { BINDINGS, bindingsForRole, duplicateBindings, missingRequired } from "./bindings";

describe("bindingsForRole", () => {
  it("offers a reference slot only where one exists", () => {
    const has = (role: WorkflowRole) =>
      bindingsForRole(role).some((binding) => binding.key === "refImages");
    expect(has("text_to_image")).toBe(false);
    expect(has("text_to_image_ref")).toBe(true);
    expect(has("image_to_video")).toBe(true);
    expect(has("speech_to_video")).toBe(true);
  });

  it("offers audio only for speech to video", () => {
    for (const role of WORKFLOW_ROLES) {
      const has = bindingsForRole(role).some((binding) => binding.key === "audio");
      expect(has).toBe(role === "speech_to_video");
    }
  });

  it("offers prompt and free everywhere", () => {
    for (const role of WORKFLOW_ROLES) {
      const keys = bindingsForRole(role).map((binding) => binding.key);
      expect(keys).toContain("prompt");
      expect(keys).toContain("free");
    }
  });
});

describe("missingRequired", () => {
  // The two mistakes that produce a plausible picture rather than an error.
  it("flags a reference workflow with no reference slot", () => {
    const missing = missingRequired("text_to_image_ref", [{ binds: "prompt" }]);
    expect(missing.map((binding) => binding.key)).toEqual(["refImages"]);
  });

  it("flags a workflow with no prompt", () => {
    const missing = missingRequired("text_to_image", [{ binds: "free" }]);
    expect(missing.map((binding) => binding.key)).toEqual(["prompt"]);
  });

  it("does not demand a reference from plain text to image", () => {
    expect(missingRequired("text_to_image", [{ binds: "prompt" }])).toEqual([]);
  });

  it("demands narration for speech to video", () => {
    const missing = missingRequired("speech_to_video", [
      { binds: "prompt" },
      { binds: "refImages" },
    ]);
    expect(missing.map((binding) => binding.key)).toEqual(["audio"]);
  });
});

describe("duplicateBindings", () => {
  it("allows several reference slots, which is how two faces stay two faces", () => {
    expect(duplicateBindings([{ binds: "refImages" }, { binds: "refImages" }])).toEqual([]);
  });

  it("allows many free knobs", () => {
    expect(duplicateBindings([{ binds: "free" }, { binds: "free" }])).toEqual([]);
  });

  it("flags two variables competing for one value", () => {
    expect(duplicateBindings([{ binds: "prompt" }, { binds: "prompt" }])).toEqual(["prompt"]);
  });
});

/**
 * The hints are documentation, and documentation drifts. These tie each claim
 * to the code that would have to change for it to become false.
 */
describe("the vocabulary matches what the binder actually fills", () => {
  it("names every binding the schema allows, and no others", () => {
    const declared = BINDINGS.map((binding) => binding.key).sort();
    const real = (
      JSON.parse(
        readFileSync(new URL("./fixtures/flux2-klein-t2i.workflow.json", import.meta.url), "utf8"),
      ) as { variables: { binds: string }[] }
    ).variables.map((variable) => variable.binds);

    // Every binding used by the real stored workflow is one the hints describe.
    for (const binds of real) expect(declared).toContain(binds);

    expect(declared).toEqual([
      "audio",
      "free",
      "height",
      "negativePrompt",
      "prompt",
      "refImages",
      "seed",
      "width",
    ]);
  });

  it("fills every documented binding when the pipeline supplies it", () => {
    const variables = BINDINGS.map((binding) => ({
      name: binding.key,
      type: "string" as const,
      binds: binding.key,
      ...(binding.key === "free" ? { defaultValue: 20 } : {}),
    }));

    const values = bindVariables(variables, {
      prompt: "a keeper",
      negativePrompt: "text",
      width: 432,
      height: 768,
      seed: 7,
      references: ["viceroy/a.png"],
      audio: "viceroy/n.wav",
    });

    // No documented binding may come back undefined — that would mean the hint
    // promises a value the binder does not actually supply, and the workflow
    // would fail on an unresolved variable at generation time.
    for (const binding of BINDINGS) {
      expect(values[binding.key]).toBeDefined();
    }
    expect(values.prompt).toBe("a keeper");
    expect(values.refImages).toBe("viceroy/a.png");
    expect(values.audio).toBe("viceroy/n.wav");
    expect(values.free).toBe(20);
  });

  it("gives each repeatable slot the next reference, in order", () => {
    const values = bindVariables(
      [
        { name: "first", type: "image", binds: "refImages" },
        { name: "second", type: "image", binds: "refImages" },
      ],
      { references: ["viceroy/a.png", "viceroy/b.png"] },
    );
    expect(values).toEqual({ first: "viceroy/a.png", second: "viceroy/b.png" });
  });
});

describe("the user's two-reference Flux 2 Klein workflow", () => {
  const REF_WORKFLOW = JSON.parse(
    readFileSync(new URL("./fixtures/flux2-klein-t2i-ref.workflow.json", import.meta.url), "utf8"),
  ) as {
    outputNodeId: string;
    variables: { name: string; type: string; binds: string; defaultValue?: unknown }[];
    graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  };

  const variables = REF_WORKFLOW.variables as Parameters<typeof bindVariables>[0];

  function render(references: string[]) {
    const slots = referenceSlots(variables);
    const { filled, notes } = fillReferenceSlots(slots, references);
    const values = bindVariables(variables, {
      prompt: "two people on a harbour wall",
      width: 432,
      height: 768,
      seed: 99,
      references: filled,
    });
    return {
      notes,
      graph: applyTemplate(REF_WORKFLOW.graph, values) as typeof REF_WORKFLOW.graph,
    };
  }

  it("exposes exactly two reference slots", () => {
    expect(referenceSlots(variables)).toBe(2);
  });

  it("declares a value for every hole, so nothing is left unresolved", () => {
    const declared = new Set(variables.map((v) => v.name));
    expect(collectVariables(REF_WORKFLOW.graph).filter((n) => !declared.has(n))).toEqual([]);
  });

  it("puts one portrait in each LoadImage for a two-character scene", () => {
    const { graph, notes } = render(["viceroy/a.png", "viceroy/b.png"]);
    expect(graph["76"]!.inputs.image).toBe("viceroy/a.png");
    expect(graph["81"]!.inputs.image).toBe("viceroy/b.png");
    expect(notes).toEqual([]);
  });

  // Most scenes have one character, and both LoadImage nodes are wired into
  // the conditioning chain, so the spare slot has to be filled with something.
  it("repeats the portrait for a one-character scene, and says so", () => {
    const { graph, notes } = render(["viceroy/a.png"]);
    expect(graph["76"]!.inputs.image).toBe("viceroy/a.png");
    expect(graph["81"]!.inputs.image).toBe("viceroy/a.png");
    expect(notes[0]).toMatch(/repeating the last reference/);
  });

  it("drops the third character rather than failing the scene, and says so", () => {
    const { notes } = render(["a.png", "b.png", "c.png"]);
    expect(notes[0]).toMatch(/3 character reference\(s\).*2 slot\(s\)/);
  });

  // The exported graph sized every frame from reference image 1 via
  // GetImageSize, which cannot match the 9:16 the renderer needs.
  it("takes its output size from config rather than from the reference", () => {
    const { graph } = render(["a.png"]);
    expect(graph["92:113"]!.inputs.width).toBe(432);
    expect(graph["92:113"]!.inputs.height).toBe(768);
    expect(graph["92:102"]!.inputs.width).toBe(432);
    expect(graph["92:102"]!.inputs.height).toBe(768);
    expect(graph["92:114"]).toBeUndefined();
  });

  it("keeps the reference conditioning chain wired to both portraits", () => {
    const { graph } = render(["a.png", "b.png"]);
    // Positive: prompt -> ReferenceLatent(ref1) -> ReferenceLatent(ref2).
    expect(graph["92:112:117"]!.inputs.latent).toEqual(["92:112:116", 0]);
    expect(graph["92:84:120"]!.inputs.latent).toEqual(["92:84:119", 0]);
    expect(graph["92:103"]!.inputs.positive).toEqual(["92:84:120", 0]);
    // Both VAEEncodes still read their own scaled portrait.
    expect(graph["92:112:116"]!.inputs.pixels).toEqual(["92:111", 0]);
    expect(graph["92:84:119"]!.inputs.pixels).toEqual(["92:85", 0]);
  });

  it("keeps the distilled sampler settings as numbers", () => {
    const { graph } = render(["a.png"]);
    expect(graph["92:102"]!.inputs.steps).toBe(4);
    expect(graph["92:103"]!.inputs.cfg).toBe(1);
    expect(graph["92:106"]!.inputs.noise_seed).toBe(99);
  });

  // cfg=1 with a zeroed-out negative means a negative prompt has no effect
  // here, so the workflow correctly binds no variable to it.
  it("binds nothing to the negative prompt, which this graph cannot use", () => {
    expect(variables.some((v) => v.binds === "negativePrompt")).toBe(false);
    expect(REF_WORKFLOW.graph["92:86"]!.class_type).toBe("ConditioningZeroOut");
  });

  it("names the SaveImage node as its output", () => {
    expect(REF_WORKFLOW.outputNodeId).toBe("94");
    expect(REF_WORKFLOW.graph["94"]!.class_type).toBe("SaveImage");
  });
});
