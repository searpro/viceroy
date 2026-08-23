import { describe, expect, it } from "vitest";
import { inlineText, looksLikeMarkdown, parseInline, parseMarkdown, type Block } from "./markdown";

/** The first block of a kind, for assertions that don't care about position. */
function first<T extends Block["type"]>(blocks: Block[], type: T) {
  return blocks.find((block) => block.type === type) as Extract<Block, { type: T }> | undefined;
}

describe("parseMarkdown", () => {
  it("reads ATX headings with their level", () => {
    const blocks = parseMarkdown("# One\n\n### Three");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 3 });
    expect(inlineText(first(blocks.slice(1), "heading")!.children)).toBe("Three");
  });

  it("drops a heading's closing hashes", () => {
    const heading = first(parseMarkdown("## Story bible ##"), "heading")!;
    expect(inlineText(heading.children)).toBe("Story bible");
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(inlineText(first(blocks, "paragraph")!.children)).toBe("one\ntwo");
  });

  it("keeps fenced code literal, including markup inside it", () => {
    const code = first(parseMarkdown("```json\n{ \"a\": 1 }\n# not a heading\n```"), "code")!;
    expect(code.lang).toBe("json");
    expect(code.value).toBe('{ "a": 1 }\n# not a heading');
  });

  it("reads an unclosed fence to the end of the document", () => {
    const code = first(parseMarkdown("```\nstill code"), "code")!;
    expect(code.value).toBe("still code");
  });

  it("reads bullet and ordered lists, keeping the ordered list's start", () => {
    const bullets = first(parseMarkdown("- a\n- b\n- c"), "list")!;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items).toHaveLength(3);

    const ordered = first(parseMarkdown("3. c\n4. d"), "list")!;
    expect(ordered.ordered).toBe(true);
    expect(ordered.start).toBe(3);
    expect(ordered.items).toHaveLength(2);
  });

  it("nests an indented list inside its parent item", () => {
    const list = first(parseMarkdown("- outer\n  - inner one\n  - inner two\n- second"), "list")!;
    expect(list.items).toHaveLength(2);
    const nested = first(list.items[0]!, "list");
    expect(nested?.items).toHaveLength(2);
  });

  it("does not swallow the paragraph after a list", () => {
    const blocks = parseMarkdown("- a\n- b\n\nAfter the list.");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  it("reads a blockquote as blocks, not as text", () => {
    const quote = first(parseMarkdown("> ## Note\n> body"), "blockquote")!;
    expect(quote.children.map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });

  it("reads a pipe table with its header row", () => {
    const table = first(parseMarkdown("| Scene | Shots |\n| --- | --- |\n| 1 | 4 |\n| 2 | 6 |"), "table")!;
    expect(table.header.map(inlineText)).toEqual(["Scene", "Shots"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]!.map(inlineText)).toEqual(["2", "6"]);
  });

  it("needs a divider row before it treats pipes as a table", () => {
    const blocks = parseMarkdown("| not | a table |\njust text");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("reads thematic breaks", () => {
    expect(parseMarkdown("---").map((b) => b.type)).toEqual(["hr"]);
    expect(parseMarkdown("***").map((b) => b.type)).toEqual(["hr"]);
  });

  it("terminates on every input, including markup-only lines", () => {
    // A regression guard for the parser's own loop, not a formatting claim:
    // every branch has to consume at least one line.
    for (const input of ["#", ">", "-", "|", "```", "1.", "   ", "- \n- "]) {
      expect(() => parseMarkdown(input)).not.toThrow();
    }
  });
});

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("**bold**")).toEqual([{ type: "strong", children: [{ type: "text", value: "bold" }] }]);
    expect(parseInline("*it*")).toEqual([{ type: "em", children: [{ type: "text", value: "it" }] }]);
    expect(parseInline("`x`")).toEqual([{ type: "code", value: "x" }]);
  });

  it("keeps surrounding text either side of a span", () => {
    expect(inlineText(parseInline("a **b** c"))).toBe("a b c");
    expect(parseInline("a **b** c")).toHaveLength(3);
  });

  it("does not read emphasis inside a code span", () => {
    expect(parseInline("`a * b * c`")).toEqual([{ type: "code", value: "a * b * c" }]);
  });

  it("leaves snake_case identifiers alone", () => {
    expect(parseInline("shot_list_items")).toEqual([{ type: "text", value: "shot_list_items" }]);
  });

  it("reads a link's text and href", () => {
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { type: "link", href: "https://example.com", children: [{ type: "text", value: "docs" }] },
    ]);
  });

  it("leaves unmatched markers as literal text", () => {
    expect(inlineText(parseInline("2 * 3 = 6"))).toBe("2 * 3 = 6");
  });
});

describe("looksLikeMarkdown", () => {
  it("recognises the structures the stages actually emit", () => {
    expect(looksLikeMarkdown("## Act one")).toBe(true);
    expect(looksLikeMarkdown("- a beat")).toBe(true);
    expect(looksLikeMarkdown("1. a beat")).toBe(true);
    expect(looksLikeMarkdown("A **named** thing")).toBe(true);
  });

  it("says no to screenplay text, which must stay preformatted", () => {
    const screenplay = "INT. LIGHTHOUSE - NIGHT\n\nMARA climbs the stair.\n\n          MARA\n     It's not the weather.";
    expect(looksLikeMarkdown(screenplay)).toBe(false);
  });
});
