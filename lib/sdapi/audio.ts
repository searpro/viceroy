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

export class AudioClient {
  constructor(private readonly http: SdApiHttp) {}

  /**
   * Generate speech with voice design.
   *
   * This deliberately does NOT use `POST /v1/audio/speech`. That endpoint
   * accepts an `instruct` field, forwards it, and audiocpp_server's
   * OpenAI-shaped handler ignores it — returning a perfectly normal-looking
   * response in a voice that owes nothing to the instruction. Measured on
   * qwen3-tts-voicedesign, "a high-pitched young girl" and "a deep, gravelly
   * older man" both produced ~130 Hz median F0 through /audio/speech; through
   * the task runner, 419 Hz and 88 Hz. Roughly 10% of /audio/speech calls
   * against a vdes model also returned noise rather than speech.
   *
   * Task-runner quirks, all load-bearing: the text field is `text` not
   * `input`, the task enum is the short form `vdes`, and it persists nothing —
   * audio comes back base64 inline and the caller stores the bytes.
   *
   * See docs/findings.md F2.
   */
  async speech(params: {
    model: string;
    text: string;
    instruct?: string | undefined;
    signal?: AbortSignal;
  }): Promise<SpeechResult> {
    const payload = await this.http.json<{
      audio?: unknown;
      timing?: { audio_duration_ms?: unknown };
    }>("/v1/audio/tasks/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: params.signal ?? null,
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
    const durationMs = payload.timing?.audio_duration_ms;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("Voice-design response carried no usable audio duration");
    }

    return {
      audio: Buffer.from(payload.audio, "base64"),
      durationMs: Math.round(durationMs),
    };
  }

  /**
   * Upload audio and get back the absolute server-side path sd-api needs.
   *
   * `words_out` only works on the JSON body form of /v1/audio/transcriptions,
   * which takes a path rather than an upload — and a bare output name resolves
   * against sd-api's own working directory and 404s. The multipart form, which
   * would accept the bytes directly, ignores `words_out` entirely.
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
   * Word-level transcription of already-uploaded audio.
   *
   * `expectedDurationMs` is not optional in spirit: it is the drift guard. If
   * the offsets' sample rate ever changes, alignment must fail loudly here
   * rather than silently shipping captions that run ahead of the audio.
   */
  async transcribeWords(params: {
    model: string;
    serverPath: string;
    expectedDurationMs?: number | undefined;
    signal?: AbortSignal;
  }): Promise<{ words: TranscribedWord[]; text: string }> {
    const data = await this.http.json<{
      text?: string;
      words?: { word?: string; start_sample?: number; end_sample?: number }[];
    }>("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: params.signal ?? null,
      body: JSON.stringify({ model: params.model, audio: params.serverPath, words_out: true }),
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
      throw new Error(`Transcription returned no usable words for ${params.serverPath}`);
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
