import { describe, it, expect } from "vitest";
import { normaliseSpans, numberSentences, spanText, splitSentences } from "./segment";

describe("splitSentences", () => {
  it("splits on sentence-ending punctuation", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(splitSentences("One.\n\n  Two.")).toEqual(["One.", "Two."]);
  });

  it("keeps a trailing fragment with no final punctuation", () => {
    expect(splitSentences("One. And then")).toEqual(["One.", "And then"]);
  });

  it("does not split inside an abbreviation", () => {
    expect(splitSentences("Mr. Alvarez signed it. Then he left.")).toEqual([
      "Mr. Alvarez signed it.",
      "Then he left.",
    ]);
  });

  it("does not split on a single initial", () => {
    expect(splitSentences("J. R. Vance called. Nobody answered.")).toEqual([
      "J. R. Vance called.",
      "Nobody answered.",
    ]);
  });

  it("keeps a closing quote with the sentence it belongs to", () => {
    expect(splitSentences('He said "no." She left.')).toEqual(['He said "no."', "She left."]);
  });

  it("treats an ellipsis as one break rather than three", () => {
    expect(splitSentences("He waited... Nothing came.")).toEqual([
      "He waited...",
      "Nothing came.",
    ]);
  });

  it("returns nothing for empty or blank input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("normaliseSpans", () => {
  const sentences = ["a.", "b.", "c.", "d.", "e."];
  const coversEverything = (spans: ReturnType<typeof normaliseSpans>, count: number) => {
    expect(spans[0]!.startSentence).toBe(0);
    expect(spans.at(-1)!.endSentence).toBe(count - 1);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startSentence).toBe(spans[i - 1]!.endSentence + 1);
    }
  };

  it("passes a clean partition through unchanged", () => {
    const spans = normaliseSpans(
      [
        { startSentence: 0, endSentence: 1, description: "first" },
        { startSentence: 2, endSentence: 4, description: "second" },
      ],
      5,
    );
    expect(spans).toEqual([
      { startSentence: 0, endSentence: 1, description: "first" },
      { startSentence: 2, endSentence: 4, description: "second" },
    ]);
  });

  // A gap silently drops narration out of the finished video.
  it("closes a gap the model left between scenes", () => {
    const spans = normaliseSpans(
      [
        { startSentence: 0, endSentence: 1, description: "first" },
        { startSentence: 3, endSentence: 4, description: "second" },
      ],
      5,
    );
    coversEverything(spans, 5);
    expect(spans[1]!.startSentence).toBe(2);
  });

  // An overlap makes the same words play under two different images.
  it("resolves an overlap", () => {
    const spans = normaliseSpans(
      [
        { startSentence: 0, endSentence: 3, description: "first" },
        { startSentence: 2, endSentence: 4, description: "second" },
      ],
      5,
    );
    coversEverything(spans, 5);
  });

  it("extends the final scene to the end of the narration", () => {
    const spans = normaliseSpans([{ startSentence: 0, endSentence: 2, description: "only" }], 5);
    expect(spans.at(-1)!.endSentence).toBe(4);
  });

  it("drops scenes that start past the end of the narration", () => {
    const spans = normaliseSpans(
      [
        { startSentence: 0, endSentence: 4, description: "first" },
        { startSentence: 9, endSentence: 12, description: "hallucinated" },
      ],
      5,
    );
    expect(spans).toHaveLength(1);
    coversEverything(spans, 5);
  });

  it("clamps an end index past the last sentence", () => {
    const spans = normaliseSpans([{ startSentence: 0, endSentence: 99, description: "x" }], 5);
    expect(spans.at(-1)!.endSentence).toBe(4);
  });

  it("sorts scenes the model returned out of order", () => {
    const spans = normaliseSpans(
      [
        { startSentence: 3, endSentence: 4, description: "second" },
        { startSentence: 0, endSentence: 2, description: "first" },
      ],
      5,
    );
    expect(spans[0]!.description).toBe("first");
    coversEverything(spans, 5);
  });

  it("accepts start/end as aliases for startSentence/endSentence", () => {
    const spans = normaliseSpans([{ start: 0, end: 4, description: "x" }], 5);
    expect(spans).toHaveLength(1);
  });

  it("substitutes a placeholder description rather than leaving it blank", () => {
    expect(normaliseSpans([{ startSentence: 0, endSentence: 4 }], 5)[0]!.description).toBe(
      "Scene 1",
    );
  });

  it("fails when the model named no usable range at all", () => {
    expect(() => normaliseSpans([{ description: "no indices" }], 5)).toThrow(/no usable/);
    expect(() => normaliseSpans("nonsense", 5)).toThrow(/no usable/);
  });

  it("fails on empty narration", () => {
    expect(() => normaliseSpans([{ startSentence: 0, endSentence: 0 }], 0)).toThrow(/empty/);
  });

  // The property that matters most: every sentence lands in exactly one scene.
  it("always produces a covering partition, whatever the model returns", () => {
    const messy = [
      [{ startSentence: 2, endSentence: 1 }, { startSentence: 0, endSentence: 0 }],
      [{ startSentence: 0, endSentence: 0 }, { startSentence: 0, endSentence: 0 }],
      [{ startSentence: 1, endSentence: 3 }],
      [{ startSentence: 0, endSentence: 1 }, { startSentence: 1, endSentence: 2 }, { startSentence: 4, endSentence: 4 }],
    ];
    for (const raw of messy) {
      coversEverything(normaliseSpans(raw, sentences.length), sentences.length);
    }
  });
});

describe("spanText", () => {
  it("joins the sentences a span covers, verbatim", () => {
    const sentences = ["One.", "Two.", "Three."];
    expect(spanText(sentences, { startSentence: 0, endSentence: 1, description: "" })).toBe(
      "One. Two.",
    );
  });

  // The whole reason scenes carry spans rather than rewritten text: the
  // concatenation has to reproduce the approved narration exactly.
  it("reproduces the narration exactly when every span is concatenated", () => {
    const story = "One thing happened. Then another. Finally a third. And it ended.";
    const sentences = splitSentences(story);
    const spans = normaliseSpans(
      [
        { startSentence: 0, endSentence: 0 },
        { startSentence: 1, endSentence: 2 },
        { startSentence: 3, endSentence: 3 },
      ],
      sentences.length,
    );
    expect(spans.map((span) => spanText(sentences, span)).join(" ")).toBe(story);
  });
});

describe("numberSentences", () => {
  it("numbers from zero, one per line", () => {
    expect(numberSentences(["a.", "b."])).toBe("[0] a.\n[1] b.");
  });
});
