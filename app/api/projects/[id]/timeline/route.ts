import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { timelineSettingsPatchSchema, updateTimelineSettings } from "@/lib/timeline/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Edit the timeline's project-level settings (M7.2) — target, frame rate,
 * global prompt.
 *
 * Thin, with the logic in `lib/timeline/store.ts` and a 400 on a thrown
 * Error, the same shape `continuity-facts/[factId]/route.ts` established.
 * Returns the whole rebuilt `Timeline` rather than the patched row, because
 * changing the target changes which validation issues apply to every segment
 * — a client that merged one row back would be looking at a stale screen.
 */
export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId } = await params;
  const body = await request.json().catch(() => null);

  const parsed = timelineSettingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ timeline: updateTimelineSettings(getDb(), projectId, parsed.data) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
