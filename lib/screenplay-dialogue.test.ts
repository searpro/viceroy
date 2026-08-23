import { describe, expect, it } from "vitest";
import { extractSceneDialogue, resolveSpeakers, sceneDialogueFor } from "./screenplay-dialogue";

const SCREENPLAY = `INT. LIGHTHOUSE - NIGHT

Henry turns the pages of a weathered logbook.

HENRY
Unnatural... these patterns.

HENRY (CONT'D)
(quietly)
They don't drift.

EXT. WHARF - DAY

Eve picks her way across the boards.

EVE
(shouting over the wind)
You said the storms were random!

RADIO (V.O.)
Small craft warning remains in effect.

INT. GENERAL STORE - DAY

Marty watches the street. Nobody speaks.
`;

describe("extractSceneDialogue", () => {
  it("groups lines under the scene they are spoken in, numbered by position", () => {
    const scenes = extractSceneDialogue(SCREENPLAY);
    expect(scenes.map((s) => s.sceneId)).toEqual(["1", "2", "3"]);
    expect(scenes.map((s) => s.lines.length)).toEqual([2, 2, 0]);
    expect(scenes[0]!.heading).toContain("LIGHTHOUSE");
  });

  it("reproduces the authored words exactly", () => {
    const [scene] = extractSceneDialogue(SCREENPLAY);
    expect(scene!.lines.map((l) => l.line)).toEqual([
      "Unnatural... these patterns.",
      "They don't drift.",
    ]);
  });

  it("strips a cue extension from the name but keeps the speaker", () => {
    // "HENRY (CONT'D)" is the same person as "HENRY".
    const [scene] = extractSceneDialogue(SCREENPLAY);
    expect(scene!.lines.map((l) => l.characterName)).toEqual(["HENRY", "HENRY"]);
  });

  it("keeps a parenthetical, and attaches it only to the line it precedes", () => {
    const [scene] = extractSceneDialogue(SCREENPLAY);
    expect(scene!.lines[0]!.parenthetical).toBe("");
    expect(scene!.lines[1]!.parenthetical).toContain("quietly");
  });

  it("marks a voice-over as not in the room — it needs a different acoustic", () => {
    const scenes = extractSceneDialogue(SCREENPLAY);
    const radio = scenes[1]!.lines.find((l) => l.characterName === "RADIO")!;
    expect(radio.parenthetical).toContain("voice-over");
    expect(radio.line).toBe("Small craft warning remains in effect.");
  });

  it("returns a scene with no dialogue as empty rather than omitting it", () => {
    // Scene numbering has to stay aligned with the screenplay's own order, or
    // every later scene's lines land under the wrong shots.
    const scenes = extractSceneDialogue(SCREENPLAY);
    expect(scenes[2]).toMatchObject({ sceneId: "3", lines: [] });
  });
});

describe("sceneDialogueFor", () => {
  const scenes = extractSceneDialogue(SCREENPLAY);

  it("finds a scene's lines by the id a shot carries", () => {
    expect(sceneDialogueFor(scenes, "2").map((l) => l.characterName)).toEqual(["EVE", "RADIO"]);
    expect(sceneDialogueFor(scenes, " 1 ")).toHaveLength(2);
  });

  it("returns nothing — never a neighbour's lines — for an id that does not resolve", () => {
    // Putting scene 3's dialogue under scene 4's shots would be wrong in a way
    // that looks finished, which is the failure this codebase's caption
    // findings are about.
    expect(sceneDialogueFor(scenes, "9")).toEqual([]);
    expect(sceneDialogueFor(scenes, "")).toEqual([]);
  });
});

describe("resolveSpeakers", () => {
  const cast = [
    { id: "c-henry", name: "Henry", voiceDesignNotes: "gravelly, unhurried, faint Irish lilt" },
    { id: "c-eve", name: "Eve", voiceDesignNotes: null },
  ];

  it("attaches the cast id and the locked voice, matching by name case-insensitively", () => {
    const [first] = resolveSpeakers(sceneDialogueFor(extractSceneDialogue(SCREENPLAY), "1"), cast);
    expect(first).toMatchObject({
      characterId: "c-henry",
      delivery: "gravelly, unhurried, faint Irish lilt",
    });
  });

  it("leaves delivery empty for a character with no locked voice", () => {
    const lines = resolveSpeakers(sceneDialogueFor(extractSceneDialogue(SCREENPLAY), "2"), cast);
    expect(lines[0]).toMatchObject({ characterId: "c-eve", delivery: "" });
  });

  it("matches a cue to the full name it abbreviates, as screenplays actually cue", () => {
    // Measured on a real project: cues read HENRY and VICTOR while the cast
    // rows read "Henry Langston" and "Victor Kane", so exact matching resolved
    // nobody and every voice came out unconditioned.
    const fullNames = [
      { id: "c-henry", name: "Henry Langston", voiceDesignNotes: "gravelly, unhurried" },
      { id: "c-marty", name: "Martha 'Marty' O'Reilly", voiceDesignNotes: "brisk, dry" },
    ];
    const lines = resolveSpeakers(
      [
        { characterId: null, characterName: "HENRY", parenthetical: "", line: "a", delivery: "" },
        { characterId: null, characterName: "MARTY", parenthetical: "", line: "b", delivery: "" },
      ],
      fullNames,
    );
    expect(lines.map((l) => l.characterId)).toEqual(["c-henry", "c-marty"]);
    expect(lines[0]!.delivery).toBe("gravelly, unhurried");
  });

  it("refuses an ambiguous cue rather than picking one of two candidates", () => {
    // One character's locked voice on another character's line is worse than
    // no voice at all.
    const twins = [
      { id: "c-1", name: "Henry Langston", voiceDesignNotes: "gravelly" },
      { id: "c-2", name: "Henry Kane", voiceDesignNotes: "reedy" },
    ];
    const [line] = resolveSpeakers(
      [{ characterId: null, characterName: "HENRY", parenthetical: "", line: "a", delivery: "" }],
      twins,
    );
    expect(line).toMatchObject({ characterId: null, delivery: "" });
  });

  it("keeps a cue that matches nobody — it still has to be spoken", () => {
    const lines = resolveSpeakers(sceneDialogueFor(extractSceneDialogue(SCREENPLAY), "2"), cast);
    expect(lines[1]).toMatchObject({ characterId: null, characterName: "RADIO", delivery: "" });
  });
});
