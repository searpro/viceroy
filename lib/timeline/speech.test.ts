import { describe, expect, it } from "vitest";
import {
  estimateSpeechMs,
  minimumDurationMs,
  renderDialogueLine,
  speakerCount,
  SPEECH_WORDS_PER_MINUTE,
  wordCount,
  type DialogueLine,
} from "./speech";

function line(overrides: Partial<DialogueLine> = {}): DialogueLine {
  return {
    characterId: "c1",
    characterName: "Reyna",
    parenthetical: "",
    line: "It was under the stairs.",
    delivery: "low, unhurried, faint coastal lilt",
    ...overrides,
  };
}

describe("wordCount", () => {
  it("counts words, not characters, and ignores surrounding space", () => {
    expect(wordCount("  It was under the stairs.  ")).toBe(5);
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("estimateSpeechMs", () => {
  it("is zero for a segment with no speech", () => {
    expect(estimateSpeechMs([])).toBe(0);
  });

  it("scales with word count at the documented rate", () => {
    const words = "one two three four five six seven eight nine ten";
    const ms = estimateSpeechMs([line({ line: words })]);
    const spoken = (10 / SPEECH_WORDS_PER_MINUTE) * 60_000;
    // Plus one gap; a character does not start speaking on frame one.
    expect(ms).toBeGreaterThan(spoken);
    expect(ms).toBeLessThan(spoken + 1000);
  });

  it("charges a pause per line, so two short lines cost more than one long one", () => {
    const together = estimateSpeechMs([line({ line: "one two three four" })]);
    const apart = estimateSpeechMs([line({ line: "one two" }), line({ line: "three four" })]);
    expect(apart).toBeGreaterThan(together);
  });
});

describe("minimumDurationMs", () => {
  it("is zero when there is nothing to say", () => {
    expect(minimumDurationMs([])).toBe(0);
  });

  it("rounds up, never down — a floor that rounds down is not a floor", () => {
    const lines = [line({ line: "a somewhat longer line of dialogue here" })];
    expect(minimumDurationMs(lines)).toBeGreaterThanOrEqual(estimateSpeechMs(lines));
    expect(minimumDurationMs(lines) % 100).toBe(0);
  });
});

describe("speakerCount", () => {
  it("counts distinct speakers, case-insensitively", () => {
    expect(speakerCount([])).toBe(0);
    expect(speakerCount([line(), line({ line: "Another." })])).toBe(1);
    expect(speakerCount([line(), line({ characterName: "HENRY" }), line({ characterName: "henry" })])).toBe(2);
  });
});

describe("renderDialogueLine", () => {
  it("uses LTX's documented form: speaker, delivery, then the words in quotes", () => {
    expect(renderDialogueLine(line())).toBe(
      'Reyna says, in a low, unhurried, faint coastal lilt, "It was under the stairs."',
    );
  });

  it("keeps the parenthetical and the voice design as separate clauses", () => {
    // Run together they read as one confused description of the voice; the
    // parenthetical is how *this line* is said, the delivery is how the
    // character always sounds.
    expect(renderDialogueLine(line({ parenthetical: "(quietly)" }))).toBe(
      'Reyna says, quietly, in a low, unhurried, faint coastal lilt, "It was under the stairs."',
    );
  });

  it("drops the delivery clause entirely when no voice is locked", () => {
    expect(renderDialogueLine(line({ delivery: "" }))).toBe('Reyna says, "It was under the stairs."');
  });

  it("reproduces the authored words verbatim — this is why captions stay authored text", () => {
    const authored = "Unnatural... these patterns, they don't drift.";
    expect(renderDialogueLine(line({ line: authored }))).toContain(`"${authored}"`);
  });

  it("neutralises a quote inside the line so it cannot close the spoken text early", () => {
    const rendered = renderDialogueLine(line({ line: 'He called it "weather".' }));
    // Exactly two double quotes: the ones this function added.
    expect(rendered.split('"')).toHaveLength(3);
  });

  it("names an unresolved voice rather than dropping the line", () => {
    // A radio, a crowd, a V.O. cue that never became a `characters` row still
    // has to be spoken.
    expect(renderDialogueLine(line({ characterId: null, characterName: "RADIO", delivery: "" }))).toBe(
      'RADIO says, "It was under the stairs."',
    );
    expect(renderDialogueLine(line({ characterName: "", delivery: "" }))).toContain("A voice says");
  });
});
