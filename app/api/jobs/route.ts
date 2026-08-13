import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { listAllJobs } from "@/lib/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ jobs: listAllJobs(getDb()) });
}
