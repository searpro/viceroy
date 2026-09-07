import type { Config } from "../config";
import { createComfyClient } from "../comfy/client";
import type { Db } from "../db/client";
import type { WorkflowRole } from "../db/schema";
import { resolveProvider, type LlmProviderRef } from "../pipeline/context";
import {
  createSdApi,
  LlmClient,
  OPENAI_COMPATIBLE_CHAT_PATH,
  SD_API_CHAT_PATH,
  type ChatClient,
  type SdApi,
} from "../sdapi";
import { NO_TRACE, tracingChatClient, tracingImageBackend, tracingVideoBackend, type TraceSink } from "../trace";
import { resolveWorkflow } from "../workflows";
import { comfyImageBackend } from "./comfy-image";
import { comfyVideoBackend } from "./comfy-video";
import { sdApiImageBackend } from "./sdapi-image";
import type { ImageBackend, VideoBackend } from "./types";

/**
 * Build the backend for whichever provider is in force.
 *
 * Resolved per job rather than once at startup, so a provider switched in the
 * admin UI takes effect on the next job without restarting the worker — which
 * is what the old `resolveSdApi` special case in the worker did for image
 * providers specifically, generalised now that it is no longer a special case.
 */
export function resolveImageBackend(
  db: Db,
  config: Config,
  base?: SdApi,
  sink: TraceSink = NO_TRACE,
): ImageBackend {
  const provider = resolveProvider(db, "image");
  // Wrapped here rather than at the worker's `ctx.imageBackend` because this
  // is the only place that holds the provider row the backend was built from.
  // Doing it a layer up would mean resolving the same row a second time and
  // hoping the two agreed.
  const trace = (backend: ImageBackend): ImageBackend =>
    tracingImageBackend(backend, sink, {
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      model: provider.model,
      baseUrl: provider.baseUrl,
    });

  if (provider.adapter === "comfyui") {
    const client = createComfyClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? undefined,
      service: provider.name,
      timeoutMs: config.sdApiTimeoutMs,
    });
    return trace(
      comfyImageBackend({
        client,
        provider,
        workflowFor: (role) => resolveWorkflow(db, provider.id, role),
      }),
    );
  }

  // Reuse the worker's long-lived client when this provider is the same host
  // it was built for; a different base URL needs its own.
  const sdApi =
    base && provider.baseUrl.replace(/\/$/, "") === config.sdApiUrl
      ? base
      : createSdApi({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? undefined,
          timeoutMs: config.sdApiTimeoutMs,
        });

  return trace(sdApiImageBackend(sdApi, provider));
}

/**
 * Build the LLM client for a given provider row.
 *
 * `resolveProvider`/`resolveDevProvider` in `pipeline/context.ts` pick *which*
 * row an LLM stage should use, but every stage was then reaching for the
 * worker's single long-lived `ctx.sdApi` client regardless — a client bound
 * once, at startup, to `config.sdApiUrl`. That silently dropped a provider's
 * own `baseUrl`/`apiKey`, so pointing an "llm" row anywhere but the local
 * sd-api host (BUG-28: a Gemini row via its OpenAI-compatible endpoint) sent
 * the request to local sd-api with a model name it had never heard of.
 *
 * Mirrors `resolveImageBackend`'s host comparison: reuse the worker's
 * long-lived client when the provider is the same host it was built for, and
 * build a one-off client when it isn't.
 *
 * A different host is a genuine external OpenAI-compatible provider, not
 * another sd-api install (ADR 0004: LLM stays sd-api-only as a stored
 * "kind" — this is decided purely by baseUrl, not a provider field), so it
 * gets the plain top-level chat-completions path instead of sd-api's own
 * `/v1/llm` reverse-proxy namespace.
 */
export function buildLlmClient(provider: LlmProviderRef, config: Config, base: SdApi): LlmClient {
  if (provider.baseUrl.replace(/\/$/, "") === config.sdApiUrl) {
    return base.llm;
  }
  const sdApi = createSdApi({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    timeoutMs: config.sdApiTimeoutMs,
  });
  return new LlmClient(sdApi.http, OPENAI_COMPATIBLE_CHAT_PATH);
}

/**
 * `buildLlmClient`, plus the trace record.
 *
 * Split in two so the routing above stays directly assertable: BUG-28's
 * regression test reaches past `LlmClient`'s type for the host and path it
 * ended up bound to, and a decorated client has neither. Stages take this
 * one; nothing but the test takes the other.
 */
export function resolveLlmClient(
  provider: LlmProviderRef,
  config: Config,
  base: SdApi,
  sink: TraceSink = NO_TRACE,
): ChatClient {
  const local = provider.baseUrl.replace(/\/$/, "") === config.sdApiUrl;

  return tracingChatClient(buildLlmClient(provider, config, base), sink, {
    provider: {
      id: provider.id ?? null,
      name: provider.name ?? "",
      model: provider.model ?? "",
      baseUrl: provider.baseUrl,
    },
    // Recorded because it is the difference this function exists to make, and
    // it is invisible from anywhere else: the same provider row talking to the
    // wrong one of these two paths is exactly BUG-28's failure.
    requestPath: local ? SD_API_CHAT_PATH : OPENAI_COMPATIBLE_CHAT_PATH,
  });
}

export function resolveVideoBackend(
  db: Db,
  config: Config,
  sink: TraceSink = NO_TRACE,
): VideoBackend {
  const provider = resolveProvider(db, "video");

  if (provider.adapter !== "comfyui") {
    // vllm-omni was retired in favour of ComfyUI, which serves both Wan
    // image-to-video and speech-to-video from the same host. A row left on the
    // old adapter cannot generate, and saying so here beats a 404 against a
    // host that is no longer running.
    throw new Error(
      `Video provider "${provider.name}" uses the ${provider.adapter} adapter, which no longer ` +
        `serves video — point it at a ComfyUI host on the Providers screen`,
    );
  }

  const client = createComfyClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    service: provider.name,
    timeoutMs: config.sdApiTimeoutMs,
  });

  return tracingVideoBackend(
    comfyVideoBackend({
      client,
      provider,
      workflowFor: (role: WorkflowRole) => resolveWorkflow(db, provider.id, role),
    }),
    sink,
    {
      id: provider.id,
      name: provider.name,
      adapter: provider.adapter,
      model: provider.model,
      baseUrl: provider.baseUrl,
    },
  );
}
