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
