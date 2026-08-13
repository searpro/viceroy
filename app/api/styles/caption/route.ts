import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { captionStyleSchema, createCaptionStyle, listCaptionStyles } from "@/lib/styles";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ styles: listCaptionStyles(getDb()) });
}

export async function POST(request: Request) {
  const parsed = captionStyleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ style: createCaptionStyle(getDb(), parsed.data) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
