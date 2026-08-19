import type { Config } from "../config";
import type { Db } from "../db/client";
import { resolveProvider } from "../pipeline/context";
import { VideoClient, createVideoApi } from "./client";

/**
 * The configured video provider, and a client pointed at it.
 *
 * Goes through `resolveProvider` rather than querying the table directly so
 * "which row is in force" means the same thing here as it does for every other
 * kind: the one marked default, else any row of that kind.
 */
export function resolveVideoClient(
  db: Db,
  config: Config,
): { provider: ReturnType<typeof resolveProvider>; video: VideoClient } {
  const provider = resolveProvider(db, "video");
  return {
    provider,
    video: createVideoApi({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? undefined,
      // So a failure names the video host rather than reading as an sd-api
      // fault and sending whoever reads it to the wrong machine.
      service: provider.name,
      // Per-request ceiling, not per-generation: create, poll and download are
      // each short, and the generation itself is spanned by many polls.
      timeoutMs: config.sdApiTimeoutMs,
    }),
  };
}
