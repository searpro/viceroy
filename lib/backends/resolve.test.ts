import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import type { TraceEntry, TraceSink } from "../trace";
import {
  createSdApi,
  OPENAI_COMPATIBLE_CHAT_PATH,
  SD_API_CHAT_PATH,
  type LlmClient,
} from "../sdapi";
import { buildLlmClient, resolveLlmClient } from "./resolve";

/** `LlmClient` doesn't expose its host/path — reach past the type for the assertion. */
function hostOf(client: LlmClient): string {
  return (client as unknown as { http: { baseUrl: string } }).http.baseUrl;
}

function pathOf(client: LlmClient): string {
  return (client as unknown as { chatPath: string }).chatPath;
}

// Regression test for BUG-28: an "llm" provider row pointed at a host other
// than the worker's default sd-api instance (e.g. Gemini's OpenAI-compatible
// endpoint) must actually be talked to at its own baseUrl/apiKey, not
// silently routed to the default host with a model name it has never heard
// of.
// Targets `buildLlmClient` rather than `resolveLlmClient`: the latter now
// returns a trace-recording decorator, which by design has no `http` or
// `chatPath` to reach for. The routing these assertions guard is unchanged
// and still lives in one function — see `resolveLlmClient`'s comment.
describe("buildLlmClient", () => {
  const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });
  const base = createSdApi({ baseUrl: config.sdApiUrl });

  it("reuses the worker's long-lived client when the provider is the same host", () => {
    const client = buildLlmClient({ baseUrl: config.sdApiUrl, apiKey: null }, config, base);
    expect(client).toBe(base.llm);
    expect(pathOf(client)).toBe(SD_API_CHAT_PATH);
  });

  it("builds a client bound to the provider's own host and OpenAI-compatible path when it differs", () => {
    const client = buildLlmClient(
      { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "secret" },
      config,
      base,
    );

    expect(client).not.toBe(base.llm);
    expect(hostOf(client)).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(pathOf(client)).toBe(OPENAI_COMPATIBLE_CHAT_PATH);
  });
});

/**
 * The wiring, not the wrapper.
 *
 * `lib/trace/wrap.test.ts` proves a decorated client records; this proves the
 * function the worker actually calls hands back a decorated one. Tracing that
 * works but is never installed is the failure mode worth a test of its own.
 */
describe("resolveLlmClient tracing", () => {
  const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });

  function collectingSink(): { sink: TraceSink; entries: TraceEntry[] } {
    const entries: TraceEntry[] = [];
    return { sink: { record: (entry) => entries.push(entry) }, entries };
  }

  it("records the provider row and the chat path the request went to", async () => {
    const { sink, entries } = collectingSink();
    const base = {
      llm: { chat: async () => ({ content: "ok", completionTokens: 3 }) },
    } as unknown as Parameters<typeof resolveLlmClient>[2];

    const client = resolveLlmClient(
      { id: "p1", name: "local llama", model: "qwen3-30b", baseUrl: config.sdApiUrl, apiKey: null },
      config,
      base,
      sink,
    );
    await client.chat({ model: "qwen3-30b", messages: [{ role: "user", content: "hello" }] });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "llm",
      requestPath: SD_API_CHAT_PATH,
      provider: { id: "p1", name: "local llama", model: "qwen3-30b" },
      response: "ok",
      ok: true,
    });
  });

  it("records the OpenAI-compatible path for a provider on another host", async () => {
    const { sink, entries } = collectingSink();
    const base = createSdApi({ baseUrl: config.sdApiUrl });

    // A closed local port, not a real external endpoint: no test may reach a
    // provider host. Which path was chosen is decided by `baseUrl` alone, so a
    // host that refuses the connection exercises it exactly as well as one
    // that answers — and a failed call is recorded with the same routing
    // detail as a successful one, which is the part under test.
    const client = resolveLlmClient(
      { baseUrl: "http://127.0.0.1:9/v1beta/openai/", apiKey: "secret" },
      config,
      base,
      sink,
    );
    await expect(
      client.chat({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow();

    expect(entries[0]).toMatchObject({ requestPath: OPENAI_COMPATIBLE_CHAT_PATH, ok: false });
  });
});
