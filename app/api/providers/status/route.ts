import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { healthSummary, probeProviders } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Its own route rather than part of the page render, because probing five
 * hosts costs up to `PROBE_TIMEOUT_MS` and no screen should wait on it. The
 * nav badge fetches this after mount; the Providers screen refetches on
 * demand.
 */
export async function GET() {
  const rows = await probeProviders(getDb());
  return NextResponse.json({ providers: rows, summary: healthSummary(rows) });
}
