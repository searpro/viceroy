/**
 * The Development chain's stage order and labels.
 *
 * Moved to `lib/labels.ts` (which the jobs screen, the nav and the "next"
 * banner all need too) and re-exported here so the existing import sites and
 * `dev-stages.test.ts`'s drift guard keep pointing at one place. The guard is
 * the reason this file still exists rather than being deleted: it asserts the
 * hand-kept mirror still matches `DEV_CHAIN_STAGES` in lib/db/schema.ts, which
 * pulls in better-sqlite3 and so cannot be imported by a client bundle.
 */
export { DEV_CHAIN_ORDER, DEV_STAGE_LABELS, DEV_STAGE_PHASES, devStagePhase } from "@/lib/labels";
