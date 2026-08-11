import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createProject, createProjectSchema, listProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ projects: listProjects(getDb()) });
}

export async function POST(request: Request) {
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ project: createProject(getDb(), parsed.data) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
