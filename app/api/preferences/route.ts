import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { listPreferences, preferenceUpdateSchema, setPreference } from "@/lib/preferences";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ preferences: listPreferences(getDb()) });
}

export async function POST(request: Request) {
  const parsed = preferenceUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    setPreference(db, parsed.data.key, parsed.data.value);
    return NextResponse.json({ preferences: listPreferences(db) });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
