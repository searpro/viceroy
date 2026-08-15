"use client";

import { useState } from "react";
import { ContinueBanner } from "../continue-banner";
import type { Character, Detail } from "../detail-types";

export function CharactersStep({
  detail,
  active,
  busy,
  onRedoPortrait,
  onUploadImage,
  onClearImage,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onRedoPortrait: (characterId: string, direction: string) => void;
  onUploadImage: (characterId: string, file: File) => void;
  onClearImage: (characterId: string) => void;
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
                // Uploading a photo doesn't touch the character_images job, so
                // it shouldn't wait on `active` (any project job running) —
                // only on `busy` (this row's own upload/clear request being
                // in flight). Tying it to `active` locked the control for the
                // whole duration of portrait generation (BUG-4).
                uploadBusy={busy}
                // Manual mode is the only surface with an upload control; auto
                // mode has no review step to host it on (VIC-002 non-goal).
                canUpload={detail.project.mode === "manual"}
                onRedoPortrait={(direction) => onRedoPortrait(character.id, direction)}
                onUploadImage={(file) => onUploadImage(character.id, file)}
                onClearImage={() => onClearImage(character.id)}
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
  uploadBusy,
  canUpload,
  onRedoPortrait,
  onUploadImage,
  onClearImage,
}: {
  character: Character;
  busy: boolean;
  uploadBusy: boolean;
  canUpload: boolean;
  onRedoPortrait: (direction: string) => void;
  onUploadImage: (file: File) => void;
  onClearImage: () => void;
}) {
  const [direction, setDirection] = useState("");
  const uploaded = character.imageSource === "uploaded";

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
        <span className="block font-medium">
          {character.name}
          {uploaded && (
            <span className="ml-2 rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-white/45">
              Uploaded
            </span>
          )}
        </span>
        <span className="block text-xs text-white/45">
          {character.appearanceTag ?? character.description}
        </span>
        {character.imagePrompt && (
          <details className="mt-1 text-[11px] text-white/35">
            <summary className="cursor-pointer">prompt</summary>
            <p className="mt-1 leading-relaxed">{character.imagePrompt}</p>
          </details>
        )}
        <div className="mt-1.5 flex gap-2">
          <input
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder="direct this portrait"
            className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <button
            onClick={() => {
              // An uploaded photo is the user's own; a redo would silently
              // replace it with a generated one, so make that cost explicit
              // rather than let a misclick lose it.
              if (uploaded && !window.confirm("This replaces your uploaded photo with a generated portrait. Continue?")) {
                return;
              }
              onRedoPortrait(direction);
            }}
            disabled={busy}
            className="shrink-0 rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
          >
            {/* No portrait yet: this is the first, explicit choice to generate
                one — "Redo" only makes sense once there's something to redo. */}
            {character.imageAssetId ? "Redo portrait" : "Generate"}
          </button>
        </div>
        {canUpload && (
          <div className="mt-1.5 flex items-center gap-2">
            <label className="shrink-0 cursor-pointer rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 aria-disabled:pointer-events-none aria-disabled:opacity-40">
              Use my photo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onUploadImage(file);
                }}
                className="hidden"
              />
            </label>
            {uploaded && (
              <button
                onClick={onClearImage}
                disabled={uploadBusy}
                className="shrink-0 rounded border border-white/15 px-2 py-1 text-[11px] transition hover:border-white/35 disabled:opacity-40"
              >
                Revert to generated
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
