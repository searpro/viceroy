import { describe, it, expect, vi } from "vitest";
import { SdApiHttp } from "./client";
import { LlmClient, OPENAI_COMPATIBLE_CHAT_PATH, extractJsonObject } from "./llm";

function clientReturning(body: unknown, status = 200) {
  const fetchImpl = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  return {
    fetchImpl,
    llm: new LlmClient(new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl })),
  };
}

const completion = (content: string) => ({ choices: [{ message: { content } }] });

describe("extractJsonObject", () => {
  it("takes bare JSON", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  // Local GGUF models do this constantly, response_format or not.
  it("unwraps a fenced block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("ignores prose on either side", () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it("keeps nested objects intact rather than stopping at the first brace", () => {
    expect(extractJsonObject('{"a":{"b":2},"c":3}')).toBe('{"a":{"b":2},"c":3}');
  });

  it("does not mistake a brace inside a string for structure", () => {
    expect(extractJsonObject('{"a":"} not the end"}')).toBe('{"a":"} not the end"}');
  });

  it("handles an escaped quote before a closing brace", () => {
    expect(extractJsonObject('{"a":"say \\"hi\\""}')).toBe('{"a":"say \\"hi\\""}');
  });

  it("extracts a top-level array", () => {
    expect(extractJsonObject('[{"a":1},{"a":2}]')).toBe('[{"a":1},{"a":2}]');
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeUndefined();
  });
});

describe("LlmClient", () => {
  it("posts to the OpenAI-shaped route and returns trimmed content", async () => {
    const { llm, fetchImpl } = clientReturning(completion("  a story  "));
    const result = await llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("a story");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sd/v1/llm/chat/completions");
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: "m", temperature: 0.8 });
  });

  it("parses JSON out of a chatty response", async () => {
    const { llm } = clientReturning(completion('Here:\n```json\n{"scenes":[1,2]}\n```'));
    await expect(
      llm.chatJson<{ scenes: number[] }>({ model: "m", messages: [] }),
    ).resolves.toEqual({ scenes: [1, 2] });
  });

  it("fails loudly when the model returns no JSON", async () => {
    const { llm } = clientReturning(completion("I'd rather not."));
    await expect(llm.chatJson({ model: "m", messages: [] })).rejects.toThrow(/no JSON object/);
  });

  it("fails when the model returns an empty completion", async () => {
    const { llm } = clientReturning(completion("   "));
    await expect(llm.chat({ model: "m", messages: [] })).rejects.toThrow(/no content/);
  });

  it("surfaces an HTTP error with its status", async () => {
    const { llm } = clientReturning({ error: "boom" }, 500);
    await expect(llm.chat({ model: "m", messages: [] })).rejects.toThrow(/500/);
  });

  // BUG-28 follow-up: an external OpenAI-compatible host (e.g. Gemini) has no
  // sd-api-shaped /v1/llm namespace — it expects the plain top-level route.
  it("posts to a configured OpenAI-compatible path instead of sd-api's own route", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(completion("hi")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const llm = new LlmClient(
      new SdApiHttp({ baseUrl: "http://external", fetch: fetchImpl }),
      OPENAI_COMPATIBLE_CHAT_PATH,
    );
    await llm.chat({ model: "m", messages: [] });

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://external/chat/completions");
  });
});
