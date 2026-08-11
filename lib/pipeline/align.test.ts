import { describe, it, expect } from "vitest";
import { alignWords, buildCues, splitWords, type TimedWord } from "./align";
import { cardinalWords, matchTokens, spokenForm, yearWords } from "./numbers";

/** Evenly-timed transcript, 500ms a word, as a stand-in for parakeet output. */
function transcript(words: string[], msPerWord = 500): TimedWord[] {
  return words.map((word, index) => ({
    word,
    startMs: index * msPerWord,
    endMs: (index + 1) * msPerWord,
  }));
}

describe("number expansion", () => {
  it("reads small and compound cardinals", () => {
    expect(cardinalWords(7)).toEqual(["seven"]);
    expect(cardinalWords(19)).toEqual(["nineteen"]);
    expect(cardinalWords(42)).toEqual(["forty", "two"]);
    expect(cardinalWords(100)).toEqual(["one", "hundred"]);
    expect(cardinalWords(50_000)).toEqual(["fifty", "thousand"]);
    expect(cardinalWords(100_000_000)).toEqual(["one", "hundred", "million"]);
  });

  it("reads years the way a narrator says them", () => {
    expect(yearWords(1987)).toEqual(["nineteen", "eighty", "seven"]);
    expect(yearWords(1900)).toEqual(["nineteen", "hundred"]);
    expect(yearWords(2005)).toEqual(["twenty", "oh", "five"]);
  });

  it("treats a bare four-digit number in range as a year", () => {
    expect(spokenForm("1987")).toEqual(["nineteen", "eighty", "seven"]);
  });

  it("treats a currency amount as a quantity, not a year", () => {
    expect(spokenForm("$1987")).toEqual([
      "one", "thousand", "nine", "hundred", "eighty", "seven", "dollars",
    ]);
  });

  it("strips thousands separators and appends the unit", () => {
    expect(spokenForm("$50,000")).toEqual(["fifty", "thousand", "dollars"]);
    expect(spokenForm("12%")).toEqual(["twelve", "percent"]);
  });

  it("normalises case, apostrophes and punctuation for matching", () => {
    expect(matchTokens("Bobby's,")).toEqual(["bobbys"]);
    expect(matchTokens("“quoted”")).toEqual(["quoted"]);
    expect(matchTokens("—")).toEqual([]);
  });
});

describe("alignWords", () => {
  it("keeps the authored spelling and takes only the timing", () => {
    const authored = "The pipes burst on a Tuesday.";
    const heard = transcript(["the", "pipes", "burst", "on", "a", "tuesday"]);

    const aligned = alignWords(authored, heard, 3000);

    expect(aligned.map((w) => w.surface)).toEqual([
      "The", "pipes", "burst", "on", "a", "Tuesday.",
    ]);
    expect(aligned[0]!.startMs).toBe(0);
    expect(aligned[5]!.endMs).toBe(3000);
  });

  // The exact failure the POC shipped: ASR writes digits, the writer wrote
  // words, and the caption must show the writer's version.
  it("matches spoken numbers against transcribed digits", () => {
    const authored = "Right at three seventeen the call came.";
    const heard = transcript(["right", "at317,", "the", "call", "came"]);

    const aligned = alignWords(authored, heard, 2500);

    expect(aligned.map((w) => w.surface).join(" ")).toBe(authored);
    // "the" follows the number in both, so it must anchor rather than drift.
    const the = aligned.find((w) => w.surface === "the")!;
    expect(the.heard).toBe("the");
    expect(the.startMs).toBe(1000);
  });

  it("matches authored digits against a transcript that spelled them out", () => {
    const authored = "By 1992 he had taken it all.";
    const heard = transcript(["by", "nineteen", "ninety", "two", "he", "had", "taken", "it", "all"]);

    const aligned = alignWords(authored, heard, 4500);

    expect(aligned[1]!.surface).toBe("1992");
    // Spans the three spoken words it was heard as.
    expect(aligned[1]!.startMs).toBe(500);
    expect(aligned[1]!.endMs).toBe(2000);
    expect(aligned[2]!.surface).toBe("he");
    expect(aligned[2]!.startMs).toBe(2000);
  });

  it("interpolates across words the transcript dropped", () => {
    const authored = "He counted every single note carefully.";
    const heard = transcript(["he", "counted", "carefully"]);

    const aligned = alignWords(authored, heard, 1500);

    expect(aligned.every((w) => Number.isFinite(w.startMs))).toBe(true);
    const dropped = aligned.slice(2, 5);
    expect(dropped.every((w) => w.heard === null)).toBe(true);
    // Still inside the interval between "counted" and "carefully".
    expect(dropped[0]!.startMs).toBeGreaterThanOrEqual(aligned[1]!.endMs);
    expect(dropped[2]!.endMs).toBeLessThanOrEqual(aligned[5]!.startMs);
  });

  it("tolerates a misheard word without losing the words around it", () => {
    const authored = "Harold Griffin signed the ledger.";
    const heard = transcript(["harold", "griffen", "signed", "the", "ledger"]);

    const aligned = alignWords(authored, heard, 2500);

    expect(aligned[1]!.surface).toBe("Griffin");
    expect(aligned[1]!.heard).toBe("griffen");
    expect(aligned[2]!.startMs).toBe(1000);
  });

  it("absorbs a word the transcript invented", () => {
    const authored = "He left town.";
    const heard = transcript(["he", "uh", "left", "town"]);

    const aligned = alignWords(authored, heard, 2000);

    expect(aligned.map((w) => w.surface)).toEqual(["He", "left", "town."]);
    expect(aligned[1]!.startMs).toBe(1000);
  });

  it("never lets a caption travel backwards", () => {
    const authored = "One two three four five.";
    const heard: TimedWord[] = [
      { word: "one", startMs: 0, endMs: 900 },
      { word: "two", startMs: 400, endMs: 1200 },
      { word: "three", startMs: 1100, endMs: 1500 },
      { word: "four", startMs: 1400, endMs: 2000 },
      { word: "five", startMs: 1900, endMs: 2400 },
    ];

    const aligned = alignWords(authored, heard, 2400);

    for (let i = 1; i < aligned.length; i++) {
      expect(aligned[i]!.startMs).toBeGreaterThanOrEqual(aligned[i - 1]!.endMs);
      expect(aligned[i]!.endMs).toBeGreaterThanOrEqual(aligned[i]!.startMs);
    }
  });

  // A transcript that matched nothing must not emit NaN into the renderer.
  it("falls back to even spacing when nothing matches at all", () => {
    const aligned = alignWords("Alpha beta gamma delta.", transcript(["zzz", "qqq"]), 4000);

    expect(aligned.every((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs))).toBe(true);
    expect(aligned[0]!.startMs).toBe(0);
    expect(aligned[3]!.endMs).toBe(4000);
  });

  it("returns nothing for empty narration", () => {
    expect(alignWords("", transcript(["a"]), 1000)).toEqual([]);
  });

  it("covers the whole narration, in order, with no NaN", () => {
    const authored =
      "In 1987 a quiet accountant began moving money. By 1992 he had taken $100,000,000. " +
      "Nobody noticed for five years.";
    const heard = transcript(
      ("in nineteen eighty seven a quiet accountant began moving money by nineteen ninety two " +
        "he had taken one hundred million dollars nobody noticed for five years").split(" "),
    );

    const aligned = alignWords(authored, heard, 30_000);

    expect(aligned.map((w) => w.surface).join(" ")).toBe(authored.replace(/\s+/g, " "));
    expect(aligned.every((w) => Number.isFinite(w.startMs))).toBe(true);
    expect(aligned[0]!.startMs).toBe(0);
  });
});

describe("buildCues", () => {
  const words = alignWords(
    "One two three four five six seven eight nine ten.",
    transcript("one two three four five six seven eight nine ten".split(" ")),
    5000,
  );

  it("groups words into caption-sized chunks", () => {
    const cues = buildCues(words, { from: 0, to: words.length - 1 }, { maxWords: 3, maxMs: 99_999 });
    expect(cues.map((c) => c.text)).toEqual([
      "One two three",
      "four five six",
      "seven eight nine",
      "ten.",
    ]);
  });

  it("takes each cue's clock from its own words", () => {
    const cues = buildCues(words, { from: 0, to: 5 }, { maxWords: 3, maxMs: 99_999 });
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[0]!.endMs).toBe(1500);
    expect(cues[1]!.startMs).toBe(1500);
  });

  it("breaks at a sentence end rather than mid-thought", () => {
    const sentence = alignWords(
      "He stopped. Then he ran on and on.",
      transcript("he stopped then he ran on and on".split(" ")),
      4000,
    );
    const cues = buildCues(sentence, { from: 0, to: sentence.length - 1 }, { maxWords: 6 });
    expect(cues[0]!.text).toBe("He stopped.");
  });

  it("splits a cue that would linger too long on screen", () => {
    const slow = alignWords(
      "one two three four",
      transcript(["one", "two", "three", "four"], 2000),
      8000,
    );
    const cues = buildCues(slow, { from: 0, to: 3 }, { maxWords: 10, maxMs: 3000 });
    expect(cues.length).toBeGreaterThan(1);
  });

  // Cues belong to the image behind them, so a scene's range is a hard edge.
  it("stays inside the requested word range", () => {
    const cues = buildCues(words, { from: 3, to: 5 }, { maxWords: 10 });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("four five six");
    expect(cues[0]!.firstWord).toBe(3);
    expect(cues[0]!.lastWord).toBe(5);
  });

  it("returns nothing for an empty range", () => {
    expect(buildCues(words, { from: 5, to: 4 })).toEqual([]);
  });
});

describe("splitWords", () => {
  it("preserves each written form and collapses whitespace", () => {
    expect(splitWords("  a\n b  ").map((w) => w.surface)).toEqual(["a", "b"]);
  });
});
