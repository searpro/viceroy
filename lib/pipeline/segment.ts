/**
 * Splitting the narration into scenes.
 *
 * Scenes carry *verbatim spans* of the written story rather than per-scene
 * text the model wrote separately. Two reasons, both load-bearing:
 *
 *  1. The voiceover is generated in one shot from the whole narration. If
 *     scene scripts were independently written, concatenating them would not
 *     reproduce the story that was reviewed and approved.
 *  2. Asking a model to "copy this part out" invites paraphrase. Asking it for
 *     sentence *indices* cannot paraphrase anything, and the output is a
 *     handful of tokens — which matters under the 4096-token ceiling (F10).
 */

/**
 * Abbreviations whose trailing period does not end a sentence.
 *
 * "no." (number) is deliberately absent: narration ends a sentence on the word
 * "no" far more often than it abbreviates "number", and treating the common
 * case as the rare one welds two sentences together.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt",
  "inc", "ltd", "co", "corp", "vs", "etc", "eg", "ie", "approx",
]);

/**
 * Split narration into sentences.
 *
 * Deliberately conservative: the narration is spoken text written by the story
 * stage, which is instructed to write numbers and times as words, so the
 * classic "3.17" and "$1.5M" hazards are largely absent by construction. What
 * remains is abbreviations and quoted dialogue punctuation.
 */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (!normalised) return [];

  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < normalised.length; i++) {
    const char = normalised[i]!;
    if (char !== "." && char !== "!" && char !== "?") continue;

    // Run past any closing quotes/brackets that belong to this sentence.
    let end = i + 1;
    while (end < normalised.length && /["'”’)\]]/.test(normalised[end]!)) end++;

    const next = normalised[end];
    if (next !== undefined && next !== " ") continue;

    const candidate = normalised.slice(start, end).trim();
    // Take the word from before the punctuation itself, not from the end of
    // the candidate — `end` has already run past any closing quotes, so
    // trimming one character off the candidate can strip a quote instead.
    const lastWord = normalised
      .slice(start, i)
      .split(/[\s("'“‘]/)
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z]/g, "");

    // "Mr. Alvarez" is one sentence, and so is a lone initial like "J. R."
    if (char === "." && lastWord && (ABBREVIATIONS.has(lastWord) || lastWord.length === 1)) {
      continue;
    }

    if (candidate) sentences.push(candidate);
    start = end;
    i = end - 1;
  }

  const tail = normalised.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

export type SceneSpan = { startSentence: number; endSentence: number; description: string };

/**
 * Coerce the model's grouping into spans that tile the narration exactly.
 *
 * Every sentence must land in exactly one scene: a gap silently drops
 * narration from the video, and an overlap makes the same words appear under
 * two images. Rather than fail the stage on a model that is off by one — which
 * it frequently is — the spans are repaired into a covering partition, and the
 * descriptions are carried along.
 *
 * Failing only happens when there is nothing usable to repair.
 */
export function normaliseSpans(raw: unknown, sentenceCount: number): SceneSpan[] {
  if (sentenceCount === 0) throw new Error("Cannot build scenes from empty narration");

  const candidates = Array.isArray(raw) ? raw : [];
  const parsed = candidates
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      const start = Number(record.startSentence ?? record.start);
      const end = Number(record.endSentence ?? record.end);
      const description = typeof record.description === "string" ? record.description.trim() : "";
      return { start, end, description };
    })
    .filter((s) => Number.isFinite(s.start))
    .map((s) => ({
      ...s,
      end: Number.isFinite(s.end) ? s.end : s.start,
    }))
    .sort((a, b) => a.start - b.start);

  if (parsed.length === 0) {
    throw new Error("Scene grouping named no usable sentence ranges");
  }

  const spans: SceneSpan[] = [];
  let cursor = 0;

  for (const [index, item] of parsed.entries()) {
    // Each scene begins where the last one ended, whatever the model claimed,
    // so gaps and overlaps both collapse into a clean tiling.
    const startSentence = cursor;
    if (startSentence >= sentenceCount) break;

    const isLast = index === parsed.length - 1;
    const proposedEnd = Math.max(startSentence, Math.min(Math.trunc(item.end), sentenceCount - 1));
    const endSentence = isLast ? sentenceCount - 1 : proposedEnd;

    spans.push({
      startSentence,
      endSentence,
      description: item.description || `Scene ${spans.length + 1}`,
    });
    cursor = endSentence + 1;
    if (cursor >= sentenceCount) break;
  }

  // Anything the model left off the end still has to be narrated.
  if (cursor < sentenceCount && spans.length > 0) {
    spans[spans.length - 1]!.endSentence = sentenceCount - 1;
  }

  return spans;
}

export function spanText(sentences: string[], span: SceneSpan): string {
  return sentences.slice(span.startSentence, span.endSentence + 1).join(" ");
}

/** Sentences numbered for the grouping prompt. */
export function numberSentences(sentences: string[]): string {
  return sentences.map((sentence, index) => `[${index}] ${sentence}`).join("\n");
}
