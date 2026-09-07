"use client";

import { useState } from "react";
import { Markdown } from "@/app/components/markdown";
import { DEV_STAGE_PHASES } from "@/lib/labels";
import { looksLikeMarkdown } from "@/lib/markdown";
import { aspectCss, projectAspect } from "@/lib/resolution";
import { Panel } from "./steps/panel";
import { ContinueBanner } from "./continue-banner";
import { castingLockReason } from "./redo-warning";
import { DEV_CHAIN_ORDER, DEV_STAGE_LABELS } from "./dev-stages";
import { TimelineStep } from "./steps/timeline-step";
import { ACTIVE_JOB_STATUSES, type Detail } from "./detail-types";

/** What a scoped Development-chain image redo names (M7.1 PR-D0). */
export type DevItemScope =
  | { panelId: string }
  | { locationId: string }
  | { propId: string }
  // A cast portrait, re-rolled through the dev chain's own "casting" stage
  // rather than the narrative pipeline's "character_images" (BUG-29).
  | { characterId: string };

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
        <Panel title={stage ? (DEV_STAGE_LABELS[stage] ?? stage) : "Development"} empty emptyText="Not yet generated.">
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
  // A stage's own job being in flight keeps its section on screen while a
  // redo has cleared the images that would otherwise prove the stage ran —
  // without this, re-rolling the only cast portrait (or the only concept-art
  // plate) makes the whole section vanish until the job lands.
  const running = runningStages(detail);
  const byStage = new Map(detail.devArtifacts.map((row) => [row.stage, row]));
  const hasCharacters = detail.characters.length > 0;
  const hasWorld = Boolean(detail.worldBuilding?.content) || detail.locations.length > 0 || detail.props.length > 0;
  const hasContinuity = detail.continuityFacts.length > 0;
  const conceptArtSubjects = [...detail.locations, ...detail.props];
  // The `running` half keeps the section up while a redo has cleared the only
  // plate; the length guard stops it rendering an empty grid for a job that
  // started before world-building produced anything to draw.
  const hasConceptArt =
    conceptArtSubjects.length > 0 &&
    (conceptArtSubjects.some((entity) => entity.imageAssetId) || running.has("concept_art"));
  const hasStoryboards = detail.storyboardPanels.length > 0;
  const hasShotList = detail.shotListItems.length > 0;
  const hasPrevis = Boolean(detail.project.previsAssetId);
  const hasTimeline = Boolean(detail.timeline);
  // Same shape `hasConceptArt` uses for locations/props: a portrait, not just
  // a cast row, is what makes this stage's own section worth showing — the
  // cast rows themselves land at stage 3 (`runDevCharacters`), seventeen
  // stages before this one.
  const hasCasting =
    detail.characters.length > 0 &&
    (detail.characters.some((character) => character.imageAssetId) || running.has("casting"));

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
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Generated so far</h2>
        <span className="text-xs text-white/30">
          {stagesWithContent.length} of {DEV_CHAIN_ORDER.length} stages
        </span>
      </div>

      {/* Grouped by phase rather than listed flat. Twenty-two identical
          collapsed rows is not a list anyone reads — the phase headings are
          what let you find "the storyboards" without counting down from the
          top, and the per-phase count says at a glance how far the chain got
          before it stopped. */}
      <div className="mt-3 space-y-4">
        {DEV_STAGE_PHASES.map((phase) => {
          const stages = phase.stages.filter((stage) => stagesWithContent.includes(stage));
          if (stages.length === 0) return null;
          return (
            <div key={phase.key}>
              <div className="flex items-center gap-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-white/35">
                  {phase.label}
                </h3>
                <span className="text-[11px] text-white/20">
                  {stages.length}/{phase.stages.length}
                </span>
                <span className="h-px flex-1 bg-white/5" />
              </div>
              <div className="mt-2 space-y-2">
                {stages.map((stage) => (
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
                <ConceptArtSection
                  detail={detail}
                  busy={busy}
                  generating={running.has("concept_art")}
                  onRedo={onRedoDevItem}
                />
              ) : stage === "storyboards" ? (
                <StoryboardsSection
                  detail={detail}
                  busy={busy}
                  generating={running.has("storyboards")}
                  onRedo={onRedoDevItem}
                />
              ) : stage === "shot_list" ? (
                <ShotListSection detail={detail} generating={running.has("shot_list")} />
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
                <CastingSection
                  detail={detail}
                  busy={busy}
                  generating={running.has("casting")}
                  onUnlockCasting={onUnlockCasting}
                  onRedo={onRedoDevItem}
                />
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
            </div>
          );
        })}
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
      <div className="mt-2 max-h-[32rem] overflow-y-auto pr-1">
        {/* Every text stage emits markdown — `##` act headings in a story
            bible, `**bold**` slug lines in a screenplay, numbered beats in a
            beat sheet — and this printed the punctuation. `looksLikeMarkdown`
            is the guard for the case the prompts ask for and sometimes get:
            plain, whitespace-significant text, which a renderer would reflow. */}
        {looksLikeMarkdown(content) ? (
          <Markdown source={content} />
        ) : (
          <p className="whitespace-pre-wrap text-sm text-white/75">{content}</p>
        )}
      </div>
    </div>
  );
}

function CharactersSection({ detail }: { detail: Detail }) {
  return (
    <ul className="space-y-3">
      {detail.characters.map((character) => (
        <li key={character.id} className="text-sm">
          <p className="font-medium text-white/85">{character.name}</p>
          <Markdown source={character.description} className="mt-1" />
          {character.arc && (
            <p className="mt-1 text-white/50">
              <span className="text-white/35">Arc: </span>
              {character.arc}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function WorldBuildingSection({ detail }: { detail: Detail }) {
  return (
    <div className="space-y-4 text-sm">
      {detail.worldBuilding?.content && <Markdown source={detail.worldBuilding.content} />}
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
 * Which stages have a queued or running job right now.
 *
 * Read off `detail.jobs`, whose `type` is the stage name (`enqueue` in
 * lib/projects.ts sets `type: input.target`). Deliberately stage-level rather
 * than per-entity: the job payload that names the scoped location/prop/
 * character is not serialized to the client, and telling "being redrawn" from
 * "never drawn" does not need that precision.
 */
function runningStages(detail: Detail): Set<string> {
  return new Set(
    detail.jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).map((job) => job.type),
  );
}

/**
 * What a thumbnail shows in place of an image it does not have.
 *
 * A scoped redo nulls the row's asset pointer *before* the job runs
 * (`regenerate`, lib/projects.ts), so "no image" covers two different states
 * and they must not look alike: a re-roll that renders as "not yet generated"
 * — or, when the grid filtered these rows out entirely, as the tile silently
 * disappearing — reads as the picture having been destroyed rather than
 * redrawn. Same pulsing-amber idiom the jobs bar and the nav already use for
 * work in flight.
 */
function MissingImage({
  generating,
  label = "not yet generated",
}: {
  generating: boolean;
  /** Overridden where the grid already had its own wording for an empty tile. */
  label?: string;
}) {
  if (!generating) return <span className="text-xs text-white/40">{label}</span>;
  return (
    <span className="flex items-center gap-2 text-xs text-amber-300">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-300" />
      generating
    </span>
  );
}

/**
 * A thumbnail box at the project's own frame shape.
 *
 * Every image grid in this file was `aspect-[9/16]`, hardcoded — so a
 * landscape movie's storyboard panels, concept art, cast portraits and previs
 * were all drawn into vertical boxes and `object-cover` cropped the sides off
 * to fit. The shape is a property of the project (M7.1 PR-E), read through
 * `projectAspect` so a project created before that column existed falls back
 * to its format's shape rather than to the shorts pipeline's.
 *
 * An inline `style` rather than a Tailwind class because the value is dynamic:
 * `aspect-[${ratio}]` cannot be generated at build time, and the JIT compiler
 * would leave it unstyled.
 */
function Frame({
  aspect,
  className = "",
  children,
}: {
  aspect: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ aspectRatio: aspect }}
      className={`w-full overflow-hidden rounded-md border border-white/10 ${className}`}
    >
      {children}
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
  generating,
  onRedo,
}: {
  detail: Detail;
  busy: boolean;
  generating: boolean;
  onRedo: (scope: DevItemScope, direction: string) => void;
}) {
  // Tagged on merge: a scoped redo has to name `locationId` or `propId`
  // specifically, and a flat concat of the two arrays loses which is which.
  const entities = [
    ...detail.locations.map((entity) => ({ entity, scope: { locationId: entity.id } as DevItemScope })),
    ...detail.props.map((entity) => ({ entity, scope: { propId: entity.id } as DevItemScope })),
  ];

  const aspect = aspectCss(detail.project.aspectRatio, detail.project.format);

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {entities.map(({ entity, scope }) => (
        <figure key={entity.id} className="space-y-1.5">
          {/* Plates without an image are shown rather than filtered out: the
              filter that used to drop them also dropped the one being
              re-rolled, so a re-roll looked like the plate had been deleted. */}
          <Frame aspect={aspect} className={entity.imageAssetId ? "" : "flex items-center justify-center"}>
            {entity.imageAssetId ? (
              <img
                src={`/api/assets/${entity.imageAssetId}`}
                alt={entity.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <MissingImage generating={generating} />
            )}
          </Frame>
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
  generating,
  onRedo,
}: {
  detail: Detail;
  busy: boolean;
  generating: boolean;
  onRedo: (scope: DevItemScope, direction: string, wardrobeVariantId?: string | null) => void;
}) {
  // Labelled by character, since a variant named "Field kit" says nothing on
  // its own about whose field kit it is.
  const nameById = new Map(detail.characters.map((character) => [character.id, character.name]));
  const wardrobeOptions = (detail.wardrobeVariants ?? []).map((variant) => ({
    id: variant.id,
    label: `${nameById.get(variant.characterId) ?? "?"} — ${variant.name}`,
  }));
  const panels = [...detail.storyboardPanels].sort(compareByScene);
  const aspect = aspectCss(detail.project.aspectRatio, detail.project.format);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {panels.map((panel) => (
        <figure key={panel.id} className="space-y-1.5">
          <Frame aspect={aspect} className={panel.panelImageAssetId ? "" : "flex items-center justify-center"}>
            {panel.panelImageAssetId ? (
              <img
                src={`/api/assets/${panel.panelImageAssetId}`}
                alt={`Scene ${panel.sceneId}, beat ${panel.index + 1}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <MissingImage generating={generating} />
            )}
          </Frame>
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
function ShotListSection({ detail, generating }: { detail: Detail; generating: boolean }) {
  const items = [...detail.shotListItems].sort(compareByScene);
  const aspect = aspectCss(detail.project.aspectRatio, detail.project.format);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <figure key={item.id} className="space-y-1.5">
          <Frame aspect={aspect} className={item.keyframeAssetId ? "" : "flex items-center justify-center"}>
            {item.keyframeAssetId ? (
              <img
                src={`/api/assets/${item.keyframeAssetId}`}
                alt={`Scene ${item.sceneId}, shot ${item.index + 1}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <MissingImage generating={generating} label="no keyframe" />
            )}
          </Frame>
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
        style={{ aspectRatio: aspectCss(detail.project.aspectRatio, detail.project.format) }}
        className="w-full max-w-lg rounded-md border border-white/10 bg-black"
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
  busy,
  generating,
  onUnlockCasting,
  onRedo,
}: {
  detail: Detail;
  busy: boolean;
  generating: boolean;
  onUnlockCasting: (characterId: string) => void;
  onRedo: (scope: DevItemScope, direction: string) => void;
}) {
  // Not filtered to those with a portrait, unlike before: a redo clears
  // `imageAssetId` first, so filtering here removed the very portrait the
  // user had just asked to re-roll (and, for a one-character project, the
  // whole section with it).
  const cast = detail.characters;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {cast.map((character) => {
        const lockReason = castingLockReason(character);
        return (
          <figure key={character.id} className="space-y-1.5">
            {/* Square, not the project's shape: a cast portrait is reference
                material generated at `REFERENCE_IMAGE_*` (512x512) and never
                reaches a frame — see that env var's own comment in config.ts. */}
            <Frame
              aspect="1 / 1"
              className={character.imageAssetId ? "" : "flex items-center justify-center"}
            >
              {character.imageAssetId ? (
                <img
                  src={`/api/assets/${character.imageAssetId}`}
                  alt={character.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <MissingImage generating={generating} />
              )}
            </Frame>
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
            {/* The second half of "unlock, then redo" (`unlockCasting`'s own
                doc comment, lib/projects.ts). Only one of the two shows at a
                time, and the re-roll is the one gated on being unlocked:
                `regenerate()` hard-refuses a locked character's portrait redo
                server-side, so offering the control while locked would be a
                button whose only outcome is an error (BUG-29). */}
            {lockReason ? (
              <div>
                <p className="text-[11px] text-amber-300">{lockReason}</p>
                <button
                  onClick={() => onUnlockCasting(character.id)}
                  className="mt-1 rounded border border-amber-300/40 px-2 py-0.5 text-[11px] text-amber-300 transition hover:bg-amber-300/10"
                >
                  Unlock
                </button>
              </div>
            ) : (
              <RerollControl
                busy={busy}
                onRedo={(direction) => onRedo({ characterId: character.id }, direction)}
              />
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

/**
 * Scene order, numerically.
 *
 * `sceneId` here is the identifier the scene-breakdown stage assigned ("1",
 * "2", "10", sometimes "3A") — not a UUID. Sorting it with `localeCompare` put
 * scene 10 between 1 and 2, so a movie with ten or more scenes listed its
 * storyboards and shots in an order that was not the order of the film.
 */
function compareByScene<T extends { sceneId: string; index: number }>(a: T, b: T): number {
  if (a.sceneId !== b.sceneId) {
    const left = Number.parseInt(a.sceneId, 10);
    const right = Number.parseInt(b.sceneId, 10);
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    // Same leading number ("3" vs "3A"), or not numeric at all: fall back to a
    // natural-order string compare so the ordering is at least stable.
    return a.sceneId.localeCompare(b.sceneId, undefined, { numeric: true });
  }
  return a.index - b.index;
}
