import { SdApiHttp } from "./client";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the model for JSON. Enforcement is best-effort at the model level. */
  json?: boolean;
  signal?: AbortSignal;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// sd-api reverse-proxies its OpenAI-compatible llama-server under this
// namespace — correct when `http`'s baseUrl really is an sd-api install. A
// provider pointed at a genuine external OpenAI-compatible host (e.g.
// Gemini's `.../v1beta/openai/`) has no `/v1/llm` namespace: it expects the
// plain top-level path every OpenAI SDK client calls. `resolveLlmClient` in
// lib/backends/resolve.ts picks which one a given provider gets, by baseUrl.
export const SD_API_CHAT_PATH = "/v1/llm/chat/completions";
export const OPENAI_COMPATIBLE_CHAT_PATH = "/chat/completions";

export class LlmClient {
  constructor(
    private readonly http: SdApiHttp,
    private readonly chatPath: string = SD_API_CHAT_PATH,
  ) {}

  async chat(options: ChatOptions): Promise<{ content: string; completionTokens: number }> {
    const payload = await this.http.json<ChatCompletionResponse>(this.chatPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: options.signal ?? null,
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.8,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("LLM response carried no content");
    }

    return {
      content: content.trim(),
      completionTokens: payload.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * Chat, parsed as JSON.
   *
   * Local GGUF models routinely wrap JSON in prose or a ```json fence even
   * when asked not to, so the outermost balanced object is extracted rather
   * than trusting the response to be bare JSON. A model that returns nothing
   * parseable is a failure worth surfacing, not one to paper over.
   */
  async chatJson<T>(options: ChatOptions): Promise<T> {
    const { content } = await this.chat({ ...options, json: true });
    const candidate = extractJsonObject(content);
    if (!candidate) {
      throw new Error(`LLM response contained no JSON object: ${truncate(content, 300)}`);
    }
    try {
      return JSON.parse(candidate) as T;
    } catch (cause) {
      throw new Error(`LLM returned malformed JSON: ${truncate(candidate, 300)}`, { cause });
    }
  }
}

export function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const haystack = fenced?.[1]?.trim() ?? text;

  const start = haystack.search(/[[{]/);
  if (start === -1) return undefined;

  const opener = haystack[start]!;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i++) {
    const char = haystack[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }

  return undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
