import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../config";
import type { Db } from "../db/client";
import type { Job } from "../queue";
import type { StageContext } from "./context";
import type { ImageBackend, VideoBackend } from "../backends/types";

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
  onChatJsonRequest?: (request: Record<string, unknown>) => void;
  /** Same as `onChatJsonRequest`, for the plain-text `llm.chat` path — lets a
   * test assert which provider's `model` a stage resolved and sent, not just
   * that output exists (M7 PR3's provider-resolution acceptance bar). */
  onChatRequest?: (request: Record<string, unknown>) => void;
  shouldAbort?: () => boolean;
  /** Override the throwaway data directory, e.g. to assert on written files. */
  dataDir?: string;
  /** Canned speech result; `audio` defaults to a minimal valid WAV. */
  speech?: { audio?: Buffer; durationMs: number };
  onSpeechRequest?: (request: Record<string, unknown>) => void;
  /** Canned transcript words, already in milliseconds. */
  transcript?: { word: string; startMs: number; endMs: number }[];
  onTranscribeRequest?: (request: Record<string, unknown>) => void;
  /** Override the host's answer to "is this reference still there", per name. */
  hasInput?: (name: string) => boolean | Promise<boolean>;
  /**
   * How many reference slots the stubbed image backend exposes. Defaults to
   * unlimited, matching sd-api; set it to exercise the crowded-scene warning.
   */
  referenceCapacity?: number;
  /** Bytes returned by each video generation, in order. */
  videos?: Buffer[];
  onVideoRequest?: (request: Record<string, unknown>) => void;
  /** Observe what a stage logs, e.g. to assert on a warn-level message. */
  onLog?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
};

/** A 16-bit mono WAV header with no samples — enough to parse a sample rate. */
export function silentWav(sampleRate = 24_000): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

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

  const imageBackend: ImageBackend = {
    label: "stub-image",
    referenceCapacity: () => options.referenceCapacity ?? Number.POSITIVE_INFINITY,
    generate: async (request) => {
      options.onImageRequest?.(request as unknown as Record<string, unknown>);
      const bytes = images[Math.min(imageIndex, images.length - 1)];
      imageIndex++;
      return bytes ?? Buffer.from("png");
    },
    uploadReference: async (_bytes: Buffer, filename: string) => `uploaded-${filename}`,
    hasReference: async (name: string) => (options.hasInput ? options.hasInput(name) : true),
  };

  let videoIndex = 0;
  const videoBackend: VideoBackend = {
    label: "stub-video",
    generate: async (request) => {
      options.onVideoRequest?.(request as unknown as Record<string, unknown>);
      const bytes = (options.videos ?? [])[Math.min(videoIndex, (options.videos ?? []).length - 1)];
      videoIndex++;
      return bytes ?? Buffer.from("mp4");
    },
  };

  const llmClient: StageContext["llmClient"] = () =>
    ({
      chat: async (request: Record<string, unknown>) => {
        options.onChatRequest?.(request);
        return { content: nextLlm().content ?? "", completionTokens: 10 };
      },
      chatJson: async (request: Record<string, unknown>) => {
        options.onChatJsonRequest?.(request);
        return nextLlm().json;
      },
    }) as unknown as ReturnType<StageContext["llmClient"]>;

  return {
    db,
    config: resolveConfig({ VICEROY_DATA_DIR: options.dataDir ?? scratchDataDir() }),
    job,
    imageBackend: () => imageBackend,
    videoBackend: () => videoBackend,
    // Ignores which provider it was asked for: stages exercise routing via
    // `onChatRequest`/`onChatJsonRequest` asserting the right `model` was
    // sent, not via which host the call reached — no test may reach a real
    // model, so there is only ever one (canned) client to hand back.
    llmClient,
    log: (message, level) => options.onLog?.(message, level),
    progress: () => {},
    shouldAbort: options.shouldAbort ?? (() => false),
    sdApi: {
      llm: {
        chat: async (request: Record<string, unknown>) => {
          options.onChatRequest?.(request);
          return { content: nextLlm().content ?? "", completionTokens: 10 };
        },
        chatJson: async (request: Record<string, unknown>) => {
          options.onChatJsonRequest?.(request);
          return nextLlm().json;
        },
      },
      image: {
        generate: async (request: Record<string, unknown>) => {
          options.onImageRequest?.(request);
          const bytes = images[Math.min(imageIndex, images.length - 1)];
          imageIndex++;
          return bytes ?? Buffer.from("png");
        },
        uploadInput: async (_bytes: Buffer, filename: string) => `uploaded-${filename}`,
        hasInput: async (name: string) => (options.hasInput ? options.hasInput(name) : true),
      },
      audio: {
        speech: async (request: Record<string, unknown>) => {
          options.onSpeechRequest?.(request);
          return {
            audio: options.speech?.audio ?? silentWav(),
            durationMs: options.speech?.durationMs ?? 10_000,
          };
        },
        transcribeWords: async (request: Record<string, unknown>) => {
          options.onTranscribeRequest?.(request);
          return { words: options.transcript ?? [], text: "" };
        },
      },
      http: {},
      health: async () => true,
    } as unknown as StageContext["sdApi"],
  };
}
