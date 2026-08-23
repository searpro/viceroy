/**
 * Dialogue, and how long it takes to say (M7.2).
 *
 * LTX generates audio natively: the exact words go into the video prompt in
 * quotation marks and the model speaks them. That makes a shot's length a
 * *constraint* rather than a free choice — a four-second clip carrying twelve
 * words of dialogue either rushes the line or drops the end of it, and both
 * failures are only discoverable after the GPU time is spent.
 *
 * So the arithmetic lives here, pure and dependency-free, and the target's
 * `validate()` reports the mismatch on the review screen before anything is
 * generated.
 */

/**
 * One spoken line, carried from the Fountain screenplay's own cue/dialogue
 * pair.
 *
 * `characterId` is nullable because a screenplay can cue a voice that never
 * became a `characters` row (`V.O.`, a crowd, a radio). Such a line still has
 * to be spoken, so it is kept with whatever name the screenplay used rather
 * than dropped for failing to resolve.
 *
 * `delivery` is the accent/tone descriptor LTX's own documented form wants —
 * `[Speaker] says, in a [delivery], "[line]"`. It is copied from the
 * character's locked `voiceDesignNotes` at seed time rather than referenced
 * live, so a segment's prompt cannot silently change when casting is redone.
 */
export type DialogueLine = {
  characterId: string | null;
  characterName: string;
  /** Fountain's own parenthetical, e.g. "(quietly)". Empty when there is none. */
  parenthetical: string;
  line: string;
  delivery: string;
};

/**
 * Words per minute for generated speech.
 *
 * 150 wpm is the ordinary rate for delivered dialogue — slower than
 * conversation, which is where the temptation to use 180 comes from, because
 * performed lines carry pauses conversation does not. It is an *estimate*,
 * not a measurement: nothing in this repo has yet timed LTX speaking a known
 * line. Treat a validation warning derived from it as advisory until a real
 * run replaces this constant, and record that run as a finding.
 */
export const SPEECH_WORDS_PER_MINUTE = 150;

/** Breath between two consecutive lines, and the beat before the first one. */
const LINE_GAP_MS = 350;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** How long these lines take to speak, including the pauses between them. */
export function estimateSpeechMs(lines: DialogueLine[]): number {
  if (lines.length === 0) return 0;
  const words = lines.reduce((sum, entry) => sum + wordCount(entry.line), 0);
  const spoken = (words / SPEECH_WORDS_PER_MINUTE) * 60_000;
  // One gap before the first line and one between each pair: a character does
  // not begin speaking on the segment's first frame.
  return Math.round(spoken + LINE_GAP_MS * lines.length);
}

/**
 * The shortest segment these lines fit in, rounded up to a tenth of a second.
 *
 * Used as a floor when seeding durations, so a shot that carries speech is
 * never shorter than the speech — which the LLM's own duration estimate has
 * no way to know, since it never sees the dialogue.
 */
export function minimumDurationMs(lines: DialogueLine[]): number {
  const speech = estimateSpeechMs(lines);
  return speech === 0 ? 0 : Math.ceil(speech / 100) * 100;
}

/**
 * How many distinct speakers these lines carry.
 *
 * LTX's guidance is one speaker per line for clean lip-sync; two characters
 * talking inside one generated clip is where sync degrades, so a target can
 * warn on it.
 */
export function speakerCount(lines: DialogueLine[]): number {
  return new Set(lines.map((entry) => entry.characterName.trim().toLowerCase())).size;
}

/**
 * One line, in LTX's documented form.
 *
 * `Henry says, in a weathered baritone, "Unnatural... these patterns..."` —
 * speaker, then delivery when there is one, then the exact authored words in
 * quotation marks. The words are ours, which is the whole reason captions can
 * still be authored text rather than a transcription (findings F1/F5).
 *
 * Fountain's parenthetical is folded into the delivery clause rather than
 * dropped: "(quietly)" is performance direction, and LTX takes performance
 * direction as prose.
 */
export function renderDialogueLine(entry: DialogueLine): string {
  const speaker = entry.characterName.trim() || "A voice";
  // Nested double quotes would close the spoken line early and leave the rest
  // of it reading as narration.
  const quoted = `"${entry.line.trim().replace(/"/g, "'")}"`;

  // Two distinct clauses, not one comma-chain: the parenthetical is *how this
  // line* is delivered ("quietly") and the voice design is how this character
  // always sounds. Running them together produced "in a low, unhurried, faint
  // coastal lilt, quietly", which reads as one confused description.
  const clauses = [
    stripParens(entry.parenthetical),
    entry.delivery.trim() ? `in a ${entry.delivery.trim()}` : "",
  ].filter(Boolean);

  return [`${speaker} says`, ...clauses, quoted].join(", ");
}

function stripParens(text: string): string {
  return text.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
}
