import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { unlockCasting } from "@/lib/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; characterId: string }> };

/**
 * The explicit unlock action M7 PR12's casting lock requires — a locked
 * character's portrait redo is refused (`regenerate()`, lib/projects.ts)
 * until this runs first. Its own route, not folded into the image route's
 * DELETE, since unlocking and reverting-to-generated are two different
 * actions (see that route's own DELETE, which reverts an *uploaded* photo)
 * — this one only lifts the gate, it does not itself touch the portrait.
 */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId, characterId } = await params;

  const project = getDb().select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return NextResponse.json({ error: "No such project" }, { status: 404 });
  }

  try {
    const character = unlockCasting(getDb(), projectId, characterId);
    return NextResponse.json({ character });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
