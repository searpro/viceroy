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

  const audioResponse = (body: Buffer) =>
    new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "audio/wav" } });

  /** The queue → poll → fetch round trip, with the clip Pepper would return. */
  function speechServer(clip: Buffer, opts: { runningPolls?: number } = {}) {
    let polls = 0;
    return audioClient((url) => {
      if (url.endsWith("/v1/jobs/audio")) return json({ id: "job-1", status: "queued", progress: 0 });
      if (url.endsWith("/v1/jobs/job-1")) {
        if (polls++ < (opts.runningPolls ?? 0)) return json({ id: "job-1", status: "running", progress: 0.5 });
        return json({
          id: "job-1",
          status: "completed",
          progress: 1,
          result: { audio_url: "/v1/outputs/speech-1.wav", metadata: { duration_ms: 1 } },
        });
      }
      if (url.endsWith("/v1/outputs/speech-1.wav")) return audioResponse(clip);
      throw new Error(`unexpected ${url}`);
    });
  }

  // The task runner Pepper removed. Calling it now 404s with "unknown
  // endpoint", which is how voiceover jobs started failing.
  it("enqueues on /v1/jobs/audio, never the removed task runner", async () => {
    const { audio, fetchImpl } = speechServer(wav(4200));

    const result = await audio.speech(
      { model: "qwen3-tts-voicedesign", text: "Once upon a time.", instruct: "a deep, gravelly older man" },
      { pollIntervalMs: 0 },
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sd/v1/jobs/audio");
    expect(fetchImpl.mock.calls.map((c) => c[0]).join(" ")).not.toContain("/audio/tasks/run");

    // Pepper's field names: `input` and `instructions`, not `text`/`instruct`.
    expect(JSON.parse(init!.body as string)).toEqual({
      model: "qwen3-tts-voicedesign",
      input: "Once upon a time.",
      instructions: "a deep, gravelly older man",
    });

    expect(result.durationMs).toBe(4200);
  });

  it("polls until the job completes, then fetches the clip", async () => {
    const clip = wav(1000);
    const { audio, fetchImpl } = speechServer(clip, { runningPolls: 2 });

    const progress: number[] = [];
    const result = await audio.speech(
      { model: "m", text: "hi" },
      { pollIntervalMs: 0, onProgress: (p) => progress.push(p) },
    );

    expect(progress).toEqual([0.5, 0.5, 1]);
    expect(result.audio.equals(clip)).toBe(true);
    expect(fetchImpl.mock.calls.at(-1)![0]).toBe("http://sd/v1/outputs/speech-1.wav");
  });

  it("omits instructions entirely when there is none", async () => {
    const { audio, fetchImpl } = speechServer(wav(500));
    await audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0 });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).not.toHaveProperty(
      "instructions",
    );
  });

  // Pepper's own duration is ~4% short of the bytes it just wrote (measured:
  // 2530 reported for a 2640 ms clip). The drift guard exists to catch
  // mismatches that size, so it must not be fed one.
  it("measures duration from the WAV, not from Pepper's metadata", async () => {
    const { audio } = audioClient((url) => {
      if (url.endsWith("/v1/jobs/audio")) return json({ id: "j", status: "queued", progress: 0 });
      if (url.endsWith("/v1/jobs/j"))
        return json({
          id: "j",
          status: "completed",
          progress: 1,
          result: { audio_url: "/v1/outputs/a.wav", metadata: { duration_ms: 2530 } },
        });
      return audioResponse(wav(2640));
    });

    const result = await audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0 });
    expect(result.durationMs).toBe(2640);
  });

  it("cancels the job upstream when the stage aborts", async () => {
    const { audio, fetchImpl } = speechServer(wav(500));
    await expect(
      audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0, shouldAbort: () => true }),
    ).rejects.toThrow(/aborted/i);

    const cancel = fetchImpl.mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(cancel?.[0]).toBe("http://sd/v1/jobs/job-1");
  });

  it("surfaces a failed job with its reason", async () => {
    const { audio } = audioClient((url) =>
      url.endsWith("/v1/jobs/audio")
        ? json({ id: "j", status: "queued", progress: 0 })
        : json({ id: "j", status: "failed", progress: 0, error: { code: "OOM", message: "out of memory" } }),
    );
    await expect(audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0 })).rejects.toThrow(
      /out of memory/,
    );
  });

  it("refuses a completed job whose payload is not a readable WAV", async () => {
    const { audio } = audioClient((url) => {
      if (url.endsWith("/v1/jobs/audio")) return json({ id: "j", status: "queued", progress: 0 });
      if (url.endsWith("/v1/jobs/j"))
        return json({ id: "j", status: "completed", progress: 1, result: { audio_url: "/v1/outputs/a.wav" } });
      return audioResponse(Buffer.from("not a wav at all"));
    });
    await expect(audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0 })).rejects.toThrow(
      /readable WAV/,
    );
  });

  it("refuses a completed job that carried no audio", async () => {
    const { audio } = audioClient((url) =>
      url.endsWith("/v1/jobs/audio")
        ? json({ id: "j", status: "queued", progress: 0 })
        : json({ id: "j", status: "completed", progress: 1, result: {} }),
    );
    await expect(audio.speech({ model: "m", text: "hi" }, { pollIntervalMs: 0 })).rejects.toThrow(
      /without audio/,
    );
  });
});

describe("AudioClient.transcribeWords", () => {
  const words = [
    { word: "Right", start_sample: 0, end_sample: 8000 },
    { word: "at317,", start_sample: 8000, end_sample: 16000 },
  ];
  const clip = Buffer.from("RIFF....WAVEfmt ");

  it("posts the clip as a raw body and converts offsets at 16 kHz", async () => {
    const { audio, fetchImpl } = audioClient(() => json({ text: "Right at317,", words }));

    const result = await audio.transcribeWords({
      model: "parakeet-tdt",
      audio: clip,
      expectedDurationMs: 1000,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sd/v1/audio/transcriptions/words?model=parakeet-tdt");
    // A multipart envelope would be written into the WAV that audio.cpp opens,
    // so the bytes go up exactly as they are.
    expect(init!.headers).toMatchObject({ "content-type": "application/octet-stream" });
    expect(Buffer.from(init!.body as Uint8Array).equals(clip)).toBe(true);

    expect(result.words).toEqual([
      { word: "Right", startMs: 0, endMs: 500 },
      { word: "at317,", startMs: 500, endMs: 1000 },
    ]);
  });

  // The two-call upload dance F3 documented: the narration was stored as a
  // voice reference purely to be handed back a path.
  it("no longer uploads the narration anywhere first", async () => {
    const { audio, fetchImpl } = audioClient(() => json({ text: "x", words }));
    await audio.transcribeWords({ model: "m", audio: clip });

    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls.map((c) => c[0]).join(" ")).not.toContain("voice-refs");
  });

  it("drops malformed word entries rather than emitting NaN timings", async () => {
    const { audio } = audioClient(() =>
      json({ words: [...words, { word: "  " }, { start_sample: 1 }] }),
    );
    const result = await audio.transcribeWords({ model: "m", audio: clip });
    expect(result.words).toHaveLength(2);
  });

  // The guard that turns a silent multi-second desync into a visible failure.
  it("refuses alignment that runs past the known audio duration", async () => {
    const { audio } = audioClient(() => json({ words }));
    await expect(
      audio.transcribeWords({ model: "m", audio: clip, expectedDurationMs: 500 }),
    ).rejects.toThrow(/desync/);
  });

  it("allows a small overshoot inside tolerance", async () => {
    const { audio } = audioClient(() => json({ words }));
    await expect(
      audio.transcribeWords({ model: "m", audio: clip, expectedDurationMs: 980 }),
    ).resolves.toMatchObject({ words: expect.any(Array) });
  });

  it("fails when nothing usable came back", async () => {
    const { audio } = audioClient(() => json({ words: [] }));
    await expect(audio.transcribeWords({ model: "m", audio: clip })).rejects.toThrow(
      /no usable words/,
    );
  });
});
