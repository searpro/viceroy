import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import {
  createSdApi,
  OPENAI_COMPATIBLE_CHAT_PATH,
  SD_API_CHAT_PATH,
  type LlmClient,
} from "../sdapi";
import { resolveLlmClient } from "./resolve";

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
describe("resolveLlmClient", () => {
  const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });
  const base = createSdApi({ baseUrl: config.sdApiUrl });

  it("reuses the worker's long-lived client when the provider is the same host", () => {
    const client = resolveLlmClient({ baseUrl: config.sdApiUrl, apiKey: null }, config, base);
    expect(client).toBe(base.llm);
    expect(pathOf(client)).toBe(SD_API_CHAT_PATH);
  });

  it("builds a client bound to the provider's own host and OpenAI-compatible path when it differs", () => {
    const client = resolveLlmClient(
      { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "secret" },
      config,
      base,
    );

    expect(client).not.toBe(base.llm);
    expect(hostOf(client)).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(pathOf(client)).toBe(OPENAI_COMPATIBLE_CHAT_PATH);
  });
});
