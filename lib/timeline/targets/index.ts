/**
 * The registry of production targets.
 *
 * Adding Wan or Minimax later is a file next to `ltx-director.ts` and an entry
 * here — no schema change, no UI change, because the review surface reads
 * `label` and `constraints` off whatever this returns rather than knowing any
 * target by name.
 *
 * Only targets we can actually describe from evidence belong here. A
 * constraint profile guessed from a model card would be exactly the mistake
 * finding F11 is the worked example of: a capability ruled in or out from
 * stale metadata instead of a run.
 */

import { ltxDirectorTarget, LTX_DIRECTOR_TARGET_ID } from "./ltx-director";
import type { TimelineTarget } from "../types";

export const TIMELINE_TARGETS: readonly TimelineTarget[] = [ltxDirectorTarget];

export const DEFAULT_TIMELINE_TARGET_ID = LTX_DIRECTOR_TARGET_ID;

/** Every registered id, for the schema enum and the target picker. */
export const TIMELINE_TARGET_IDS = TIMELINE_TARGETS.map((target) => target.id);

export function findTarget(id: string): TimelineTarget | undefined {
  return TIMELINE_TARGETS.find((target) => target.id === id);
}

/** As `findTarget`, but a stored id that no longer resolves is a real problem. */
export function resolveTarget(id: string): TimelineTarget {
  const target = findTarget(id);
  if (!target) {
    throw new Error(`No such timeline target: ${id} (have ${TIMELINE_TARGET_IDS.join(", ")})`);
  }
  return target;
}

export { ltxDirectorTarget, LTX_DIRECTOR_TARGET_ID };
export type { LtxDirectorPayload, LtxTimelineData } from "./ltx-director";
