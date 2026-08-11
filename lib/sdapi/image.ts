import { SdApiHttp, SdFormData } from "./client";

export type ImageRequest = {
  prompt: string;
  model: string;
  negative_prompt?: string;
  steps?: number;
  cfg_scale?: number;
  width: number;
  height: number;
  seed?: number;
  sampler?: string;
  /** Reference portraits, so a character looks the same in every scene. */
  ref_images?: string[];
  /** Give each reference its own slot — needed when two people share a frame. */
  increase_ref_index?: boolean;
};

export type SdJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  step?: number;
  totalSteps?: number;
  result?: { image_path?: string; image_url?: string } | undefined;
  error?: { code: string; message: string } | undefined;
};

export type GenerateOptions = {
  onProgress?: (progress: number) => void;
  /** Called between polls; returning true abandons the job and cancels it upstream. */
  shouldAbort?: () => boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class ImageClient {
  constructor(private readonly http: SdApiHttp) {}

  async createJob(request: ImageRequest): Promise<SdJob> {
    // A dimension that isn't a multiple of 16 is rounded UP by
    // stable-diffusion.cpp rather than refused, which silently breaks the
    // aspect ratio. Config guards the configured size; this guards every other
    // caller. See docs/findings.md F4.
    for (const [name, value] of [["width", request.width], ["height", request.height]] as const) {
      if (value % 16 !== 0) {
        throw new Error(
          `${name}=${value} is not a multiple of 16; stable-diffusion.cpp would round it up to ` +
            `${Math.ceil(value / 16) * 16} and the frame would no longer match its target ratio`,
        );
      }
    }
    return this.http.postJson<SdJob>("/v1/jobs", request);
  }

  async getJob(id: string): Promise<SdJob> {
    return this.http.json<SdJob>(`/v1/jobs/${id}`);
  }

  async cancelJob(id: string): Promise<void> {
    await this.http.request(`/v1/jobs/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  /**
   * Upload an image for later use as a reference, returning sd-api's name for
   * it.
   *
   * `ref_images` takes names resolved against sd-api's own inputs directory,
   * not paths on this machine, so a portrait has to be handed over once before
   * any scene can point at it. The name is worth storing: re-uploading the
   * same portrait per frame would copy it eight times for nothing.
   */
  async uploadInput(bytes: Buffer, filename = "reference.png"): Promise<string> {
    const form = new SdFormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);

    const payload = await this.http.json<{ inputs?: { name?: string }[] }>("/v1/inputs", {
      method: "POST",
      body: form as never,
    });

    const name = payload.inputs?.[0]?.name;
    if (!name) throw new Error("Input upload response missing inputs[0].name");
    return name;
  }

  /** Whether sd-api still holds an uploaded input under this name. */
  async hasInput(name: string): Promise<boolean> {
    try {
      await this.http.request(`/v1/inputs/${encodeURIComponent(name)}`, { method: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch a generated output by name, e.g. from `result.image_url`. */
  async fetchOutput(nameOrUrl: string): Promise<Buffer> {
    const route = nameOrUrl.startsWith("/v1/")
      ? nameOrUrl
      : `/v1/outputs/${encodeURIComponent(nameOrUrl)}`;
    const response = await this.http.request(route);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Run a generation to completion.
   *
   * Polls rather than consuming the SSE stream: the poll is a few bytes every
   * couple of seconds against a job measured in minutes on CPU, and it gives
   * abort a natural checkpoint. An SSE reader would have to be unwound
   * separately to get the same thing.
   */
  async generate(request: ImageRequest, options: GenerateOptions = {}): Promise<Buffer> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;

    const job = await this.createJob(request);

    while (true) {
      if (options.shouldAbort?.()) {
        await this.cancelJob(job.id);
        throw new Error("Image generation aborted");
      }
      if (Date.now() > deadline) {
        await this.cancelJob(job.id);
        throw new Error(`Image generation timed out after ${timeoutMs}ms`);
      }

      const current = await this.getJob(job.id);
      options.onProgress?.(current.progress);

      if (current.status === "completed") {
        const output = current.result?.image_url ?? current.result?.image_path;
        if (!output) throw new Error(`Job ${job.id} completed without an image`);
        return this.fetchOutput(output.startsWith("/v1/") ? output : basename(output));
      }
      if (current.status === "failed") {
        throw new Error(`Image generation failed: ${current.error?.message ?? "unknown error"}`);
      }

      await sleep(pollIntervalMs, options.signal);
    }
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
