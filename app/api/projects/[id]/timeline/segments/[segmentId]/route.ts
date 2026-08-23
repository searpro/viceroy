import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { timelineSegmentPatchSchema, updateTimelineSegment } from "@/lib/timeline/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; segmentId: string }> };

/**
 * Edit one timeline segment (M7.2).
 *
 * Returns the whole rebuilt `Timeline`, not the patched segment: editing a
 * duration reflows every later segment's derived `startMs`, so a response
 * carrying one row would leave the screen showing timecodes that are no
 * longer true.
 *
 * Structural changes — add, delete, reorder, split — are deliberately absent.
 * The segment set stays 1:1 with the shot list, which keeps "redo the shot
 * list" the single answer to "which shots exist" and means an upstream redo
 * has one obvious consequence instead of a reconciliation problem.
 */
export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId, segmentId } = await params;
  const body = await request.json().catch(() => null);

  const parsed = timelineSegmentPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({
      timeline: updateTimelineSegment(getDb(), projectId, segmentId, parsed.data),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
