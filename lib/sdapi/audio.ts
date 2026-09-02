import { SdApiHttp, SdFormData } from "./client";

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

export type SpeechOptions = {
  /**
   * Narration is one synchronous call, so there is no intermediate signal to
   * report — 0 on the way in, 1 on the way out. Deliberately not faked into a
   * creeping bar: a progress number nothing measures is worse than none.
   */
  onProgress?: (progress: number) => void;
  /** Checked before the request is issued; mid-flight cancellation is `signal`. */
  shouldAbort?: () => boolean;
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

  /**
   * Generate narration with voice design.
   *
   * Through `POST /v1/audio/tasks/run`, and specifically NOT through the
   * dedicated `POST /v1/audio/speech`, even though sd-api's own route
   * documentation says voice-design models take `instruct` there. They do not.
   * sd-api forwards the body to audiocpp_server unmodified, and
   * audiocpp_server's OpenAI-shape endpoint drops the field — the same trap
   * sd-api itself documents one route down, where `words_out` on
   * `/v1/audio/transcriptions` only works by proxying to the task runner.
   *
   * Measured on qwen3-tts-voicedesign, same sentence, opposite instructions
   * (finding F2, re-confirmed 2026-09-02):
   *
   *   /v1/audio/tasks/run   "high-pitched young girl" 249.0 Hz | "deep,
   *                         gravelly older man" 84.4 Hz  — separated, correct
   *   /v1/audio/speech      107.4 Hz | 183.9 Hz — unrelated to the instruction,
   *                         and backwards
   *
   * Duration is measured from the returned WAV rather than read from
   * `timing.audio_duration_ms`. The two agree today (3040 ms against 3040 ms),
   * but this number feeds the caption drift guard, and that guard exists
   * precisely to catch a duration that is not the length of the audio — so it
   * is measured, not trusted. See findings F1.
   */
  async speech(
    params: {
      model: string;
      text: string;
      instruct?: string | undefined;
    },
    options: SpeechOptions = {},
  ): Promise<SpeechResult> {
    if (options.shouldAbort?.()) throw new Error("Narration aborted");
    options.onProgress?.(0);

    const payload = await this.http.json<{
      audio?: unknown;
      timing?: { audio_duration_ms?: unknown };
    }>("/v1/audio/tasks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: options.signal ?? null,
      body: JSON.stringify({
        model: params.model,
        request: {
          task: "vdes",
          text: params.text,
          ...(params.instruct ? { instruct: params.instruct } : {}),
        },
      }),
    });

    if (typeof payload.audio !== "string" || payload.audio.length === 0) {
      throw new Error("Voice-design response carried no audio");
    }

    const audio = Buffer.from(payload.audio, "base64");
    const durationMs = wavDurationMs(audio);
    if (durationMs === null || durationMs <= 0) {
      throw new Error("Narration came back as something other than a readable WAV");
    }

    options.onProgress?.(1);
    return { audio, durationMs };
  }

  /**
   * Upload narration and get back the absolute server-side path sd-api needs.
   *
   * `words_out` only works on the JSON body form of
   * `/v1/audio/transcriptions`, which takes a path rather than an upload — and
   * a bare output name resolves against sd-api's own working directory and
   * 404s. The multipart form, which would accept the bytes directly, cannot
   * do word timings at all: sd-api's own route description says so outright,
   * because there is no server-local path to hand the task runner.
   *
   * Going through voice-refs is what squares that circle, and it also means
   * viceroy never has to share a filesystem with sd-api. See findings F3.
   */
  async uploadAudio(audio: Buffer, filename = "narration.wav"): Promise<string> {
    const form = new SdFormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), filename);

    const payload = await this.http.json<{ voiceRefs?: { path?: string }[] }>(
      "/v1/audio-voice-refs",
      { method: "POST", body: form as never },
    );

    const path = payload.voiceRefs?.[0]?.path;
    if (!path) throw new Error("Audio upload response missing voiceRefs[0].path");
    return path;
  }

  /**
   * Word-level transcription of the narration.
   *
   * Two calls, and the detour is not incidental: `words_out` is only honoured
   * on the JSON body form of `/v1/audio/transcriptions`, which names a file on
   * sd-api's own filesystem, so the clip is uploaded as a *voice reference*
   * purely to be handed back an absolute path. Finding F3, and sd-api's route
   * description states the same constraint in its own words.
   *
   * The upload lives in here rather than in the calling stage because knowing
   * sd-api's traps is this client's whole job — a stage asking for "the words
   * in this audio" should not have to know that it takes two round trips.
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
    const serverPath = await this.uploadAudio(params.audio);

    const data = await this.http.json<{
      text?: string;
      words?: { word?: string; start_sample?: number; end_sample?: number }[];
    }>("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: params.signal ?? null,
      body: JSON.stringify({ model: params.model, audio: serverPath, words_out: true }),
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


