/**
 * Spelling numbers out, for matching only.
 *
 * ASR normalises spoken numbers *back* to digits — parakeet hears "nineteen
 * eighty-seven" and writes "1987" — while the narration may contain either
 * form, because `story.write` asks for spoken words and models only partly
 * comply. So the authored text and the transcript routinely disagree on the
 * surface form of the same spoken sound.
 *
 * Both sides are therefore pushed through the same expansion before matching:
 * whichever form each started in, they meet as words. Nothing here ever
 * reaches the viewer — captions always display the authored surface form.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const SCALES: [number, string][] = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

/** Cardinal reading: 1987 → "one thousand nine hundred eighty seven". */
export function cardinalWords(value: number): string[] {
  if (!Number.isFinite(value) || value < 0) return [];
  const whole = Math.trunc(value);

  if (whole < 20) return [ONES[whole]!];
  if (whole < 100) {
    const tens = TENS[Math.floor(whole / 10)]!;
    const rest = whole % 10;
    return rest === 0 ? [tens] : [tens, ONES[rest]!];
  }
  if (whole < 1000) {
    const rest = whole % 100;
    return [ONES[Math.floor(whole / 100)]!, "hundred", ...(rest ? cardinalWords(rest) : [])];
  }

  for (const [scale, name] of SCALES) {
    if (whole >= scale) {
      const rest = whole % scale;
      return [...cardinalWords(Math.floor(whole / scale)), name, ...(rest ? cardinalWords(rest) : [])];
    }
  }
  return [String(whole)];
}

/** Year reading: 1987 → "nineteen eighty seven". */
export function yearWords(value: number): string[] {
  const high = Math.floor(value / 100);
  const low = value % 100;
  if (low === 0) return [...cardinalWords(high), "hundred"];
  if (low < 10) return [...cardinalWords(high), "oh", ...cardinalWords(low)];
  return [...cardinalWords(high), ...cardinalWords(low)];
}

/**
 * How a numeric token is most likely to have been *spoken*.
 *
 * Four digits in 1100–2099 are read as a year far more often than as a
 * quantity in this material — "nineteen eighty-seven", not "one thousand nine
 * hundred and eighty-seven". The guess is occasionally wrong, and being wrong
 * is cheap: a mismatched number becomes a short gap the aligner interpolates
 * across, anchored by the words either side of it.
 */
export function spokenForm(token: string): string[] {
  const cleaned = token.replace(/[,_]/g, "");
  const currency = /^[$£€]/.test(cleaned);
  const percent = cleaned.endsWith("%");
  const digits = cleaned.replace(/[^0-9.]/g, "");
  if (!digits) return [];

  const value = Number(digits);
  if (!Number.isFinite(value)) return [];

  const isYearLike =
    !currency && !percent && /^\d{4}$/.test(digits) && value >= 1100 && value <= 2099;

  const words = isYearLike ? yearWords(value) : cardinalWords(value);
  if (currency) words.push("dollars");
  if (percent) words.push("percent");
  return words;
}

/**
 * Normalise one token into the words it should be matched by.
 *
 * Returns several tokens where a number spells out to several words, and an
 * empty array for pure punctuation, which carries no sound to align to.
 */
export function matchTokens(surface: string): string[] {
  const trimmed = surface.trim();
  if (!trimmed) return [];

  if (/\d/.test(trimmed)) {
    const spoken = spokenForm(trimmed);
    if (spoken.length > 0) return spoken;
  }

  const cleaned = trimmed
    .toLowerCase()
    // Curly quotes and hyphens differ between what a writer types and what ASR
    // emits, and neither difference is audible.
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return cleaned ? cleaned.split(/\s+/) : [];
}
