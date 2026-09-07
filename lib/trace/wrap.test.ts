import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { traceCalls } from "../db/schema";
import { beginPromptScope, endPromptScope, recordPromptRender } from "../prompts/trace";
import { enqueue, type Job } from "../queue";
import type { ChatClient } from "../sdapi";
import type { ImageBackend } from "../backends/types";
import { createTraceSink } from "./sink";
import { tracingChatClient, tracingImageBackend } from "./wrap";

const PROVIDER = { id: "p1", name: "local llama", model: "qwen3-30b", baseUrl: "http://localhost:3004" };

let handle: { db: Db; close: () => void };
let db: Db;
let job: Job;

beforeEach(() => {
  handle = createTestDb();
  db = handle.db;
  job = enqueue(db, { type: "concept" });
});

afterEach(() => {
  endPromptScope();
  handle.close();
});

function rows() {
  return db.select().from(traceCalls).all();
}

function chatClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    chat: async () => ({ content: "a written concept", completionTokens: 42 }),
    chatJson: async () => {
      throw new Error("the wrapper must implement chatJson itself, not delegate it");
    },
    ...overrides,
  };
}

describe("tracingChatClient", () => {
  it("records the request, the response and the provider it went to", async () => {
    const client = tracingChatClient(chatClient(), createTraceSink(db, job), {
      provider: PROVIDER,
      requestPath: "/v1/llm/chat/completions",
    });

    await client.chat({
      model: "qwen3-30b",
      messages: [{ role: "user", content: "write a concept" }],
      temperature: 0.85,
    });

    const [row] = rows();
    expect(row).toMatchObject({
      jobId: job.id,
      stage: "concept",
      kind: "llm",
      operation: "chat",
      sequence: 1,
      providerName: "local llama",
      model: "qwen3-30b",
      baseUrl: "http://localhost:3004",
      requestPath: "/v1/llm/chat/completions",
      response: "a written concept",
      ok: true,
    });
    expect(row!.request).toMatchObject({
      model: "qwen3-30b",
      temperature: 0.85,
      messages: [{ role: "user", content: "write a concept" }],
    });
    expect(row!.responseMeta).toEqual({ completionTokens: 42 });
  });

  it("records a failed request and still throws it", async () => {
    const client = tracingChatClient(
      chatClient({
        chat: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
      createTraceSink(db, job),
      { provider: PROVIDER, requestPath: "/v1/llm/chat/completions" },
    );

    await expect(
      client.chat({ model: "qwen3-30b", messages: [{ role: "user", content: "write a concept" }] }),
    ).rejects.toThrow("connect ECONNREFUSED");

    const [row] = rows();
    expect(row).toMatchObject({ ok: false, error: "connect ECONNREFUSED", response: null });
  });

  it("records the raw text behind a chatJson call, not the parsed object", async () => {
    const client = tracingChatClient(
      chatClient({ chat: async () => ({ content: '```json\n{"characters":[]}\n```', completionTokens: 8 }) }),
      createTraceSink(db, job),
      { provider: PROVIDER, requestPath: "/v1/llm/chat/completions" },
    );

    await expect(client.chatJson({ model: "qwen3-30b", messages: [{ role: "user", content: "cast it" }] })).resolves.toEqual(
      { characters: [] },
    );

    const [row] = rows();
    expect(row).toMatchObject({ operation: "chatJson", ok: true, response: '```json\n{"characters":[]}\n```' });
    // `json: true` is what the caller actually sent, whether or not they said so.
    expect(row!.request).toMatchObject({ json: true });
  });

  /**
   * The case this whole wrapper exists for. "The model returned prose instead
   * of an object" and "the model returned an object with the wrong keys" throw
   * indistinguishable errors from the parsed side, and only one of them is
   * fixed by editing the prompt — so a parse failure has to keep the text that
   * failed to parse.
   */
  it("records the unparseable response when it is the parse that failed", async () => {
    const client = tracingChatClient(
      chatClient({ chat: async () => ({ content: "Sure! Here are the characters you asked for.", completionTokens: 9 }) }),
      createTraceSink(db, job),
      { provider: PROVIDER, requestPath: "/v1/llm/chat/completions" },
    );

    await expect(
      client.chatJson({ model: "qwen3-30b", messages: [{ role: "user", content: "cast it" }] }),
    ).rejects.toThrow(/no JSON object/);

    const [row] = rows();
    expect(row!.ok).toBe(false);
    expect(row!.response).toBe("Sure! Here are the characters you asked for.");
  });

  it("numbers calls within a job in the order they were made", async () => {
    const sink = createTraceSink(db, job);
    const client = tracingChatClient(chatClient(), sink, { provider: PROVIDER, requestPath: "/x" });

    await client.chat({ model: "m", messages: [{ role: "user", content: "one" }] });
    await client.chat({ model: "m", messages: [{ role: "user", content: "two" }] });

    expect(rows().map((row) => row.sequence)).toEqual([1, 2]);
  });

  it("attributes the prompt template the messages were rendered from", async () => {
    beginPromptScope();
    recordPromptRender({
      key: "dev.concept",
      vars: { idea: "a lighthouse keeper", genreGuidance: "folk horror" },
      text: "Write a one-paragraph concept for: a lighthouse keeper",
    });

    const client = tracingChatClient(chatClient(), createTraceSink(db, job), {
      provider: PROVIDER,
      requestPath: "/x",
    });
    await client.chat({
      model: "qwen3-30b",
      messages: [{ role: "user", content: "Write a one-paragraph concept for: a lighthouse keeper" }],
    });

    expect(rows()[0]!.templates).toEqual([
      { key: "dev.concept", vars: { idea: "a lighthouse keeper", genreGuidance: "folk horror" } },
    ]);
  });
});

function imageBackend(overrides: Partial<ImageBackend> = {}): ImageBackend {
  return {
    label: "stub",
    referenceCapacity: () => 4,
    uploadReference: async () => "uploaded",
    hasReference: async () => true,
    generate: async (_request, options) => {
      options?.onResolved?.({ workflowName: "flux-ref", values: { steps: 4, cfg: 1 } });
      return Buffer.from("png-bytes");
    },
    ...overrides,
  };
}

describe("tracingImageBackend", () => {
  it("records the request, the adapter's resolved configuration and the result size", async () => {
    const backend = tracingImageBackend(imageBackend(), createTraceSink(db, job), {
      id: "img1",
      name: "comfy",
      adapter: "comfyui",
      model: "flux",
      baseUrl: "http://localhost:8188",
    });

    await backend.generate({
      prompt: "cinematic still, portrait of a keeper, 35mm",
      negativePrompt: "blurry",
      width: 832,
      height: 1216,
      references: [],
    });

    const [row] = rows();
    expect(row).toMatchObject({ kind: "image", operation: "generate", adapter: "comfyui", ok: true });
    expect(row!.request).toMatchObject({ prompt: "cinematic still, portrait of a keeper, 35mm", width: 832 });
    // The half a stage never sees: steps and cfg come from the provider's
    // default params and the workflow, and are the usual reason an image is
    // wrong when the prompt is right.
    expect(row!.resolved).toEqual({ workflowName: "flux-ref", values: { steps: 4, cfg: 1 } });
    expect(row!.responseMeta).toEqual({ bytes: 9 });
  });

  it("records a failed generation and still throws it", async () => {
    const backend = tracingImageBackend(
      imageBackend({
        generate: async () => {
          throw new Error("no text_to_image_ref workflow configured");
        },
      }),
      createTraceSink(db, job),
      { name: "comfy" },
    );

    await expect(
      backend.generate({ prompt: "p", negativePrompt: "", width: 8, height: 8, references: [] }),
    ).rejects.toThrow("no text_to_image_ref workflow configured");

    expect(rows()[0]).toMatchObject({ ok: false, error: "no text_to_image_ref workflow configured" });
  });

  it("still calls a caller's own onResolved", async () => {
    const seen: Record<string, unknown>[] = [];
    const backend = tracingImageBackend(imageBackend(), createTraceSink(db, job), { name: "comfy" });

    await backend.generate(
      { prompt: "p", negativePrompt: "", width: 8, height: 8, references: [] },
      { onResolved: (detail) => seen.push(detail) },
    );

    expect(seen).toHaveLength(1);
  });
});

describe("createTraceSink", () => {
  /**
   * A trace is diagnostic, never load-bearing. Twelve minutes of inference
   * must not be thrown away because a bookkeeping insert hit a locked
   * database.
   */
  it("never lets a recording failure reach the pipeline", async () => {
    handle.close();
    const sink = createTraceSink(db, job);
    const client = tracingChatClient(chatClient(), sink, { provider: PROVIDER, requestPath: "/x" });

    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "hello" }] }),
    ).resolves.toMatchObject({ content: "a written concept" });
  });
});
