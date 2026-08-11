import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../config";
import type { Db } from "../db/client";
import type { Job } from "../queue";
import type { StageContext } from "./context";

/**
 * A throwaway data directory per stage-test context.
 *
 * Stages write real files. Pointed at `./data` — which is what
 * `resolveConfig()` defaults to — a test run scatters stub images through the
 * developer's actual outputs directory, where they are indistinguishable from
 * generated frames until someone wonders why a scene is 14 bytes.
 */
function scratchDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "viceroy-test-"));
}

export type CannedResponse = { content?: string; json?: unknown };

export type StubOptions = {
  llm?: CannedResponse[];
  /** Bytes returned by each image generation, in order. */
  images?: Buffer[];
  onImageRequest?: (request: Record<string, unknown>) => void;
  shouldAbort?: () => boolean;
  /** Override the throwaway data directory, e.g. to assert on written files. */
  dataDir?: string;
};

/**
 * A stage context whose providers are canned.
 *
 * No test may reach a real model: generation is slow, stochastic and, on a
 * cloud provider, billable. Stages take their providers by injection precisely
 * so this is possible.
 */
export function stubContext(db: Db, job: Job, options: StubOptions = {}): StageContext {
  const llm = options.llm ?? [];
  const images = options.images ?? [];
  let llmIndex = 0;
  let imageIndex = 0;

  const nextLlm = () => {
    const response = llm[Math.min(llmIndex, llm.length - 1)];
    llmIndex++;
    if (!response) throw new Error("Stub LLM was called but no response was configured");
    return response;
  };

  return {
    db,
    config: resolveConfig({ VICEROY_DATA_DIR: options.dataDir ?? scratchDataDir() }),
    job,
    log: () => {},
    progress: () => {},
    shouldAbort: options.shouldAbort ?? (() => false),
    sdApi: {
      llm: {
        chat: async () => ({ content: nextLlm().content ?? "", completionTokens: 10 }),
        chatJson: async () => nextLlm().json,
      },
      image: {
        generate: async (request: Record<string, unknown>) => {
          options.onImageRequest?.(request);
          const bytes = images[Math.min(imageIndex, images.length - 1)];
          imageIndex++;
          return bytes ?? Buffer.from("png");
        },
      },
      audio: {},
      http: {},
      health: async () => true,
    } as unknown as StageContext["sdApi"],
  };
}
