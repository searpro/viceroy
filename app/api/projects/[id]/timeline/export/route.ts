import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { loadTimeline } from "@/lib/timeline/store";
import { resolveTarget } from "@/lib/timeline/targets";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * The compiled, provider-native payload for this project's timeline (M7.2).
 *
 * An export, in the same spirit as `screenplay.pdf/route.ts`: the artifact
 * leaves the app as a file a person can look at, diff, or paste into a
 * ComfyUI graph by hand. Nothing here submits it anywhere — wiring a Director
 * graph up to a running pod needs new `WorkflowVariable.binds` entries and a
 * `timeline_to_video` role, both of which M8 detail already scopes as M8's
 * work.
 *
 * `?target=` overrides the timeline's stored target, so a payload can be
 * compared across targets without changing the project.
 */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId } = await params;
  const timeline = loadTimeline(getDb(), projectId);
  if (!timeline) {
    return NextResponse.json({ error: "This project has no timeline yet" }, { status: 404 });
  }

  const requested = new URL(request.url).searchParams.get("target") ?? timeline.targetId;
  try {
    const target = resolveTarget(requested);
    return NextResponse.json({
      target: { id: target.id, label: target.label },
      issues: target.validate(timeline),
      payload: target.compile(timeline),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
