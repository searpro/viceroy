import type { Config } from "../config";
import { createComfyClient } from "../comfy/client";
import type { Db } from "../db/client";
import type { WorkflowRole } from "../db/schema";
import { resolveProvider } from "../pipeline/context";
import {
  createSdApi,
  LlmClient,
  OPENAI_COMPATIBLE_CHAT_PATH,
  type SdApi,
} from "../sdapi";
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
export function resolveImageBackend(db: Db, config: Config, base?: SdApi): ImageBackend {
  const provider = resolveProvider(db, "image");

  if (provider.adapter === "comfyui") {
    const client = createComfyClient({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? undefined,
      service: provider.name,
      timeoutMs: config.sdApiTimeoutMs,
    });
    return comfyImageBackend({
      client,
      provider,
      workflowFor: (role) => resolveWorkflow(db, provider.id, role),
    });
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

  return sdApiImageBackend(sdApi, provider);
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
export function resolveLlmClient(
  provider: { baseUrl: string; apiKey: string | null },
  config: Config,
  base: SdApi,
): LlmClient {
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

export function resolveVideoBackend(db: Db, config: Config): VideoBackend {
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

  return comfyVideoBackend({
    client,
    provider,
    workflowFor: (role: WorkflowRole) => resolveWorkflow(db, provider.id, role),
  });
}
