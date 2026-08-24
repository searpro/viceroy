import { afterEach, describe, expect, it } from "vitest";
import { attributeTemplates, beginPromptScope, endPromptScope, recordPromptRender } from "./trace";

afterEach(() => endPromptScope());

describe("prompt render attribution", () => {
  it("records nothing when no scope is open", () => {
    recordPromptRender({ key: "dev.concept", vars: {}, text: "a rendered concept prompt" });
    expect(attributeTemplates("a rendered concept prompt")).toEqual([]);
  });

  it("attributes a prompt used verbatim", () => {
    beginPromptScope();
    recordPromptRender({ key: "dev.concept", vars: { idea: "a lighthouse" }, text: "Write a concept for: a lighthouse" });

    expect(attributeTemplates("Write a concept for: a lighthouse")).toEqual([
      { key: "dev.concept", vars: { idea: "a lighthouse" } },
    ]);
  });

  // The case that makes containment rather than equality the rule: every image
  // prompt in the codebase is style prefix + template + optional direction +
  // style suffix, and equality would attribute none of them.
  it("attributes a template wrapped in an image style's prefix and suffix", () => {
    beginPromptScope();
    recordPromptRender({
      key: "character.portrait",
      vars: { characterDescription: "a weathered keeper" },
      text: "portrait of a weathered keeper, neutral background",
    });

    const composed = "cinematic still, portrait of a weathered keeper, neutral background, 35mm film";
    expect(attributeTemplates(composed)).toEqual([
      { key: "character.portrait", vars: { characterDescription: "a weathered keeper" } },
    ]);
  });

  it("ignores renders that appear in no part of the prompt", () => {
    beginPromptScope();
    recordPromptRender({ key: "dev.logline", vars: {}, text: "an entirely different rendered prompt" });
    expect(attributeTemplates("cinematic still, portrait of a keeper")).toEqual([]);
  });

  it("orders multiple contributing templates by where they appear", () => {
    beginPromptScope();
    recordPromptRender({ key: "second.key", vars: {}, text: "the second contribution here" });
    recordPromptRender({ key: "first.key", vars: {}, text: "the first contribution here" });

    expect(
      attributeTemplates("the first contribution here / the second contribution here").map((t) => t.key),
    ).toEqual(["first.key", "second.key"]);
  });

  /**
   * A per-scene stage renders one key once per scene. The render that produced
   * *this* prompt is the last matching one, not the first — attributing scene
   * 7's prompt to scene 1's variables would be a confidently wrong answer.
   */
  it("attributes the most recent render of a key that matched", () => {
    beginPromptScope();
    recordPromptRender({ key: "elements.scene", vars: { sceneNumber: "1" }, text: "describe the scene in detail" });
    recordPromptRender({ key: "elements.scene", vars: { sceneNumber: "7" }, text: "describe the scene in detail" });

    expect(attributeTemplates("describe the scene in detail")).toEqual([
      { key: "elements.scene", vars: { sceneNumber: "7" } },
    ]);
  });

  it("does not attribute renders too short to be distinctive", () => {
    beginPromptScope();
    recordPromptRender({ key: "tiny", vars: {}, text: "a cat" });
    expect(attributeTemplates("a cat sits on a wall")).toEqual([]);
  });

  it("forgets a previous job's renders when a new scope opens", () => {
    beginPromptScope();
    recordPromptRender({ key: "dev.concept", vars: {}, text: "the previous job's rendered prompt" });
    beginPromptScope();

    expect(attributeTemplates("the previous job's rendered prompt")).toEqual([]);
  });
});
