import { getDb } from "@/lib/db/client";
import { listProviders } from "@/lib/providers";
import { VideoView } from "./video-view";

export const dynamic = "force-dynamic";

export default async function VideoPage() {
  // Redacted rows: the base URL is worth showing so it is obvious which host a
  // generation went to, but the API key never leaves the server.
  const provider = listProviders(getDb()).find((p) => p.kind === "video") ?? null;
  return <VideoView provider={provider} />;
}
