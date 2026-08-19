import { SdApiError, SdApiHttp, SdFormData, type SdApiOptions } from "../sdapi/client";

/**
 * Client for a vllm-omni video server (`vllm serve <model> --omni`).
 *
 * This is the one provider kind that does not come from sd-api, but it reuses
 * `SdApiHttp` deliberately: that class is the project's HTTP transport rather
 * than anything sd-api-specific, and it already carries the long-generation
 * timeout handling from finding F19. A video generation is minutes long, which
 * is exactly the range where Node's built-in 300 s header timeout silently
 * abandons the request while the GPU carries on working.
 */

export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";

/**
 * A job record as `POST /v1/videos` and `GET /v1/videos/{id}` return it.
 *
 * `progress` is documented as "best-effort progress indicator from 0 to 100"
 * and is measured to be binary: across 19 polls of a Wan2.2-S2V-14B job that
 * took 191 s, it held 0 for every in-progress poll and read 100 only on the
 * poll that already said `completed`. It carries no intermediate information,
 * so a progress bar driven off it sits at zero for the whole generation and
 * then jumps — which reads as a hung job rather than a working one. Show
 * elapsed time instead.
 */
export type VideoJob = {
  id: string;
  object: "video";
  status: VideoStatus;
  model: string;
  prompt: string;
  progress: number;
  size: string | null;
  seconds: string;
  created_at: number;
  completed_at: number | null;
  error: { code: number | string; message: string } | null;
  media_type: string;
  file_name: string | null;
  inference_time_s: number | null;
};

/** Bytes uploaded as a real multipart file part. */
export type VideoUpload = {
  bytes: Buffer;
  filename: string;
  contentType: string;
};

/**
 * Reference media.
 *
 * There are two ways in, and the difference is not cosmetic — it is the
 * difference between a 1 MB ceiling and no ceiling at all:
 *
 *  - `imageReference` / `audioReference` / `videoReference` are URLs (`http(s)`
 *    or `data:`) sent as JSON objects with a per-modality key
 *    (`{"image_url": ...}`) stringified into a *text* form field. Text fields
 *    are capped at 1024 KB by the server's multipart parser, and base64 adds a
 *    third — so an inline file over ~765 KB is refused with "Part exceeded
 *    maximum size of 1024KB." Measured: a 2 MB inline audio field is rejected.
 *  - `upload` is a real file part, which that cap does not apply to. Measured:
 *    a 3 MB file part parsed fine and was rejected later, on its contents.
 *
 * So local bytes belong in `upload` whenever the server will take them there.
 * It only accepts an image or a video that way (`input_reference`), never
 * audio — audio has no file-part field on this endpoint at all, which is why
 * large local audio has to be shrunk before it can be sent.
 */
export type VideoRequest = {
  prompt: string;
  /** Optional: vllm-omni serves one model per process and defaults to it. */
  model?: string | undefined;
  negativePrompt?: string | undefined;
  imageReference?: string | undefined;
  audioReference?: string | undefined;
  videoReference?: string | undefined;
  /** Local image or video bytes, sent as `input_reference`. */
  upload?: VideoUpload | undefined;
  /**
   * Every other form field the server accepts — width, height, num_frames,
   * fps, seed, num_inference_steps, guidance_scale and the rest. Passed
   * through under their wire names so a provider's `defaultParams` can be
   * handed over unchanged, and so a field this client has never heard of still
   * reaches the server.
   *
   * Not every field binds on every model. Speech-to-video takes its length
   * from the driving audio, not from `num_frames`: a request for 17 frames
   * against a 5.0 s clip returned 82 frames at 16 fps (5.125 s), with that
   * audio muxed into the MP4 as an AAC track.
   */
  params?: Record<string, unknown> | undefined;
};

export type VideoGenerateOptions = {
  onStatus?: (job: VideoJob) => void;
  /** Called between polls; returning true abandons the job and cancels it upstream. */
  shouldAbort?: () => boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Build the multipart body.
 *
 * The endpoint is multipart-only. A JSON body is not merely unsupported, it
 * fails misleadingly: `POST /v1/videos` with `{"prompt": "test"}` returns
 * `{'type': 'missing', 'loc': ('body', 'prompt')}` — the field it is holding
 * in its hand is reported as missing, because it only ever looks in the form.
 */
export function encodeVideoRequest(request: VideoRequest): SdFormData {
  // The server refuses `input_reference` alongside `image_reference` or
  // `video_reference` outright ("Provide only one of..."). Audio is not in
  // that exclusion list and does combine, which is what makes an uploaded
  // portrait plus driving audio possible at all.
  if (request.upload && (request.imageReference || request.videoReference)) {
    throw new Error(
      "An uploaded reference cannot be combined with an image or video reference URL — send one or the other",
    );
  }

  const form = new SdFormData();
  form.append("prompt", request.prompt);
  if (request.model) form.append("model", request.model);
  if (request.negativePrompt) form.append("negative_prompt", request.negativePrompt);

  if (request.upload) {
    const { bytes, filename, contentType } = request.upload;
    form.append(
      "input_reference",
      new Blob([new Uint8Array(bytes)], { type: contentType }),
      filename,
    );
  }

  const references = [
    ["image_reference", "image_url", request.imageReference],
    ["audio_reference", "audio_url", request.audioReference],
    ["video_reference", "video_url", request.videoReference],
  ] as const;
  for (const [field, key, value] of references) {
    if (value) form.append(field, JSON.stringify({ [key]: value }));
  }

  for (const [key, value] of Object.entries(request.params ?? {})) {
    // A null or undefined param means "let the server decide". Sending it as
    // the string "null" would instead fail the field's own type validation.
    if (value === null || value === undefined) continue;
    form.append(key, String(value));
  }
  return form;
}

/**
 * Pull the human-readable half out of a vllm-omni error.
 *
 * Its envelope is `{"error": {"message": ..., "code": ...}}`, which is not the
 * shape sd-api uses, so `SdApiError` carries it through as raw JSON text.
 */
export function describeVideoError(error: unknown): string {
  if (error instanceof SdApiError) {
    try {
      const parsed = JSON.parse(error.body) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // Not JSON — fall through to the raw message below.
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export class VideoClient {
  constructor(private readonly http: SdApiHttp) {}

  async createJob(request: VideoRequest): Promise<VideoJob> {
    return this.http.json<VideoJob>("/v1/videos", {
      method: "POST",
      // No content-type header: the FormData sets its own, including the
      // boundary, and naming it here would strip the boundary and 400.
      headers: { accept: "application/json" },
      body: encodeVideoRequest(request) as never,
    });
  }

  async getJob(id: string): Promise<VideoJob> {
    return this.http.json<VideoJob>(`/v1/videos/${encodeURIComponent(id)}`);
  }

  async listJobs(): Promise<VideoJob[]> {
    const payload = await this.http.json<{ data?: VideoJob[] }>("/v1/videos");
    return payload.data ?? [];
  }

  /**
   * Drop the job record.
   *
   * This is the only teardown the API offers; whether it also stops an
   * in-flight generation is not something the server documents or that has
   * been measured here, so an abort should be treated as "stop waiting", not
   * as "the GPU is now free".
   */
  async deleteJob(id: string): Promise<void> {
    await this.http
      .request(`/v1/videos/${encodeURIComponent(id)}`, { method: "DELETE" })
      .catch(() => undefined);
  }

  /** Download a finished job's MP4. */
  async fetchContent(id: string): Promise<Buffer> {
    const response = await this.http.request(`/v1/videos/${encodeURIComponent(id)}/content`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Run a generation to completion.
   *
   * Polls the async endpoint rather than using `POST /v1/videos/sync`: sync
   * holds one HTTP connection open for the entire generation, which gives up
   * the job id, any chance of showing the caller what stage it reached, and
   * any way to abort other than dropping the socket.
   */
  async generate(request: VideoRequest, options: VideoGenerateOptions = {}): Promise<Buffer> {
    const job = await this.createJob(request);
    const finished = await this.awaitJob(job.id, options);
    return this.fetchContent(finished.id);
  }

  /** Poll an already-created job until it completes, fails, aborts or times out. */
  async awaitJob(id: string, options: VideoGenerateOptions = {}): Promise<VideoJob> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (options.shouldAbort?.()) {
        await this.deleteJob(id);
        throw new Error("Video generation aborted");
      }
      if (Date.now() > deadline) {
        await this.deleteJob(id);
        throw new Error(`Video generation timed out after ${timeoutMs}ms`);
      }

      const current = await this.getJob(id);
      options.onStatus?.(current);

      if (current.status === "completed") return current;
      if (current.status === "failed") {
        throw new Error(`Video generation failed: ${current.error?.message ?? "unknown error"}`);
      }

      await sleep(pollIntervalMs, options.signal);
    }
  }
}

export function createVideoApi(options: SdApiOptions): VideoClient {
  return new VideoClient(new SdApiHttp(options));
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
