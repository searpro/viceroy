/**
 * Pulling the spoken lines out of a Fountain screenplay, scene by scene (M7.2).
 *
 * This is the reason PR4 chose Fountain over free prose in the first place:
 * "its structure is exactly what stages 9 and 11-12 need to parse reliably."
 * Dialogue is the third thing to cash that cheque, and the most literal —
 * character cues and dialogue are distinct token types, so no heuristic is
 * needed to tell a spoken line from a line of action.
 *
 * Pure and dependency-light on purpose: no `Db`, no `StageContext`. The stage
 * that uses it (`runShotList`) is an LLM call away from being untestable, and
 * the parsing half should not be.
 */

import { Fountain, type Token } from "fountain-js";
import type { DialogueLine } from "./timeline/speech";

/**
 * A cue's extensions — `(V.O.)`, `(O.S.)`, `(CONT'D)` — stripped from the
 * name but remembered where they change how the line is delivered.
 *
 * `(V.O.)` and `(O.S.)` matter to a model generating audio: a voice-over is
 * not in the room, and prompting it as if it were produces the wrong acoustic.
 * `(CONT'D)` is bookkeeping and carries nothing.
 */
const OFF_CAMERA = /\((V\.?O\.?|O\.?S\.?|OFF)\)/i;
const CUE_EXTENSION = /\s*\([^)]*\)\s*$/;

export type SceneDialogue = {
  /** 1-based position in the screenplay, as a string — see below. */
  sceneId: string;
  heading: string;
  lines: DialogueLine[];
};

/**
 * Every scene's dialogue, in screenplay order.
 *
 * `sceneId` is the scene's 1-based position rendered as a string, because
 * that is the vocabulary the rest of the chain already uses:
 * `storyboardPanels.sceneId` and `shotListItems.sceneId` are free text holding
 * whatever scene number the breakdown's own extraction produced ("1", "2"),
 * not a foreign key. Matching on position is therefore the only join available
 * — and it is why `sceneDialogueFor` below returns nothing rather than
 * guessing when a panel names a scene the screenplay does not have.
 */
export function extractSceneDialogue(screenplay: string): SceneDialogue[] {
  const script = new Fountain().parse(screenplay, true);
  const tokens: Token[] = script.tokens ?? [];

  const scenes: SceneDialogue[] = [];
  let current: SceneDialogue | undefined;
  let speaker = "";
  let offCamera = false;
  let parenthetical = "";

  for (const token of tokens) {
    switch (token.type) {
      case "scene_heading":
        current = {
          sceneId: String(scenes.length + 1),
          heading: (token.text ?? "").trim(),
          lines: [],
        };
        scenes.push(current);
        speaker = "";
        parenthetical = "";
        break;

      case "character": {
        const raw = (token.text ?? "").trim();
        offCamera = OFF_CAMERA.test(raw);
        speaker = raw.replace(CUE_EXTENSION, "").trim();
        parenthetical = "";
        break;
      }

      case "parenthetical":
        parenthetical = (token.text ?? "").trim();
        break;

      case "dialogue": {
        const line = (token.text ?? "").trim();
        // Dialogue with no preceding cue is malformed Fountain rather than an
        // anonymous line; skip it instead of inventing a speaker for it.
        if (!current || !line || !speaker) break;
        current.lines.push({
          characterId: null,
          characterName: speaker,
          parenthetical: offCamera ? [parenthetical, "(voice-over, not in the room)"].filter(Boolean).join(" ") : parenthetical,
          line,
          delivery: "",
        });
        // A parenthetical governs the one line it precedes, not the rest of
        // the speech.
        parenthetical = "";
        break;
      }

      default:
        break;
    }
  }

  return scenes;
}

/**
 * One scene's lines, by the id a storyboard panel or shot list item carries.
 *
 * Returns an empty array — never a neighbouring scene's lines — when the id
 * does not resolve. Putting scene 3's dialogue under scene 4's shots would be
 * worse than silence: it is wrong in a way that looks finished, which is the
 * class of failure this codebase's caption findings exist about.
 */
export function sceneDialogueFor(scenes: SceneDialogue[], sceneId: string): DialogueLine[] {
  return scenes.find((scene) => scene.sceneId === sceneId.trim())?.lines ?? [];
}

/**
 * Attach cast ids and locked voices to lines the screenplay only names.
 *
 * Exact full-name matching is not enough on real data, and this was measured
 * rather than guessed: a real project's screenplay cues read `HENRY` and
 * `VICTOR` while its `characters` rows read "Henry Langston" and "Victor
 * Kane", so every line resolved to nobody and every voice came out
 * unconditioned. Screenwriting convention is exactly this — cue by the name
 * the audience uses, not the full one.
 *
 * So: exact match first, then a unique cast member whose own name contains
 * every word of the cue. "MARTY" finds "Martha 'Marty' O'Reilly"; a cue that
 * two characters could equally answer to finds neither, because guessing
 * between them would put one character's locked voice on another's line.
 *
 * A cue that matches nobody — a radio, a crowd, a character the extraction
 * never made a row for — keeps its name and gets no delivery. It still has to
 * be spoken.
 */
export function resolveSpeakers(
  lines: DialogueLine[],
  cast: { id: string; name: string; voiceDesignNotes: string | null }[],
): DialogueLine[] {
  const indexed = cast.map((character) => ({
    character,
    normalised: normaliseName(character.name),
    tokens: new Set(nameTokens(character.name)),
  }));

  return lines.map((entry) => {
    const match = matchSpeaker(indexed, entry.characterName);
    return {
      ...entry,
      characterId: match?.id ?? null,
      // Copied, not referenced: a segment's prompt must not silently change
      // when casting is redone — the same reason `wardrobeVariantId` is set on
      // the row rather than looked up at render time.
      delivery: match?.voiceDesignNotes?.trim() ?? "",
    };
  });
}

type IndexedCast = {
  character: { id: string; name: string; voiceDesignNotes: string | null };
  normalised: string;
  tokens: Set<string>;
};

function matchSpeaker(indexed: IndexedCast[], cue: string) {
  const normalised = normaliseName(cue);
  if (!normalised) return undefined;

  const exact = indexed.find((entry) => entry.normalised === normalised);
  if (exact) return exact.character;

  const cueTokens = nameTokens(cue);
  if (cueTokens.length === 0) return undefined;

  const candidates = indexed.filter((entry) => cueTokens.every((token) => entry.tokens.has(token)));
  // Exactly one, or none: two characters who could both answer to this cue
  // make it ambiguous, and putting one's locked voice on the other's line is
  // worse than leaving it unconditioned.
  return candidates.length === 1 ? candidates[0]!.character : undefined;
}

function normaliseName(name: string): string {
  return nameTokens(name).join(" ");
}

/** Lowercase words, with quotes and punctuation dropped — "Martha 'Marty' O'Reilly" → martha/marty/oreilly. */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}
