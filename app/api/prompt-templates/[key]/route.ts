import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  promptTemplateUpdateSchema,
  resetPromptTemplate,
  updatePromptTemplate,
} from "@/lib/promptTemplates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

export async function POST(request: Request, { params }: Params) {
  const { key } = await params;
  const body = await request.json().catch(() => null);

  if (body && typeof body === "object" && (body as { action?: string }).action === "reset") {
    try {
      return NextResponse.json({ template: resetPromptTemplate(getDb(), key) });
    } catch (error) {
      return NextResponse.json({ error: messageOf(error) }, { status: 400 });
    }
  }

  const parsed = promptTemplateUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({
      template: updatePromptTemplate(getDb(), key, parsed.data.template),
    });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
