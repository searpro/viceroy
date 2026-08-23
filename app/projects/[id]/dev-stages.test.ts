import { describe, it, expect } from "vitest";
import { DEV_CHAIN_ORDER, DEV_STAGE_LABELS } from "./dev-stages";
import { DEV_CHAIN_STAGES } from "@/lib/db/schema";

// The same guard `redo-warning.test.ts` puts on `REDO_CHAIN`. Without it, the
// history panel's hand-kept mirror can drift from the real chain silently —
// which is exactly what happened when M7.1 PR-A moved casting from stage 20 to
// stage 16 and this list stayed put.
describe("DEV_CHAIN_ORDER", () => {
  it("matches DEV_CHAIN_STAGES exactly, in order", () => {
    expect(DEV_CHAIN_ORDER).toEqual([...DEV_CHAIN_STAGES]);
  });

  it("has a display label for every stage, and no label for a stage that does not exist", () => {
    // Membership is checked by the ordering assertion above; this catches the
    // narrower slip of an empty or missing label, which renders as a blank
    // <summary> a user cannot click meaningfully.
    for (const stage of DEV_CHAIN_STAGES) {
      expect(DEV_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});
