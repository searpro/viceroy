import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { createWorkflow, listWorkflows, workflowSchema } from "@/lib/workflows";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const providerId = new URL(request.url).searchParams.get("providerId") ?? undefined;
  return NextResponse.json({ workflows: listWorkflows(getDb(), providerId) });
}

export async function POST(request: Request) {
  const parsed = workflowSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ workflow: createWorkflow(getDb(), parsed.data) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
