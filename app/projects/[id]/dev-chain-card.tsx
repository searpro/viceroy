"use client";

import { useState } from "react";
import { Panel } from "./steps/panel";
import { ContinueBanner } from "./continue-banner";
import { castingLockReason } from "./redo-warning";
import { DEV_CHAIN_ORDER, DEV_STAGE_LABELS } from "./dev-stages";
import { TimelineStep } from "./steps/timeline-step";
import type { Detail } from "./detail-types";

/** What a scoped Development-chain image redo names (M7.1 PR-D0). */
export type DevItemScope = { panelId: string } | { locationId: string } | { propId: string };

/**
 * The Development chain's review card (M7 PR1, generate/approve wiring added
 * once PR2/PR3 gave the chain something to generate).
 *
 * A dev-format project's `nextStep` names a `dev_artifacts` stage instead of
 * a job type; there is still no per-stage step component (PR4+ can grow one
 * once there's per-stage content worth reviewing beyond raw text). Until
 * then this reuses the same `ContinueBanner` every narrative step already
 * uses to dispatch/approve work — `advance()` in `lib/pipeline/chain.ts`
 * already handles both an empty stage (enqueue it) and a pending one
 * (approve, then re-derive and enqueue the next), so no dev-specific action
 * is needed here beyond calling the same `onContinue`.
 */
export function DevChainCard({
  detail,
  active,
  busy,
  onContinue,
  onResolveContinuityFact,
  onUnlockCasting,
  onRedoDevItem,
  onPatchTimeline,
  onPatchSegment,
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onContinue: () => void;
  onResolveContinuityFact: (factId: string) => void;
  onUnlockCasting: (characterId: string) => void;
  onRedoDevItem: (scope: DevItemScope, direction: string, wardrobeVariantId?: string | null) => void;
  onPatchTimeline: (patch: Record<string, unknown>) => void;
  onPatchSegment: (segmentId: string, patch: Record<string, unknown>) => void;
}) {
  const { nextStep } = detail;

  if (nextStep.kind === "complete") {
    return (
      <div>
        <Panel title="Development" empty={false} emptyText="">
          <p className="text-sm text-white/85">{nextStep.reason}</p>
        </Panel>
        <DevChainHistory
          detail={detail}
          busy={busy}
          onResolveContinuityFact={onResolveContinuityFact}
          onUnlockCasting={onUnlockCasting}
          onRedoDevItem={onRedoDevItem}
          onPatchTimeline={onPatchTimeline}
          onPatchSegment={onPatchSegment}
        />
      </div>
    );
  }

  const stage = nextStep.kind === "dev" ? nextStep.stage : undefined;

  return (
    <div>
      <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />

      {/* Every other stage's "next" panel is a placeholder — its content
          shows in the history below once generated. The timeline is the
          exception on purpose: reviewing and editing the arrangement is what
          the approval click means here, so it has to be on screen *before*
          the click, not filed under "generated so far" afterwards. */}
      {stage === "timeline" && detail.timeline ? (
        <Panel title="Production timeline" empty={false} emptyText="">
          <TimelineStep
            detail={detail}
            busy={busy}
            onPatchTimeline={onPatchTimeline}
            onPatchSegment={onPatchSegment}
          />
        </Panel>
      ) : (
        <Panel title={stage ?? "Development"} empty emptyText="Not yet generated.">
          <></>
        </Panel>
      )}
      <DevChainHistory
        detail={detail}
        busy={busy}
        onResolveContinuityFact={onResolveContinuityFact}
        onUnlockCasting={onUnlockCasting}
        onRedoDevItem={onRedoDevItem}
        onPatchTimeline={onPatchTimeline}
        onPatchSegment={onPatchSegment}
      />
    </div>
  );
}

// Stage order and labels live in their own module so a test can assert they
// stay in step with `DEV_CHAIN_STAGES` — see dev-stages.ts.

/**
 * Read-only history of everything the Development chain has generated so
 * far — without this, a finished (or in-progress) dev-format project shows
 * only whichever single stage is next, and everything already approved is
 * otherwise invisible in the UI. Closed by default (`<details>`) since a
 * Story Bible alone can run to several thousand words; opening one doesn't
 * require a round trip since the content is already in `detail`.
 */
function DevChainHistory({
  detail,
  busy,
  onResolveContinuityFact,
  onUnlockCasting,
  onRedoDevItem,
  onPatchTimeline,
  onPatchSegment,
}: {
  detail: Detail;
  busy: boolean;
  onResolveContinuityFact: (factId: string) => void;
  onUnlockCasting: (characterId: string) => void;
  onRedoDevItem: (scope: DevItemScope, direction: string, wardrobeVariantId?: string | null) => void;
  onPatchTimeline: (patch: Record<string, unknown>) => void;
  onPatchSegment: (segmentId: string, patch: Record<string, unknown>) => void;
}) {
  const byStage = new Map(detail.devArtifacts.map((row) => [row.stage, row]));
  const hasCharacters = detail.characters.length > 0;
  const hasWorld = Boolean(detail.worldBuilding?.content) || detail.locations.length > 0 || detail.props.length > 0;
  const hasContinuity = detail.continuityFacts.length > 0;
  const hasConceptArt = [...detail.locations, ...detail.props].some((entity) => entity.imageAssetId);
  const hasStoryboards = detail.storyboardPanels.length > 0;
  const hasShotList = detail.shotListItems.length > 0;
  const hasPrevis = Boolean(detail.project.previsAssetId);
  const hasTimeline = Boolean(detail.timeline);
  // Same shape `hasConceptArt` uses for locations/props: a portrait, not just
  // a cast row, is what makes this stage's own section worth showing.
  const hasCasting = detail.characters.some((character) => character.imageAssetId);

  const stagesWithContent = DEV_CHAIN_ORDER.filter((stage) => {
    if (stage === "characters") return hasCharacters;
    if (stage === "world_building") return hasWorld;
    if (stage === "continuity") return hasContinuity;
    if (stage === "concept_art") return hasConceptArt;
    if (stage === "storyboards") return hasStoryboards;
    if (stage === "shot_list") return hasShotList;
    if (stage === "previs") return hasPrevis;
    if (stage === "timeline") return hasTimeline;
    if (stage === "casting") return hasCasting;
    return byStage.has(stage);
  });

  if (stagesWithContent.length === 0) return null;

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Generated so far</h2>
      <div className="mt-3 space-y-2">
        {stagesWithContent.map((stage) => (
          <details
            key={stage}
            className="rounded-lg border border-white/10 bg-white/[0.02] p-4 open:pb-4"
          >
            <summary className="cursor-pointer text-sm font-medium text-white/85">
              {DEV_STAGE_LABELS[stage]}
            </summary>
            <div className="mt-3">
              {stage === "characters" ? (
                <CharactersSection detail={detail} />
              ) : stage === "world_building" ? (
                <WorldBuildingSection detail={detail} />
              ) : stage === "continuity" ? (
                <ContinuitySection detail={detail} onResolveContinuityFact={onResolveContinuityFact} />
              ) : stage === "concept_art" ? (
                <ConceptArtSection detail={detail} busy={busy} onRedo={onRedoDevItem} />
              ) : stage === "storyboards" ? (
                <StoryboardsSection detail={detail} busy={busy} onRedo={onRedoDevItem} />
              ) : stage === "shot_list" ? (
                <ShotListSection detail={detail} />
              ) : stage === "previs" ? (
                <PrevisSection detail={detail} />
              ) : stage === "timeline" ? (
                <TimelineStep
                  detail={detail}
                  busy={busy}
                  onPatchTimeline={onPatchTimeline}
                  onPatchSegment={onPatchSegment}
                />
              ) : stage === "casting" ? (
                <CastingSection detail={detail} onUnlockCasting={onUnlockCasting} />
              ) : (
                <StageContent
                  content={byStage.get(stage)?.content ?? ""}
                  approved={Boolean(byStage.get(stage)?.approvedAt)}
                  pdfHref={
                    stage === "screenplay" || stage === "screenplay_revision"
                      ? `/api/projects/${detail.project.id}/screenplay.pdf`
                      : undefined
                  }
                />
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function StageContent({
  content,
  approved,
  pdfHref,
}: {
  content: string;
  approved: boolean;
  pdfHref?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span className={`text-xs ${approved ? "text-emerald-400" : "text-white/40"}`}>
          {approved ? "approved" : "draft, not yet approved"}
        </span>
        {pdfHref && approved && (
          <a
            href={pdfHref}
            className="text-xs text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-200"
          >
            download PDF
          </a>
        )}
      </div>
      <p className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap text-sm text-white/75">{content}</p>
    </div>
  );
}

function CharactersSection({ detail }: { detail: Detail }) {
  return (
    <ul className="space-y-3">
      {detail.characters.map((character) => (
        <li key={character.id} className="text-sm">
          <p className="font-medium text-white/85">{character.name}</p>
          <p className="mt-1 text-white/70">{character.description}</p>
          {character.arc && <p className="mt-1 text-white/50">Arc: {character.arc}</p>}
        </li>
      ))}
    </ul>
  );
}

function WorldBuildingSection({ detail }: { detail: Detail }) {
  return (
    <div className="space-y-4 text-sm">
      {detail.worldBuilding?.content && (
        <p className="whitespace-pre-wrap text-white/75">{detail.worldBuilding.content}</p>
      )}
      {detail.locations.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-white/40">Locations</p>
          <ul className="mt-1 space-y-1">
            {detail.locations.map((location) => (
              <li key={location.id} className="text-white/70">
                <span className="font-medium text-white/85">{location.name}</span> — {location.description}
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.props.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-white/40">Props</p>
          <ul className="mt-1 space-y-1">
            {detail.props.map((prop) => (
              <li key={prop.id} className="text-white/70">
                <span className="font-medium text-white/85">{prop.name}</span> — {prop.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The per-item re-roll control (M7.1 PR-D0).
 *
 * Direction is local to this one item, not the card-level direction box: the
 * whole point of a scoped redo is that it steers one picture, and a shared
 * input would leak a note written for one panel into the next one re-rolled.
 * Same reasoning as `SceneCard`'s own per-scene direction state (scenes-step).
 *
 * Collapsed behind a "re-roll" toggle rather than always-open, because these
 * render in a grid of many and a text input under every thumbnail would bury
 * the images the grid exists to show.
 */
function RerollControl({
  busy,
  wardrobe,
  onRedo,
}: {
  busy: boolean;
  /**
   * Offered only where an outfit is a meaningful thing to change — storyboard
   * panels. Concept-art plates are locations and props, which have no wardrobe,
   * so they pass nothing and the picker does not render (M7.1 PR-C).
   */
  wardrobe?: {
    options: { id: string; label: string }[];
    selected: string | null;
  };
  onRedo: (direction: string, wardrobeVariantId?: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState("");
  const [variantId, setVariantId] = useState<string | null>(wardrobe?.selected ?? null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className="text-[11px] text-white/40 underline underline-offset-2 hover:text-white/70 disabled:opacity-40"
      >
        re-roll
      </button>
    );
  }

  return (
    <div className="space-y-1">
      <input
        value={direction}
        onChange={(event) => setDirection(event.target.value)}
        placeholder="direction (optional)"
        className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-white/80 placeholder:text-white/30"
      />
      {wardrobe && wardrobe.options.length > 0 ? (
        <select
          value={variantId ?? ""}
          onChange={(event) => setVariantId(event.target.value || null)}
          aria-label="Wardrobe"
          className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px] text-white/80"
        >
          <option value="">default wardrobe</option>
          {wardrobe.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            // The outfit is only sent when this control offers one, so a
            // concept-art re-roll never carries a wardrobe field at all.
            onRedo(direction, wardrobe ? variantId : undefined);
            setOpen(false);
            setDirection("");
          }}
          disabled={busy}
          className="rounded border border-white/20 px-1.5 py-0.5 text-[11px] text-white/80 hover:bg-white/10 disabled:opacity-40"
        >
          Re-roll
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setDirection("");
          }}
          className="text-[11px] text-white/40 hover:text-white/70"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// M7 PR9. The one stage in this history panel whose output is images rather
// than text — every location/prop that has one gets a thumbnail, not just a
// name in a list, since that's the entire point of reviewing this stage.
function ConceptArtSection({
  detail,
  busy,
  onRedo,
}: {
  detail: Detail;
  busy: boolean;
  onRedo: (scope: DevItemScope, direction: string) => void;
}) {
  // Tagged on merge: a scoped redo has to name `locationId` or `propId`
  // specifically, and a flat concat of the two arrays loses which is which.
  const entities = [
    ...detail.locations.map((entity) => ({ entity, scope: { locationId: entity.id } as DevItemScope })),
    ...detail.props.map((entity) => ({ entity, scope: { propId: entity.id } as DevItemScope })),
  ].filter(({ entity }) => entity.imageAssetId);

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {entities.map(({ entity, scope }) => (
        <figure key={entity.id} className="space-y-1.5">
          <img
            src={`/api/assets/${entity.imageAssetId}`}
            alt={entity.name}
            className="aspect-[9/16] w-full rounded-md border border-white/10 object-cover"
          />
          <figcaption className="text-xs text-white/60">{entity.name}</figcaption>
          <RerollControl busy={busy} onRedo={(direction) => onRedo(scope, direction)} />
        </figure>
      ))}
    </div>
  );
}

// M7 PR10. Same thumbnail-grid shape as `ConceptArtSection` above, plus the
// four cinematography fields surfaced as visible labels alongside each
// thumbnail — the acceptance bar this stage exists to clear is that
// shotType/cameraAngle/cameraMovement/lens are independently visible, not
// baked into `panelImagePrompt` as prose only.
function StoryboardsSection({
  detail,
  busy,
  onRedo,
}: {
  detail: Detail;
  busy: boolean;
  onRedo: (scope: DevItemScope, direction: string, wardrobeVariantId?: string | null) => void;
}) {
  // Labelled by character, since a variant named "Field kit" says nothing on
  // its own about whose field kit it is.
  const nameById = new Map(detail.characters.map((character) => [character.id, character.name]));
  const wardrobeOptions = (detail.wardrobeVariants ?? []).map((variant) => ({
    id: variant.id,
    label: `${nameById.get(variant.characterId) ?? "?"} — ${variant.name}`,
  }));
  const panels = [...detail.storyboardPanels].sort((a, b) =>
    a.sceneId === b.sceneId ? a.index - b.index : a.sceneId.localeCompare(b.sceneId),
  );
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {panels.map((panel) => (
        <figure key={panel.id} className="space-y-1.5">
          {panel.panelImageAssetId ? (
            <img
              src={`/api/assets/${panel.panelImageAssetId}`}
              alt={`Scene ${panel.sceneId}, beat ${panel.index + 1}`}
              className="aspect-[9/16] w-full rounded-md border border-white/10 object-cover"
            />
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md border border-white/10 text-xs text-white/40">
              not yet generated
            </div>
          )}
          <figcaption className="text-xs text-white/60">
            Scene {panel.sceneId} · beat {panel.index + 1}
          </figcaption>
          <ul className="flex flex-wrap gap-1 text-[10px] uppercase tracking-wide text-white/40">
            <li className="rounded border border-white/10 px-1.5 py-0.5">{panel.shotType}</li>
            <li className="rounded border border-white/10 px-1.5 py-0.5">{panel.cameraAngle}</li>
            <li className="rounded border border-white/10 px-1.5 py-0.5">{panel.cameraMovement}</li>
            <li className="rounded border border-white/10 px-1.5 py-0.5">{panel.lens}</li>
          </ul>
          <RerollControl
            busy={busy}
            wardrobe={{ options: wardrobeOptions, selected: panel.wardrobeVariantId ?? null }}
            onRedo={(direction, wardrobeVariantId) =>
              onRedo({ panelId: panel.id }, direction, wardrobeVariantId)
            }
          />
        </figure>
      ))}
    </div>
  );
}

// M7 PR11. Same thumbnail-grid shape as `StoryboardsSection` above, plus the
// keyframe/motion two-register split surfaced as two separate, truncated
// lines rather than one — the acceptance bar this stage exists to clear is
// that the two registers stay visibly distinct, never baked into one field.
function ShotListSection({ detail }: { detail: Detail }) {
  const items = [...detail.shotListItems].sort((a, b) =>
    a.sceneId === b.sceneId ? a.index - b.index : a.sceneId.localeCompare(b.sceneId),
  );
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <figure key={item.id} className="space-y-1.5">
          {item.keyframeAssetId ? (
            <img
              src={`/api/assets/${item.keyframeAssetId}`}
              alt={`Scene ${item.sceneId}, shot ${item.index + 1}`}
              className="aspect-[9/16] w-full rounded-md border border-white/10 object-cover"
            />
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md border border-white/10 text-xs text-white/40">
              no keyframe
            </div>
          )}
          <figcaption className="text-xs text-white/60">
            Scene {item.sceneId} · shot {item.index + 1}
            {item.durationHintMs ? ` · ~${(item.durationHintMs / 1000).toFixed(1)}s` : ""}
          </figcaption>
          <p className="line-clamp-2 text-[11px] text-white/70">
            <span className="text-white/40">Frame: </span>
            {item.keyframePrompt}
          </p>
          <p className="line-clamp-2 text-[11px] text-white/70">
            <span className="text-white/40">Motion: </span>
            {item.motionPrompt}
          </p>
        </figure>
      ))}
    </div>
  );
}

// M7 PR11. Previs produces exactly one artifact per project, unlike every
// other Preproduction stage above — a video element plus a plain download
// link, the same `/api/assets/{id}` route every other asset already serves
// through (mirrors the screenplay PDF download link's `<a>` pattern, just
// against a video src instead of a PDF href).
function PrevisSection({ detail }: { detail: Detail }) {
  const assetId = detail.project.previsAssetId;
  if (!assetId) {
    return <p className="text-sm text-white/50">Not yet rendered.</p>;
  }
  return (
    <div className="space-y-2">
      <video
        src={`/api/assets/${assetId}`}
        controls
        className="aspect-[9/16] w-full max-w-xs rounded-md border border-white/10"
      />
      <a
        href={`/api/assets/${assetId}`}
        download
        className="block text-xs text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-200"
      >
        download previs
      </a>
    </div>
  );
}

// M7 PR12. Same thumbnail-grid shape as `ConceptArtSection` above, plus a
// lock indicator (this stage's whole point per the M7 detail page's own
// "Casting" section) and voice design notes when present. A locked
// character's redo affordance lives here rather than a bespoke screen, per
// this PR's own explicit scope limit — an inline "Unlock" button plus
// `castingLockReason`'s message, nothing more.
function CastingSection({
  detail,
  onUnlockCasting,
}: {
  detail: Detail;
  onUnlockCasting: (characterId: string) => void;
}) {
  const cast = detail.characters.filter((character) => character.imageAssetId);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {cast.map((character) => {
        const lockReason = castingLockReason(character);
        return (
          <figure key={character.id} className="space-y-1.5">
            <img
              src={`/api/assets/${character.imageAssetId}`}
              alt={character.name}
              className="aspect-[9/16] w-full rounded-md border border-white/10 object-cover"
            />
            <figcaption className="text-xs text-white/60">{character.name}</figcaption>
            <span
              className={`block text-[10px] uppercase tracking-wide ${
                lockReason ? "text-emerald-400" : "text-white/40"
              }`}
            >
              {lockReason ? "locked" : "unlocked"}
            </span>
            {character.voiceDesignNotes && (
              <p className="text-[11px] text-white/60">
                <span className="text-white/40">Voice: </span>
                {character.voiceDesignNotes}
              </p>
            )}
            {lockReason && (
              <div>
                <p className="text-[11px] text-amber-300">{lockReason}</p>
                <button
                  onClick={() => onUnlockCasting(character.id)}
                  className="mt-1 rounded border border-amber-300/40 px-2 py-0.5 text-[11px] text-amber-300 transition hover:bg-amber-300/10"
                >
                  Unlock
                </button>
              </div>
            )}
          </figure>
        );
      })}
    </div>
  );
}

/**
 * Flat list of every continuity fact on record, per the M7 detail page's own
 * PR7 scope ("no UI review surface beyond a flat list is required... a
 * richer conflict-resolution UI can follow once there's real data to design
 * against"). A `source: "conflict"` fact gets a one-click "resolve" button;
 * every other fact is read-only here.
 */
function ContinuitySection({
  detail,
  onResolveContinuityFact,
}: {
  detail: Detail;
  onResolveContinuityFact: (factId: string) => void;
}) {
  return (
    <ul className="space-y-3">
      {detail.continuityFacts.map((fact) => (
        <li key={fact.id} className="text-sm">
          <div className="flex items-start justify-between gap-4">
            <p className="text-white/75">
              <span className="text-xs uppercase tracking-wide text-white/40">
                {fact.subjectType}
              </span>{" "}
              <span className="font-medium text-white/85">{fact.subjectName}</span>
              {fact.sceneId ? <span className="text-white/40"> (scene {fact.sceneId})</span> : null}
              {": "}
              {fact.fact}
            </p>
            {fact.source === "conflict" && (
              <button
                onClick={() => onResolveContinuityFact(fact.id)}
                className="shrink-0 rounded border border-amber-300/40 px-2 py-0.5 text-xs text-amber-300 transition hover:bg-amber-300/10"
              >
                resolve
              </button>
            )}
          </div>
          <span
            className={`text-xs ${
              fact.source === "conflict"
                ? "text-amber-300"
                : fact.source === "resolved"
                  ? "text-emerald-400"
                  : "text-white/40"
            }`}
          >
            {fact.source === "conflict" ? "conflicts with another fact" : fact.source}
          </span>
        </li>
      ))}
    </ul>
  );
}
