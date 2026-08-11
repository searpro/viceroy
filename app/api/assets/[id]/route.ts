import fs from "node:fs";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { assets } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset = getDb().select().from(assets).where(eq(assets.id, id)).get();
  if (!asset) return NextResponse.json({ error: "No such asset" }, { status: 404 });

  // The row can outlive the file — a cleared data directory, a half-finished
  // write — and a 404 is a great deal easier to diagnose than an ENOENT crash
  // inside the image element.
  if (!fs.existsSync(asset.path)) {
    return NextResponse.json({ error: `Asset file is missing: ${asset.path}` }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(fs.readFileSync(asset.path)), {
    headers: {
      "content-type": asset.mimeType,
      "content-length": String(asset.bytes),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
