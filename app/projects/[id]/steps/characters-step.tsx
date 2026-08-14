"use client";

import { useState } from "react";
import { ContinueBanner } from "../continue-banner";
import type { Character, Detail } from "../detail-types";

export function CharactersStep({
  detail,
  active,
  busy,
  onRedoPortrait,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onRedoPortrait: (characterId: string, direction: string) => void;
  onContinue: () => void;
  showContinue: boolean;
}) {
  return (
    <div>
      {showContinue && (
        <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />
      )}

      {detail.characters.length > 0 ? (
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Cast</h2>
          <ul className="mt-3 space-y-3 text-sm">
            {detail.characters.map((character) => (
              <CharacterRow
                key={character.id}
                character={character}
                busy={busy || active}
                onRedoPortrait={(direction) => onRedoPortrait(character.id, direction)}
              />
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-white/35">No cast yet.</p>
      )}
    </div>
  );
}

/** One cast member, with its own direction field for redoing just their portrait. */
export function CharacterRow({
  character,
  busy,
  onRedoPortrait,
}: {
  character: Character;
  busy: boolean;
  onRedoPortrait: (direction: string) => void;
}) {
  const [direction, setDirection] = useState("");

  return (
    <li className="flex gap-3">
      {character.imageAssetId && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${character.imageAssetId}`}
          alt={character.name}
          className="h-14 w-14 shrink-0 rounded object-cover"
        />
      )}
      <div className="flex-1">
        <span className="block font-medium">{character.name}</span>
        <span className="block text-xs text-white/45">
          {character.appearanceTag ?? character.description}
        </span>
        <div className="mt-1.5 flex gap-2">
          <input
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="direct this portrait"
            className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <button
            onClick={() => onRedoPortrait(direction)}
            disabled={busy}
            className="shrink-0 rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
          >
            Redo portrait
          </button>
        </div>
      </div>
    </li>
  );
}
