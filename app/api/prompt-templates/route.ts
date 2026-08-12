import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { listPromptTemplates } from "@/lib/promptTemplates";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ templates: listPromptTemplates(getDb()) });
}
