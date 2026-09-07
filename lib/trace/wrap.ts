import type { ImageBackend, ImageRequest, GenerateOptions, VideoBackend, VideoRequest } from "../backends/types";
import { parseJsonResponse, type ChatClient, type ChatOptions } from "../sdapi/llm";
import type { TraceProvider, TraceSink } from "./sink";

/**
 * Decorate a chat client so every request it makes is recorded.
 *
 * Delegation rather than a subclass: `LlmClient` holds its transport and its
 * chat path privately, and the point of `ChatClient` is that the thing a stage
 * talks to does not have to be an `LlmClient` at all.
 *
 * `chatJson` is reimplemented here on top of `chat` rather than delegated,
 * because delegating would run the base class's own `chat` — invisible to this
 * wrapper — and the raw text would be gone by the time it returned. That text
 * is the single most useful thing in the trace: "the model returned prose
 * where an object was asked for" and "the model returned an object with the
 * wrong keys" look identical from the parsed side, and only one of them is
 * fixed by editing the prompt.
 */
export function tracingChatClient(
  base: ChatClient,
  sink: TraceSink,
  meta: { provider: TraceProvider; requestPath: string },
): ChatClient {
  function describe(options: ChatOptions): { prompt: string; request: Record<string, unknown> } {
    return {
      prompt: options.messages.map((m) => m.content).join("\n"),
      request: {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? null,
        maxTokens: options.maxTokens ?? null,
        json: options.json ?? false,
      },
    };
  }

  return {
    async chat(options) {
      const { prompt, request } = describe(options);
      const startedAt = Date.now();
      try {
        const result = await base.chat(options);
        sink.record({
          kind: "llm",
          operation: "chat",
          provider: meta.provider,
          requestPath: meta.requestPath,
          prompt,
          request,
          response: result.content,
          responseMeta: { completionTokens: result.completionTokens },
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        sink.record({
          kind: "llm",
          operation: "chat",
          provider: meta.provider,
          requestPath: meta.requestPath,
          prompt,
          request,
          ok: false,
          error: message(error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },

    async chatJson<T>(options: ChatOptions): Promise<T> {
      const jsonOptions = { ...options, json: true };
      const { prompt, request } = describe(jsonOptions);
      const startedAt = Date.now();
      // Held outside the try so the failure path can record what came back
      // when it was the *parse* that failed rather than the request.
      let content: string | undefined;
      let completionTokens: number | undefined;
      try {
        const result = await base.chat(jsonOptions);
        content = result.content;
        completionTokens = result.completionTokens;
        const parsed = parseJsonResponse<T>(result.content);
        sink.record({
          kind: "llm",
          operation: "chatJson",
          provider: meta.provider,
          requestPath: meta.requestPath,
          prompt,
          request,
          response: content,
          responseMeta: { completionTokens },
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return parsed;
      } catch (error) {
        sink.record({
          kind: "llm",
          operation: "chatJson",
          provider: meta.provider,
          requestPath: meta.requestPath,
          prompt,
          request,
          response: content,
          ...(completionTokens === undefined ? {} : { responseMeta: { completionTokens } }),
          ok: false,
          error: message(error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

/**
 * Decorate an image backend so every generation is recorded.
 *
 * `uploadReference`/`hasReference`/`referenceCapacity` pass straight through:
 * they carry no prompt and no configuration, and a trace of them would be
 * noise between the rows that matter.
 */
export function tracingImageBackend(
  base: ImageBackend,
  sink: TraceSink,
  provider: TraceProvider,
): ImageBackend {
  return {
    label: base.label,
    referenceCapacity: () => base.referenceCapacity(),
    uploadReference: (bytes, filename) => base.uploadReference(bytes, filename),
    hasReference: (name) => base.hasReference(name),

    async generate(request: ImageRequest, options: GenerateOptions = {}): Promise<Buffer> {
      let resolved: Record<string, unknown> | undefined;
      const traced: GenerateOptions = {
        ...options,
        onResolved: (detail) => {
          resolved = detail;
          options.onResolved?.(detail);
        },
      };

      const startedAt = Date.now();
      try {
        const bytes = await base.generate(request, traced);
        sink.record({
          kind: "image",
          operation: "generate",
          provider,
          prompt: request.prompt,
          request: { ...request },
          resolved,
          responseMeta: { bytes: bytes.length },
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return bytes;
      } catch (error) {
        sink.record({
          kind: "image",
          operation: "generate",
          provider,
          prompt: request.prompt,
          request: { ...request },
          resolved,
          ok: false,
          error: message(error),
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    },
  };
}

/** `tracingImageBackend`'s counterpart for video, which prompts the same way. */
export function tracingVideoBackend(
  base: VideoBackend,
  sink: TraceSink,
  provider: TraceProvider,
): VideoBackend {
  return {
    label: base.label,

    async generate(request: VideoRequest, options: GenerateOptions = {}): Promise<Buffer> {
      let resolved: Record<string, unknown> | undefined;
      const traced: GenerateOptions = {
        ...options,
        onResolved: (detail) => {
          resolved = detail;
          options.onResolved?.(detail);
        },
      };

      const startedAt = Date.now();
      const record = (extra: Partial<Parameters<TraceSink["record"]>[0]>, startedAtMs: number) =>
        sink.record({
          kind: "video",
          operation: "generate",
          provider,
          prompt: request.prompt,
          request: summariseVideoRequest(request),
          resolved,
          ok: true,
          durationMs: Date.now() - startedAtMs,
          ...extra,
        });

      try {
        const bytes = await base.generate(request, traced);
        record({ responseMeta: { bytes: bytes.length } }, startedAt);
        return bytes;
      } catch (error) {
        record({ ok: false, error: message(error) }, startedAt);
        throw error;
      }
    },
  };
}

/**
 * A `VideoRequest` carries the driving frame and the narration as raw
 * `Buffer`s. Serialising those into the trace would put a megabyte of base64
 * in every row and tell nobody anything — the filename and the size are the
 * whole of what is worth knowing.
 */
function summariseVideoRequest(request: VideoRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    params: request.params,
    image: request.image ? { filename: request.image.filename, bytes: request.image.bytes.length } : null,
    audio: request.audio ? { filename: request.audio.filename, bytes: request.audio.bytes.length } : null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
