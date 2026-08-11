import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { assets } from "./db/schema";

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
};

/**
 * Persist bytes into the configured outputs directory and record them.
 *
 * sd-api hosts what it generates, but only until its own outputs are pruned,
 * and the task runner persists nothing at all (finding F2). Viceroy therefore
 * owns every byte it intends to put in a video rather than holding a reference
 * to someone else's temporary file.
 */
export function storeAsset(
  db: Db,
  config: Config,
  params: {
    kind: "image" | "audio" | "video";
    bytes: Buffer;
    mimeType: string;
    projectId: string;
    label: string;
    meta?: Record<string, unknown>;
  },
) {
  const extension = EXTENSIONS[params.mimeType] ?? "";
  const directory = path.join(config.outputsDir, params.projectId);
  fs.mkdirSync(directory, { recursive: true });

  const filename = `${params.label}-${Date.now().toString(36)}${extension}`;
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, params.bytes);

  const [asset] = db
    .insert(assets)
    .values({
      kind: params.kind,
      path: filePath,
      mimeType: params.mimeType,
      bytes: params.bytes.byteLength,
      meta: params.meta ?? {},
    })
    .returning()
    .all();

  return asset!;
}

export function readAsset(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}
