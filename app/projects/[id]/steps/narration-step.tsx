"use client";

import { useState } from "react";
import { ContinueBanner } from "../continue-banner";
import type { Cue, Detail } from "../detail-types";

export function NarrationStep({
  detail,
  active,
  busy,
  onRenarrate,
  onRealign,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onRenarrate: (instruct: string) => void;
  onRealign: () => void;
  onContinue: () => void;
  showContinue: boolean;
}) {
  return (
    <div>
      {showContinue && (
        <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />
      )}

      {detail.voiceover?.audioAssetId ? (
        <NarrationPanel
          voiceover={detail.voiceover}
          cues={detail.cues}
          busy={busy || active}
          onRenarrate={onRenarrate}
          onRealign={onRealign}
        />
      ) : (
        <p className="text-sm text-white/35">No narration yet.</p>
      )}
    </div>
  );
}

/**
 * Narration playback with its cues.
 *
 * The cue list shows the authored text alongside what ASR heard, because the
 * two differ by design — the transcript supplies timing only — and seeing both
 * is the fastest way to tell a bad alignment from a bad transcription.
 */
export function NarrationPanel({
  voiceover,
  cues,
  busy,
  onRenarrate,
  onRealign,
}: {
  voiceover: NonNullable<Detail["voiceover"]>;
  cues: Cue[];
  busy: boolean;
  onRenarrate: (instruct: string) => void;
  onRealign: () => void;
}) {
  const [instruct, setInstruct] = useState(voiceover.ttsInstruct);
  const [nowMs, setNowMs] = useState(0);

  const activeCue = cues.find((cue) => nowMs >= cue.startMs && nowMs < cue.endMs);
  const drifted = cues.filter((cue) => cue.heardText === null).length;

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Narration</h2>
        {voiceover.durationMs && (
          <span className="text-xs text-white/35">
            {(voiceover.durationMs / 1000).toFixed(1)}s · {cues.length} cues
            {drifted > 0 && ` · ${drifted} unanchored`}
          </span>
        )}
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        controls
        src={`/api/assets/${voiceover.audioAssetId}`}
        onTimeUpdate={(event) => setNowMs(event.currentTarget.currentTime * 1000)}
        className="mt-3 w-full"
      />

      {cues.length > 0 && (
        <div className="mt-3 grid min-h-14 place-items-center rounded-md bg-black/40 px-4 py-3 text-center text-lg font-semibold">
          {activeCue?.text ?? <span className="text-sm font-normal text-white/25">—</span>}
        </div>
      )}

      <div className="mt-4">
        <label htmlFor="instruct" className="block text-sm font-medium">
          Voice design
        </label>
        <textarea
          id="instruct"
          rows={2}
          value={instruct}
          onChange={(event) => setInstruct(event.target.value)}
          className="mt-2 w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onRenarrate(instruct)}
            disabled={busy}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
          >
            Re-narrate
          </button>
          <button
            onClick={onRealign}
            disabled={busy}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
          >
            Re-align captions
          </button>
        </div>
      </div>

      {cues.length > 0 && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-white/40">cue timings</summary>
          <ul className="mt-2 space-y-1">
            {cues.map((cue) => (
              <li key={cue.id} className="flex gap-3">
                <span className="w-24 shrink-0 font-mono text-white/35">
                  {(cue.startMs / 1000).toFixed(2)}–{(cue.endMs / 1000).toFixed(2)}
                </span>
                <span className="flex-1">{cue.text}</span>
                {cue.heardText && cue.heardText.toLowerCase() !== cue.text.toLowerCase() && (
                  <span className="flex-1 text-white/30">heard: {cue.heardText}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
