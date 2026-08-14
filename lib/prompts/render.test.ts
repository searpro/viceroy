import { describe, it, expect } from "vitest";
import { missingVariables, renderTemplate, templateVariables } from "./render";
import { DEFAULT_PROMPT_TEMPLATES } from "./defaults";

describe("renderTemplate", () => {
  it("substitutes every occurrence of a placeholder", () => {
    expect(renderTemplate("{{a}} and {{a}} and {{b}}", { a: "x", b: "y" })).toBe("x and x and y");
  });

  // A silently dropped placeholder produces a prompt that reads fine and means
  // something else; a visible one shows up in the output.
  it("leaves an unsupplied placeholder in place rather than dropping it", () => {
    expect(renderTemplate("keep {{missing}}", {})).toBe("keep {{missing}}");
  });

  it("substitutes an empty string when that is what was passed", () => {
    expect(renderTemplate("a{{b}}c", { b: "" })).toBe("ac");
  });

  it("ignores single braces and malformed markers", () => {
    expect(renderTemplate("{a} {{ b }} {{c-d}}", { a: "x", b: "y" })).toBe("{a} {{ b }} {{c-d}}");
  });
});

describe("templateVariables", () => {
  it("lists each placeholder once, in first-seen order", () => {
    expect(templateVariables("{{b}} {{a}} {{b}}")).toEqual(["b", "a"]);
  });
});

describe("missingVariables", () => {
  it("names only what the caller failed to supply", () => {
    expect(missingVariables("{{a}} {{b}}", { a: "1" })).toEqual(["b"]);
  });

  it("is empty when everything is supplied", () => {
    expect(missingVariables("{{a}}", { a: "1", unused: "2" })).toEqual([]);
  });
});

describe("DEFAULT_PROMPT_TEMPLATES", () => {
  it("declares every placeholder its template actually uses", () => {
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      const declared = new Set(template.variables.map((v) => v.name));
      const used = templateVariables(template.template);
      const undeclared = used.filter((name) => !declared.has(name));
      expect(undeclared, `${template.key} uses undeclared ${undeclared.join(", ")}`).toEqual([]);
    }
  });

  it("has unique keys", () => {
    const keys = DEFAULT_PROMPT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// VIC-003: the templates every story-content stage renders inject a
// `{{groundingInstruction}}` variable that is empty in Idea mode and a
// faithfulness clause in Context mode.
describe("groundingInstruction rendering", () => {
  const GROUNDED_KEYS = [
    "synopsis.generate",
    "synopsis.refine",
    "story.write",
    "story.refine",
    "story.revise",
    "elements.characters",
    "elements.scene",
  ];

  function templateFor(key: string): string {
    return DEFAULT_PROMPT_TEMPLATES.find((t) => t.key === key)!.template;
  }

  it("declares groundingInstruction on every story-content template", () => {
    for (const key of GROUNDED_KEYS) {
      const template = DEFAULT_PROMPT_TEMPLATES.find((t) => t.key === key)!;
      expect(templateVariables(template.template)).toContain("groundingInstruction");
    }
  });

  it("renders to an empty placeholder — no visible clause — when unset (Idea mode)", () => {
    for (const key of GROUNDED_KEYS) {
      const rendered = renderTemplate(templateFor(key), {
        groundingInstruction: "",
        // Filler for every other placeholder so a missing-var check is not
        // what's under test here.
        ...Object.fromEntries(templateVariables(templateFor(key)).map((name) => [name, ""])),
      });
      expect(rendered).not.toContain("do not introduce");
    }
  });

  it("renders the faithfulness clause verbatim when set (Context mode)", () => {
    const clause = "stay inside the supplied context; do not introduce anything else";
    for (const key of GROUNDED_KEYS) {
      const rendered = renderTemplate(templateFor(key), {
        ...Object.fromEntries(templateVariables(templateFor(key)).map((name) => [name, ""])),
        groundingInstruction: clause,
      });
      expect(rendered).toContain(clause);
    }
  });

  it("declares contextBlock on story.evaluate for the factual_grounding excerpt", () => {
    const template = DEFAULT_PROMPT_TEMPLATES.find((t) => t.key === "story.evaluate")!;
    expect(templateVariables(template.template)).toContain("contextBlock");
  });
});
