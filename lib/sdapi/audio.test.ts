import { describe, it, expect, vi } from "vitest";
import { SdApiHttp } from "./client";
import { AudioClient, ASR_SAMPLE_RATE, samplesToMs } from "./audio";

function audioClient(handler: (url: string, init?: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { fetchImpl, audio: new AudioClient(new SdApiHttp({ baseUrl: "http://sd", fetch: fetchImpl })) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("samplesToMs (finding F1)", () => {
  // The regression that shipped desynced captions: a 24 kHz file whose last
  // word ended at sample 221440 is 13.84 s at the model's rate and 9.23 s at
  // the file's. Dividing by the file rate compresses every caption to ~66%.
  it("converts using the model's 16 kHz rate, not the file's", () => {
    expect(samplesToMs(221440)).toBe(13840);
    expect(ASR_SAMPLE_RATE).toBe(16000);
  });

  it("puts sample 0 at time 0", () => {
    expect(samplesToMs(0)).toBe(0);
  });
});

describe("AudioClient.speech", () => {
  /** A real 24 kHz mono 16-bit WAV of `ms` milliseconds, so duration is readable. */
  function wav(ms: number, sampleRate = 24_000): Buffer {
    const bytes = Math.round((ms / 1000) * sampleRate * 2);
    const buffer = Buffer.alloc(44 + bytes);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(36 + bytes, 4);
    buffer.write("WAVE", 8, "ascii");
    buffer.write("fmt ", 12, "ascii");
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36, "ascii");
    buffer.writeUInt32LE(bytes, 40);
    return buffer;
  }

  /** sd-api's task runner: base64 WAV plus a timing block. */
  const runnerResponse = (clip: Buffer, audioDurationMs?: number) =>
    json({
      audio: clip.toString("base64"),
      sample_rate: 24_000,
      channels: 1,
      timing: { wall_ms: 6161, audio_duration_ms: audioDurationMs ?? 0, rtf: 2.03 },
    });

  // The route this has to use, and the one it must not. sd-api's own docs for
  // /v1/audio/speech say voice-design models take `instruct` there; measured
  // against the real binary they do not — it forwards the body unmodified to
  // audiocpp_server, whose OpenAI-shape endpoint drops the field. Same sentence,
  // opposite instructions: task runner gives 249.0 Hz vs 84.4 Hz, /audio/speech
  // gives 107.4 Hz vs 183.9 Hz — unrelated, and backwards. Finding F2.
  it("generates through the task runner, never through /v1/audio/speech", async () => {
    const { audio, fetchImpl } = audioClient(() => runnerResponse(wav(4200)));

    const result = await audio.speech({
      model: "qwen3-tts-voicedesign",
      text: "Once upon a time.",
      instruct: "a deep, gravelly older man",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sd/v1/audio/tasks/run");
    expect(fetchImpl.mock.calls.map((c) => c[0]).join(" ")).not.toContain("/v1/audio/speech");

    expect(JSON.parse(init!.body as string)).toEqual({
      model: "qwen3-tts-voicedesign",
      request: {
        task: "vdes",
        text: "Once upon a time.",
        instruct: "a deep, gravelly older man",
      },
    });

    expect(result.durationMs).toBe(4200);
  });

  it("omits instruct entirely when there is none", async () => {
    const { audio, fetchImpl } = audioClient(() => runnerResponse(wav(500)));
    await audio.speech({ model: "m", text: "hi" });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.request).not.toHaveProperty("instruct");
  });

  it("returns the decoded WAV bytes", async () => {
    const clip = wav(1000);
    const { audio } = audioClient(() => runnerResponse(clip));
    const result = await audio.speech({ model: "m", text: "hi" });
    expect(result.audio.equals(clip)).toBe(true);
  });

  // The duration feeds the caption drift guard, and that guard exists to catch
  // a reported duration that is not the length of the audio — so it is
  // measured from the bytes rather than read from the response. They agree
  // today (3040 against 3040); this pins that it stays measured if they stop.
  it("measures duration from the WAV, not from the response's timing block", async () => {
    const { audio } = audioClient(() => runnerResponse(wav(2640), 2530));
    const result = await audio.speech({ model: "m", text: "hi" });
    expect(result.durationMs).toBe(2640);
  });

  it("reports progress at the ends only, since one call has no middle", async () => {
    const { audio } = audioClient(() => runnerResponse(wav(500)));
    const progress: number[] = [];
    await audio.speech({ model: "m", text: "hi" }, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([0, 1]);
  });

  it("refuses to start when the stage has already aborted", async () => {
    const { audio, fetchImpl } = audioClient(() => runnerResponse(wav(500)));
    await expect(
      audio.speech({ model: "m", text: "hi" }, { shouldAbort: () => true }),
    ).rejects.toThrow(/aborted/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a response whose payload is not a readable WAV", async () => {
    const { audio } = audioClient(() =>
      json({ audio: Buffer.from("not a wav at all").toString("base64") }),
    );
    await expect(audio.speech({ model: "m", text: "hi" })).rejects.toThrow(/readable WAV/);
  });

  it("refuses a response that carried no audio", async () => {
    const { audio } = audioClient(() => json({ timing: { audio_duration_ms: 100 } }));
    await expect(audio.speech({ model: "m", text: "hi" })).rejects.toThrow(/no audio/);
  });
});

describe("AudioClient.transcribeWords", () => {
  const words = [
    { word: "Right", start_sample: 0, end_sample: 8000 },
    { word: "at317,", start_sample: 8000, end_sample: 16000 },
  ];
  const clip = Buffer.from("RIFF....WAVEfmt ");

  /** Upload first, then the JSON transcription — the two calls F3 forces. */
  const asrServer = (body: unknown) =>
    audioClient((url) =>
      url.endsWith("/v1/audio-voice-refs")
        ? json({ voiceRefs: [{ path: "/srv/refs/abc.wav" }] }, 201)
        : json(body),
    );

  it("uploads for a server-local path, then asks for words at 16 kHz", async () => {
    const { audio, fetchImpl } = asrServer({ text: "Right at317,", words });

    const result = await audio.transcribeWords({
      model: "parakeet-tdt",
      audio: clip,
      expectedDurationMs: 1000,
    });

    // Two calls, and in this order: `words_out` is only honoured on the JSON
    // body form, which names a file on sd-api's own filesystem — so the clip
    // is stored as a voice reference purely to be handed back a path (F3).
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "http://sd/v1/audio-voice-refs",
      "http://sd/v1/audio/transcriptions",
    ]);

    const [, init] = fetchImpl.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "parakeet-tdt",
      audio: "/srv/refs/abc.wav",
      words_out: true,
    });

    expect(result.words).toEqual([
      { word: "Right", startMs: 0, endMs: 500 },
      { word: "at317,", startMs: 500, endMs: 1000 },
    ]);
  });

  // A bare output name resolves against sd-api's own working directory and
  // 404s, so the absolute path the upload returns is the only usable one.
  it("fails loudly when the upload returns no path", async () => {
    const { audio } = audioClient((url) =>
      url.endsWith("/v1/audio-voice-refs") ? json({ voiceRefs: [] }, 201) : json({ words }),
    );
    await expect(audio.transcribeWords({ model: "m", audio: clip })).rejects.toThrow(
      /voiceRefs\[0\]\.path/,
    );
  });

  it("drops malformed word entries rather than emitting NaN timings", async () => {
    const { audio } = asrServer({ words: [...words, { word: "  " }, { start_sample: 1 }] });
    const result = await audio.transcribeWords({ model: "m", audio: clip });
    expect(result.words).toHaveLength(2);
  });

  // The guard that turns a silent multi-second desync into a visible failure.
  it("refuses alignment that runs past the known audio duration", async () => {
    const { audio } = asrServer({ words });
    await expect(
      audio.transcribeWords({ model: "m", audio: clip, expectedDurationMs: 500 }),
    ).rejects.toThrow(/desync/);
  });

  it("allows a small overshoot inside tolerance", async () => {
    const { audio } = asrServer({ words });
    await expect(
      audio.transcribeWords({ model: "m", audio: clip, expectedDurationMs: 980 }),
    ).resolves.toMatchObject({ words: expect.any(Array) });
  });

  it("fails when nothing usable came back", async () => {
    const { audio } = asrServer({ words: [] });
    await expect(audio.transcribeWords({ model: "m", audio: clip })).rejects.toThrow(
      /no usable words/,
    );
  });
});
