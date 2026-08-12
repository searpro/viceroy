import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { continueProject, getProjectDetail, regenerate, regenerateSchema } from "@/lib/projects";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const detail = getProjectDetail(getDb(), id);
  if (!detail) return NextResponse.json({ error: "No such project" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  // "Approve and continue" in manual mode, and the way out of a stalled
  // project: the server decides what runs next, so no screen has to encode
  // the pipeline's order.
  if (body && typeof body === "object" && (body as { action?: string }).action === "continue") {
    try {
      return NextResponse.json({ step: continueProject(getDb(), id) }, { status: 202 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  const parsed = regenerateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ job: regenerate(getDb(), id, parsed.data) }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
