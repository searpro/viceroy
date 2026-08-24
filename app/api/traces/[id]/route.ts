import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getTraceCall } from "@/lib/trace";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * One trace in full — the whole prompt, the whole raw response.
 *
 * A separate request from the list on purpose: these are the two fields the
 * list deliberately truncates, and a screenplay revision's response alone can
 * outweigh a page of everything else.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const trace = getTraceCall(getDb(), id);
  if (!trace) return NextResponse.json({ error: "No such trace" }, { status: 404 });
  return NextResponse.json({ trace });
}
