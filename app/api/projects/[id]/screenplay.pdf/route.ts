import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { devArtifacts, projects } from "@/lib/db/schema";
import { parseScreenplay } from "@/lib/pipeline/dev";
import { renderScreenplayPdf } from "@/lib/screenplay-pdf";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * The approved screenplay's exportable PDF (M7 PR4).
 *
 * 404s cleanly — same convention as app/api/assets/[id]/route.ts — when the
 * project doesn't exist or hasn't reached an *approved* screenplay yet,
 * rather than a raw 500 from `parseScreenplay` throwing on `undefined`. The
 * content is re-parsed here rather than trusted from storage: it was
 * validated once at generation time (`runScreenplay` in lib/pipeline/dev.ts),
 * but this route has no way to know that validation hasn't drifted from what
 * `renderScreenplayPdf` needs, and re-parsing is cheap.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return NextResponse.json({ error: "No such project" }, { status: 404 });

  const screenplay = db
    .select()
    .from(devArtifacts)
    .where(and(eq(devArtifacts.projectId, id), eq(devArtifacts.stage, "screenplay")))
    .orderBy(desc(devArtifacts.version))
    .get();

  if (!screenplay || !screenplay.approvedAt) {
    return NextResponse.json({ error: "No approved screenplay yet for this project" }, { status: 404 });
  }

  const script = parseScreenplay(screenplay.content);
  const pdf = await renderScreenplayPdf(script, {
    title: project.title ?? project.idea,
    idea: project.idea,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.byteLength),
      "content-disposition": `inline; filename="screenplay-${id}.pdf"`,
    },
  });
}
