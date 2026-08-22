"use client";

import { Panel } from "./steps/panel";
import { ContinueBanner } from "./continue-banner";
import type { Detail } from "./detail-types";

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
}: {
  detail: Detail;
  active: boolean;
  busy: boolean;
  onContinue: () => void;
  onResolveContinuityFact: (factId: string) => void;
}) {
  const { nextStep } = detail;

  if (nextStep.kind === "complete") {
    return (
      <div>
        <Panel title="Development" empty={false} emptyText="">
          <p className="text-sm text-white/85">{nextStep.reason}</p>
        </Panel>
        <DevChainHistory detail={detail} onResolveContinuityFact={onResolveContinuityFact} />
      </div>
    );
  }

  const stage = nextStep.kind === "dev" ? nextStep.stage : undefined;

  return (
    <div>
      <ContinueBanner detail={detail} active={active} busy={busy} onContinue={onContinue} />

      <Panel title={stage ?? "Development"} empty emptyText="Not yet generated.">
        <></>
      </Panel>
      <DevChainHistory detail={detail} onResolveContinuityFact={onResolveContinuityFact} />
    </div>
  );
}

// Mirrors `DEV_CHAIN_STAGES` in lib/db/schema.ts — hand-kept rather than
// imported, same as `PROJECT_FORMATS` in new-project-form.tsx, since
// lib/db/schema.ts pulls in better-sqlite3 and isn't safe in a client bundle.
const DEV_STAGE_LABELS: Record<string, string> = {
  concept: "Concept",
  logline: "Logline",
  characters: "Characters & arcs",
  world_building: "World building",
  story_structure: "Story structure",
  beat_sheet: "Beat sheet",
  treatment: "Treatment",
  screenplay: "Screenplay",
  screenplay_revision: "Screenplay revision",
  story_bible: "Story bible",
  script_breakdown: "Script breakdown",
  scene_breakdown: "Scene breakdown",
  continuity: "Continuity",
  visual_bible: "Visual bible",
  production_design: "Production design",
  concept_art: "Concept art",
  storyboards: "Storyboards",
  shot_list: "Shot list",
  previs: "Previs",
};
const DEV_CHAIN_ORDER = Object.keys(DEV_STAGE_LABELS);

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
  onResolveContinuityFact,
}: {
  detail: Detail;
  onResolveContinuityFact: (factId: string) => void;
}) {
  const byStage = new Map(detail.devArtifacts.map((row) => [row.stage, row]));
  const hasCharacters = detail.characters.length > 0;
  const hasWorld = Boolean(detail.worldBuilding?.content) || detail.locations.length > 0 || detail.props.length > 0;
  const hasContinuity = detail.continuityFacts.length > 0;
  const hasConceptArt = [...detail.locations, ...detail.props].some((entity) => entity.imageAssetId);
  const hasStoryboards = detail.storyboardPanels.length > 0;
  const hasShotList = detail.shotListItems.length > 0;
  const hasPrevis = Boolean(detail.project.previsAssetId);

  const stagesWithContent = DEV_CHAIN_ORDER.filter((stage) => {
    if (stage === "characters") return hasCharacters;
    if (stage === "world_building") return hasWorld;
    if (stage === "continuity") return hasContinuity;
    if (stage === "concept_art") return hasConceptArt;
    if (stage === "storyboards") return hasStoryboards;
    if (stage === "shot_list") return hasShotList;
    if (stage === "previs") return hasPrevis;
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
                <ConceptArtSection detail={detail} />
              ) : stage === "storyboards" ? (
                <StoryboardsSection detail={detail} />
              ) : stage === "shot_list" ? (
                <ShotListSection detail={detail} />
              ) : stage === "previs" ? (
                <PrevisSection detail={detail} />
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

// M7 PR9. The one stage in this history panel whose output is images rather
// than text — every location/prop that has one gets a thumbnail, not just a
// name in a list, since that's the entire point of reviewing this stage.
function ConceptArtSection({ detail }: { detail: Detail }) {
  const withImages = [...detail.locations, ...detail.props].filter((entity) => entity.imageAssetId);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {withImages.map((entity) => (
        <figure key={entity.id} className="space-y-1.5">
          <img
            src={`/api/assets/${entity.imageAssetId}`}
            alt={entity.name}
            className="aspect-[9/16] w-full rounded-md border border-white/10 object-cover"
          />
          <figcaption className="text-xs text-white/60">{entity.name}</figcaption>
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
function StoryboardsSection({ detail }: { detail: Detail }) {
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
