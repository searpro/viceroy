import { NextResponse } from "next/server";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { describeVideoError } from "@/lib/video/client";
import { resolveVideoClient } from "@/lib/video/provider";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * Proxy the finished MP4.
 *
 * The browser cannot fetch it from the video host directly: that host is
 * reached with the provider row's base URL and API key, neither of which
 * belongs in a page. Proxying also keeps the key server-side, the same reason
 * `listProviders` redacts it.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { video } = resolveVideoClient(getDb(), resolveConfig());
    const bytes = await video.fetchContent(id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(bytes.length),
        "content-disposition": `inline; filename="${id}.mp4"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: describeVideoError(error) }, { status: 502 });
  }
}
