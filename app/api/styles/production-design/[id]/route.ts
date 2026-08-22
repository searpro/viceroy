import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  deleteProductionDesignStyle,
  productionDesignStyleSchema,
  updateProductionDesignStyle,
} from "@/lib/styles";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const parsed = productionDesignStyleSchema.partial().safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ style: updateProductionDesignStyle(getDb(), id, parsed.data) });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    deleteProductionDesignStyle(getDb(), id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 400 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
