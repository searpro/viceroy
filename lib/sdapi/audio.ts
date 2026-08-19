import { SdApiHttp } from "./client";

/**
 * ASR word offsets come back in the MODEL's sample rate, not the audio file's.
 *
 * parakeet-tdt resamples to 16 kHz internally, so `start_sample`/`end_sample`
 * are 16 kHz indices whatever the source was. Verified on a real 24 kHz /
 * 13.92 s narration whose last word ended at sample 221440:
 *   221440 / 16000 = 13.84 s  ✅
 *   221440 / 24000 =  9.23 s  ❌ 4.7 s short
 *
 * Dividing by the file's own rate — which a WAV header parser hands you, and
 * is the obvious thing to reach for — compresses every caption to ~66% of its
 * correct time. See docs/findings.md F1.
 */
export const ASR_SAMPLE_RATE = 16_000;

/** How far past the known audio duration alignment may run before we refuse it. */
const DRIFT_TOLERANCE = 1.05;

export function samplesToMs(samples: number): number {
  return Math.round((samples / ASR_SAMPLE_RATE) * 1000);
}

export type TranscribedWord = { word: string; startMs: number; endMs: number };

export type SpeechResult = {
  audio: Buffer;
  durationMs: number;
};

export type SpeechJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  result?: { audio_path?: string; audio_url?: string } | undefined;
  error?: { code: string; message: string } | undefined;
};

export type SpeechOptions = {
  onProgress?: (progress: number) => void;
  /** Called between polls; returning true abandons the job and cancels it upstream. */
  shouldAbort?: () => boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Duration of a WAV, read from its own header.
 *
 * The job result carries a `metadata.duration_ms`, and it is emphatically not
 * the length of the audio — it is `Date.now() - started` around the
 * generation call, wall-clock time. On this hardware the two sit close enough
 * to pass a glance (7080 ms reported for a 7200 ms clip) precisely because a
 * real-time factor near 1 makes them coincide, so the mistake would survive
 * casual testing and then break on a faster machine or a cached model.
 *
 * This number feeds the caption drift guard, which exists to catch exactly
 * this class of mismatch, so the bytes are measured rather than trusted.
 * See findings F1.
 */
export function wavDurationMs(buffer: Buffer): number | null {
  if (buffer.length < 28) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!byteRate) return null;
      // A truncated download would otherwise report the header's intent
      // rather than the bytes actually in hand.
      const bytes = Math.min(size, buffer.length - offset - 8);
      return Math.round((bytes / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export class AudioClient {
  constructor(private readonly http: SdApiHttp) {}

  async createSpeechJob(params: {
    model: string;
    text: string;
    instruct?: string | undefined;
  }): Promise<SpeechJob> {
    return this.http.postJson<SpeechJob>("/v1/jobs/audio", {
      model: params.model,
      // Pepper's field names, not viceroy's: `input` and `instructions`.
      input: params.text,
      ...(params.instruct ? { instructions: params.instruct } : {}),
    });
  }

  async getSpeechJob(id: string): Promise<SpeechJob> {
    return this.http.json<SpeechJob>(`/v1/jobs/${id}`);
  }

  async cancelSpeechJob(id: string): Promise<void> {
    await this.http.request(`/v1/jobs/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  /** Fetch a generated output, e.g. from `result.audio_url`. */
  async fetchOutput(nameOrUrl: string): Promise<Buffer> {
    const route = nameOrUrl.startsWith("/v1/")
      ? nameOrUrl
      : `/v1/outputs/${encodeURIComponent(nameOrUrl)}`;
    const response = await this.http.request(route);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Generate speech with voice design, through the job queue.
   *
   * Voice design used to require `POST /v1/audio/tasks/run`, because
   * `/v1/audio/speech` accepted an `instruct` field and silently ignored it
   * (finding F2). Pepper has since removed the task runner outright — it now
   * 404s with "unknown endpoint" — and renamed the field to `instructions`,
   * which both remaining endpoints honour. Re-measured on
   * qwen3-tts-voicedesign: "a high-pitched young girl" and "a deep, gravelly
   * older man" give 343 Hz and 80 Hz median F0 here, so the instruction is
   * genuinely reaching the model. F2's workaround is therefore superseded.
   *
   * The queued route is chosen over the synchronous `/v1/audio/speech` because
   * a full narration takes ~6 minutes (finding F18), and holding a connection
   * open that long is precisely what cost this project four silent failures in
   * finding F19. Polling also gives abort a checkpoint, matching how images
   * are generated.
   *
   * Pepper persists the clip and returns a URL rather than base64 inline, so
   * the bytes are fetched in a second call.
   */
  async speech(
    params: {
      model: string;
      text: string;
      instruct?: string | undefined;
    },
    options: SpeechOptions = {},
  ): Promise<SpeechResult> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;

    const job = await this.createSpeechJob(params);

    while (true) {
      if (options.shouldAbort?.()) {
        await this.cancelSpeechJob(job.id);
        throw new Error("Narration aborted");
      }
      if (Date.now() > deadline) {
        await this.cancelSpeechJob(job.id);
        throw new Error(`Narration timed out after ${timeoutMs}ms`);
      }

      const current = await this.getSpeechJob(job.id);
      options.onProgress?.(current.progress);

      if (current.status === "completed") {
        const output = current.result?.audio_url ?? current.result?.audio_path;
        if (!output) throw new Error(`Job ${job.id} completed without audio`);

        const audio = await this.fetchOutput(
          output.startsWith("/v1/") ? output : basename(output),
        );
        const durationMs = wavDurationMs(audio);
        if (durationMs === null || durationMs <= 0) {
          throw new Error("Narration came back as something other than a readable WAV");
        }
        return { audio, durationMs };
      }
      if (current.status === "failed" || current.status === "cancelled") {
        throw new Error(
          `Narration ${current.status}: ${current.error?.message ?? "unknown error"}`,
        );
      }

      await sleep(pollIntervalMs, options.signal);
    }
  }

  /**
   * Word-level transcription, from the narration bytes themselves.
   *
   * This used to take two calls and a detour. `words_out` only worked on the
   * JSON body form of `/v1/audio/transcriptions`, which takes a path on the
   * server's own filesystem, so the narration was uploaded as a *voice
   * reference* purely to be handed back an absolute path — finding F3.
   *
   * Pepper now exposes the word-timed transcript directly, taking the clip as
   * a raw body, so neither the upload nor the path survives. F3 is superseded:
   * the plain `/v1/audio/transcriptions` still answers with text only, because
   * audio.cpp's own endpoint does, and `words` come from the task runner
   * behind this route.
   *
   * `expectedDurationMs` is not optional in spirit: it is the drift guard. If
   * the offsets' sample rate ever changes, alignment must fail loudly here
   * rather than silently shipping captions that run ahead of the audio.
   */
  async transcribeWords(params: {
    model: string;
    audio: Buffer;
    expectedDurationMs?: number | undefined;
    signal?: AbortSignal;
  }): Promise<{ words: TranscribedWord[]; text: string }> {
    const data = await this.http.json<{
      text?: string;
      words?: { word?: string; start_sample?: number; end_sample?: number }[];
    }>(`/v1/audio/transcriptions/words?model=${encodeURIComponent(params.model)}`, {
      method: "POST",
      // A raw body, not a form: Pepper writes what it receives straight to the
      // file audio.cpp opens, so a multipart envelope would land inside the
      // WAV. It refuses multipart outright rather than store a corrupt clip.
      headers: { "content-type": "application/octet-stream" },
      signal: params.signal ?? null,
      body: new Uint8Array(params.audio) as never,
    });

    const words: TranscribedWord[] = (data.words ?? [])
      .filter(
        (w): w is { word: string; start_sample: number; end_sample: number } =>
          typeof w.word === "string" &&
          w.word.trim().length > 0 &&
          typeof w.start_sample === "number" &&
          typeof w.end_sample === "number",
      )
      .map((w) => ({
        word: w.word.trim(),
        startMs: samplesToMs(w.start_sample),
        endMs: samplesToMs(w.end_sample),
      }));

    if (words.length === 0) {
      throw new Error("Transcription returned no usable words for the narration");
    }

    if (params.expectedDurationMs && params.expectedDurationMs > 0) {
      const lastEndMs = words[words.length - 1]!.endMs;
      if (lastEndMs > params.expectedDurationMs * DRIFT_TOLERANCE) {
        throw new Error(
          `Word alignment ends at ${lastEndMs}ms but the narration is only ` +
            `${params.expectedDurationMs}ms — the ASR's offsets are probably not ` +
            `${ASR_SAMPLE_RATE}Hz, and using them would desync every caption`,
        );
      }
    }

    return { words, text: typeof data.text === "string" ? data.text : "" };
  }
}

function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
