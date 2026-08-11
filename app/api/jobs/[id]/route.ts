import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getJob, getJobLogs, remove, requestAbort, retry } from "@/lib/queue";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const actionSchema = z.object({ action: z.enum(["abort", "retry"]) });

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const job = getJob(db, id);
  if (!job) return NextResponse.json({ error: "No such job" }, { status: 404 });
  return NextResponse.json({ job, logs: getJobLogs(db, id) });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected action abort or retry" }, { status: 400 });
  }

  try {
    const db = getDb();
    if (parsed.data.action === "abort") {
      const { aborted } = requestAbort(db, id);
      // A running job is only flagged here; the worker unwinds it at its next
      // checkpoint, so 202 is the honest status.
      return NextResponse.json({ aborted }, { status: aborted ? 200 : 202 });
    }
    return NextResponse.json({ job: retry(db, id) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  remove(getDb(), id);
  return new NextResponse(null, { status: 204 });
}
