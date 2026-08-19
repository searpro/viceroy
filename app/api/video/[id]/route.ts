import { NextResponse } from "next/server";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { describeVideoError } from "@/lib/video/client";
import { resolveVideoClient } from "@/lib/video/provider";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { video } = resolveVideoClient(getDb(), resolveConfig());
    return NextResponse.json({ job: await video.getJob(id) });
  } catch (error) {
    return NextResponse.json({ error: describeVideoError(error) }, { status: 502 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { video } = resolveVideoClient(getDb(), resolveConfig());
    await video.deleteJob(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: describeVideoError(error) }, { status: 502 });
  }
}
