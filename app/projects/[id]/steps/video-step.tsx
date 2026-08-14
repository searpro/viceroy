"use client";

import { ContinueBanner } from "../continue-banner";
import type { Detail } from "../detail-types";

export function VideoStep({
  detail,
  active,
  busy,
  onContinue,
  showContinue,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onContinue: () => void;
  showContinue: boolean;
}) {
  return (
    <div>
      {showContinue && (
        <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />
      )}

      {detail.render?.assetId ? (
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Video</h2>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            controls
            src={`/api/assets/${detail.render.assetId}`}
            className="mt-3 max-h-[70vh] w-full rounded-md bg-black"
          />
        </section>
      ) : (
        <p className="text-sm text-white/35">No render yet.</p>
      )}
    </div>
  );
}
