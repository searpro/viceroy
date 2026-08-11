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

describe("AudioClient.speech (finding F2)", () => {
  it("goes through the task runner, never /audio/speech, and uses `text` not `input`", async () => {
    const { audio, fetchImpl } = audioClient(() =>
      json({ audio: Buffer.from("wav-bytes").toString("base64"), timing: { audio_duration_ms: 4200 } }),
    );

    const result = await audio.speech({
      model: "qwen3-tts-voicedesign",
      text: "Once upon a time.",
      instruct: "a deep, gravelly older man",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sd/v1/audio/tasks/run");
    expect(url).not.toContain("/audio/speech");

    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      model: "qwen3-tts-voicedesign",
      request: {
        task: "vdes",
        text: "Once upon a time.",
        instruct: "a deep, gravelly older man",
      },
    });
    expect(body.request.input).toBeUndefined();

    expect(result.audio.toString()).toBe("wav-bytes");
    expect(result.durationMs).toBe(4200);
  });

  it("omits instruct entirely when there is none", async () => {
    const { audio, fetchImpl } = audioClient(() =>
      json({ audio: Buffer.from("x").toString("base64"), timing: { audio_duration_ms: 1 } }),
    );
    await audio.speech({ model: "m", text: "hi" });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).request).not.toHaveProperty(
      "instruct",
    );
  });

  it("rejects a response with no audio", async () => {
    const { audio } = audioClient(() => json({ timing: { audio_duration_ms: 100 } }));
    await expect(audio.speech({ model: "m", text: "hi" })).rejects.toThrow(/no audio/);
  });

  // The task runner persists nothing, so duration is the only handle on the
  // clip's length — and alignment's drift guard depends on it.
  it("rejects a response with no usable duration", async () => {
    const { audio } = audioClient(() => json({ audio: Buffer.from("x").toString("base64") }));
    await expect(audio.speech({ model: "m", text: "hi" })).rejects.toThrow(/duration/);
  });
});

describe("AudioClient.uploadAudio (finding F3)", () => {
  it("uploads via voice-refs and returns the absolute server path", async () => {
    const { audio, fetchImpl } = audioClient(() =>
      json({ voiceRefs: [{ path: "/srv/sd-api/data/audio-voice-refs/n.wav" }] }, 200),
    );

    const path = await audio.uploadAudio(Buffer.from("riff"));

    expect(fetchImpl.mock.calls[0]![0]).toBe("http://sd/v1/audio-voice-refs");
    expect(fetchImpl.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
    expect(path).toBe("/srv/sd-api/data/audio-voice-refs/n.wav");
  });

  it("fails when the upload response has no path", async () => {
    const { audio } = audioClient(() => json({ voiceRefs: [] }));
    await expect(audio.uploadAudio(Buffer.from("x"))).rejects.toThrow(/voiceRefs\[0\]\.path/);
  });
});

describe("AudioClient.transcribeWords", () => {
  const words = [
    { word: "Right", start_sample: 0, end_sample: 8000 },
    { word: "at317,", start_sample: 8000, end_sample: 16000 },
  ];

  it("sends words_out with a server path and converts offsets at 16 kHz", async () => {
    const { audio, fetchImpl } = audioClient(() => json({ text: "Right at317,", words }));

    const result = await audio.transcribeWords({
      model: "parakeet-tdt",
      serverPath: "/srv/n.wav",
      expectedDurationMs: 1000,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      model: "parakeet-tdt",
      audio: "/srv/n.wav",
      words_out: true,
    });
    expect(result.words).toEqual([
      { word: "Right", startMs: 0, endMs: 500 },
      { word: "at317,", startMs: 500, endMs: 1000 },
    ]);
  });

  it("drops malformed word entries rather than emitting NaN timings", async () => {
    const { audio } = audioClient(() =>
      json({ words: [...words, { word: "  " }, { start_sample: 1 }] }),
    );
    const result = await audio.transcribeWords({ model: "m", serverPath: "/a.wav" });
    expect(result.words).toHaveLength(2);
  });

  // The guard that turns a silent multi-second desync into a visible failure.
  it("refuses alignment that runs past the known audio duration", async () => {
    const { audio } = audioClient(() => json({ words }));
    await expect(
      audio.transcribeWords({ model: "m", serverPath: "/a.wav", expectedDurationMs: 500 }),
    ).rejects.toThrow(/desync/);
  });

  it("allows a small overshoot inside tolerance", async () => {
    const { audio } = audioClient(() => json({ words }));
    await expect(
      audio.transcribeWords({ model: "m", serverPath: "/a.wav", expectedDurationMs: 980 }),
    ).resolves.toMatchObject({ words: expect.any(Array) });
  });

  it("fails when nothing usable came back", async () => {
    const { audio } = audioClient(() => json({ words: [] }));
    await expect(audio.transcribeWords({ model: "m", serverPath: "/a.wav" })).rejects.toThrow(
      /no usable words/,
    );
  });
});
