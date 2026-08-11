import { matchTokens } from "./numbers";

/**
 * Aligning ASR timings onto the authored narration.
 *
 * The POC this replaces took caption text straight from the transcript, which
 * is what the model *heard*: an authored "Right at three seventeen." came back
 * as "Right at317,". Timing was accurate, wording was not, and the wording is
 * what the viewer reads.
 *
 * So the transcript is used for **timing only**. Its words are aligned against
 * the authored words, and each authored word keeps its own spelling while
 * inheriting the matched transcript word's clock. Where nothing matches — a
 * dropped word, a misheard phrase — timings are interpolated between the
 * nearest anchors, which is exactly what a gap deserves: approximately right,
 * and never allowed to shift the words around it. See docs/findings.md F5.
 */

export type TimedWord = { word: string; startMs: number; endMs: number };

export type AuthoredWord = {
  /** Exactly as written, punctuation and all — this is what the viewer reads. */
  surface: string;
  /** Index into the authored word list. */
  index: number;
};

export type AlignedWord = AuthoredWord & {
  startMs: number;
  endMs: number;
  /** What ASR heard here, kept for debugging a suspicious caption. */
  heard: string | null;
};

/** Split narration into words, preserving each one's exact written form. */
export function splitWords(text: string): AuthoredWord[] {
  const matches = text.match(/\S+/g) ?? [];
  return matches.map((surface, index) => ({ surface, index }));
}

type Expanded = { key: string; source: number; startMs?: number; endMs?: number };

function expandAuthored(words: AuthoredWord[]): Expanded[] {
  const out: Expanded[] = [];
  for (const word of words) {
    for (const key of matchTokens(word.surface)) out.push({ key, source: word.index });
  }
  return out;
}

function expandHeard(words: TimedWord[]): Expanded[] {
  const out: Expanded[] = [];
  for (const [index, word] of words.entries()) {
    const keys = matchTokens(word.word);
    if (keys.length === 0) continue;
    // One transcript word may spell out to several ("1987"); split its span so
    // each piece can anchor a different authored word.
    const span = (word.endMs - word.startMs) / keys.length;
    for (const [offset, key] of keys.entries()) {
      out.push({
        key,
        source: index,
        startMs: word.startMs + span * offset,
        endMs: word.startMs + span * (offset + 1),
      });
    }
  }
  return out;
}

/** Cheap similarity for near-misses: "griffin" vs "griffen". */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  if (a.length < 4 || b.length < 4) return false;

  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const MATCH = 3;
const NEAR = 1;
const MISMATCH = -2;
const GAP = -2;

type Pair = { authored: number; heard: number };

/**
 * Global (Needleman–Wunsch) alignment over the expanded token streams.
 *
 * Global rather than local because the transcript covers the whole narration:
 * the ends must line up, and a local alignment would happily discard a poorly
 * transcribed opening rather than time it.
 */
export function alignTokens(authored: Expanded[], heard: Expanded[]): Pair[] {
  const n = authored.length;
  const m = heard.length;
  if (n === 0 || m === 0) return [];

  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  // 0 = diagonal, 1 = authored gap (up), 2 = heard gap (left)
  const back = new Uint8Array((n + 1) * width);

  for (let i = 1; i <= n; i++) {
    score[i * width] = i * GAP;
    back[i * width] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    back[j] = 2;
  }

  for (let i = 1; i <= n; i++) {
    const a = authored[i - 1]!.key;
    for (let j = 1; j <= m; j++) {
      const b = heard[j - 1]!.key;
      const step = a === b ? MATCH : similar(a, b) ? NEAR : MISMATCH;

      const diagonal = score[(i - 1) * width + (j - 1)]! + step;
      const up = score[(i - 1) * width + j]! + GAP;
      const left = score[i * width + (j - 1)]! + GAP;

      let best = diagonal;
      let move = 0;
      if (up > best) {
        best = up;
        move = 1;
      }
      if (left > best) {
        best = left;
        move = 2;
      }
      score[i * width + j] = best;
      back[i * width + j] = move;
    }
  }

  const pairs: Pair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = i === 0 ? 2 : j === 0 ? 1 : back[i * width + j]!;
    if (move === 0) {
      const a = authored[i - 1]!;
      const b = heard[j - 1]!;
      // Only a real or near match anchors a timing; a forced diagonal between
      // two unrelated words would plant a wrong anchor and drag its neighbours.
      if (a.key === b.key || similar(a.key, b.key)) {
        pairs.push({ authored: i - 1, heard: j - 1 });
      }
      i--;
      j--;
    } else if (move === 1) {
      i--;
    } else {
      j--;
    }
  }

  return pairs.reverse();
}

/**
 * Give every authored word a start and end, in milliseconds.
 *
 * `durationMs` bounds the tail so a final unmatched run cannot run past the
 * audio.
 */
export function alignWords(
  authoredText: string,
  heardWords: TimedWord[],
  durationMs: number,
): AlignedWord[] {
  const words = splitWords(authoredText);
  if (words.length === 0) return [];

  const authoredExpanded = expandAuthored(words);
  const heardExpanded = expandHeard(heardWords);
  const pairs = alignTokens(authoredExpanded, heardExpanded);

  const anchored = new Map<number, { startMs: number; endMs: number; heard: string }>();
  for (const pair of pairs) {
    const a = authoredExpanded[pair.authored]!;
    const h = heardExpanded[pair.heard]!;
    const existing = anchored.get(a.source);
    const startMs = Math.min(existing?.startMs ?? Infinity, h.startMs ?? 0);
    const endMs = Math.max(existing?.endMs ?? -Infinity, h.endMs ?? 0);
    const heard = heardWords[h.source]?.word ?? "";
    anchored.set(a.source, {
      startMs,
      endMs,
      heard: existing ? `${existing.heard} ${heard}`.trim() : heard,
    });
  }

  const aligned: AlignedWord[] = words.map((word) => {
    const anchor = anchored.get(word.index);
    return {
      ...word,
      startMs: anchor?.startMs ?? Number.NaN,
      endMs: anchor?.endMs ?? Number.NaN,
      heard: anchor?.heard ?? null,
    };
  });

  fillGaps(aligned, durationMs);
  return aligned;
}

/**
 * Spread timings across words nothing matched.
 *
 * A run of unmatched words is given equal shares of the interval between the
 * anchors either side of it. Leading and trailing runs borrow the start of the
 * first anchor and the end of the audio respectively.
 */
function fillGaps(words: AlignedWord[], durationMs: number): void {
  const anchors = words.map((w, i) => (Number.isNaN(w.startMs) ? -1 : i)).filter((i) => i >= 0);

  if (anchors.length === 0) {
    // Nothing matched at all — the transcript is unusable, so fall back to
    // spreading the narration evenly rather than emitting NaN.
    const each = durationMs / words.length;
    words.forEach((word, index) => {
      word.startMs = Math.round(each * index);
      word.endMs = Math.round(each * (index + 1));
    });
    return;
  }

  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;

  for (let i = 0; i < first; i++) {
    const share = words[first]!.startMs / first;
    words[i]!.startMs = Math.round(share * i);
    words[i]!.endMs = Math.round(share * (i + 1));
  }

  for (let k = 0; k < anchors.length - 1; k++) {
    const from = anchors[k]!;
    const to = anchors[k + 1]!;
    const gap = to - from - 1;
    if (gap <= 0) continue;

    const startMs = words[from]!.endMs;
    const endMs = words[to]!.startMs;
    const share = (endMs - startMs) / (gap + 1);
    for (let g = 1; g <= gap; g++) {
      words[from + g]!.startMs = Math.round(startMs + share * (g - 1));
      words[from + g]!.endMs = Math.round(startMs + share * g);
    }
  }

  const tail = words.length - 1 - last;
  if (tail > 0) {
    const startMs = words[last]!.endMs;
    const share = Math.max(durationMs - startMs, tail * 120) / tail;
    for (let g = 1; g <= tail; g++) {
      words[last + g]!.startMs = Math.round(startMs + share * (g - 1));
      words[last + g]!.endMs = Math.round(startMs + share * g);
    }
  }

  // ASR spans can overlap slightly; captions must not travel backwards.
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1]!;
    const current = words[i]!;
    if (current.startMs < previous.endMs) current.startMs = previous.endMs;
    if (current.endMs < current.startMs) current.endMs = current.startMs;
  }
}

export type Cue = {
  text: string;
  startMs: number;
  endMs: number;
  heardText: string | null;
  firstWord: number;
  lastWord: number;
};

/**
 * Group aligned words into caption-sized cues.
 *
 * Cues never span a scene boundary — a caption has to belong to the image
 * behind it — so grouping runs within each scene's word range.
 */
export function buildCues(
  words: AlignedWord[],
  range: { from: number; to: number },
  options: { maxWords?: number; maxMs?: number } = {},
): Cue[] {
  const maxWords = options.maxWords ?? 5;
  const maxMs = options.maxMs ?? 2600;

  const cues: Cue[] = [];
  let current: AlignedWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const heard = current.map((w) => w.heard).filter(Boolean).join(" ");
    cues.push({
      text: current.map((w) => w.surface).join(" "),
      startMs: first.startMs,
      endMs: last.endMs,
      heardText: heard || null,
      firstWord: first.index,
      lastWord: last.index,
    });
    current = [];
  };

  for (let i = range.from; i <= range.to && i < words.length; i++) {
    const word = words[i]!;
    const wouldRunLong = current.length > 0 && word.endMs - current[0]!.startMs > maxMs;
    if (current.length >= maxWords || wouldRunLong) flush();
    current.push(word);
    // Break on sentence-final punctuation: a caption that ends where the
    // sentence ends reads far better than one chopped at a word count.
    if (/[.!?]["'”’)]?$/.test(word.surface)) flush();
  }
  flush();

  return cues;
}
