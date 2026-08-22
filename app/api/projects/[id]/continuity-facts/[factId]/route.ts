import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { resolveContinuityFact } from "@/lib/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; factId: string }> };

/**
 * Resolve one continuity fact — sets `resolvedAt` (and flips `source` to
 * "resolved") without deleting or touching whatever fact it conflicted with,
 * per the M7 detail page's "a human approves or corrects — never silent
 * auto-resolution" and this PR's own acceptance bar. PR7 has no bespoke
 * conflict-resolution screen (see the M7 detail page's own "no UI review
 * surface beyond a flat list" scope for this stage) — `DevChainHistory`'s
 * flat list (dev-chain-card.tsx) is the one caller.
 */
export async function PATCH(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId, factId } = await params;
  try {
    const fact = resolveContinuityFact(getDb(), projectId, factId);
    return NextResponse.json({ fact });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
