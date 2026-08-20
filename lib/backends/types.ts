/**
 * What a pipeline stage needs from a generation host, in Viceroy's own
 * vocabulary.
 *
 * Until ComfyUI there was no need for this: "the image provider" and "sd-api's
 * `/v1/jobs` request shape" were the same idea, so stages built sd-api
 * requests directly. They are not the same idea — ComfyUI takes a whole
 * workflow graph and has no per-kind endpoint, no `model` field, and no
 * `ref_images` — so the request shape here is deliberately ours. Each adapter
 * is responsible for translating it, and a field one host has never heard of
 * is that adapter's problem rather than the stage's.
 */

export type GenerateOptions = {
  /** 0..1 within this single generation. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** Returning true abandons the generation and cancels it upstream. */
  shouldAbort?: (() => boolean) | undefined;
  /** Narration for the job log — model loading, queue position, and the like. */
  log?: ((message: string, level?: "debug" | "info" | "warn" | "error") => void) | undefined;
};

export type ImageRequest = {
  prompt: string;
  /** Already merged from provider and style; empty means "no avoid-list". */
  negativePrompt: string;
  width: number;
  height: number;
  seed?: number | undefined;
  /**
   * Host-side names of previously uploaded portraits, in the order the scene's
   * characters appear. Empty for a text-only generation.
   */
  references: string[];
};

export type ImageBackend = {
  /** How to name this host in a log line or an error. */
  readonly label: string;

  generate(request: ImageRequest, options?: GenerateOptions): Promise<Buffer>;

  /**
   * Hand a portrait to the host once, so scenes can point at it by name.
   *
   * Returns the host's name for it, which is what goes in
   * `characters.refInputName`.
   */
  uploadReference(bytes: Buffer, filename: string): Promise<string>;

  /** Whether the host still holds a reference under this name. */
  hasReference(name: string): Promise<boolean>;

  /**
   * How many references one generation can carry, or 0 for none.
   *
   * ComfyUI's answer comes from the workflow — a graph with one `LoadImage`
   * hole has one slot — so this is a property of configuration, not of the
   * software, and the stage has to ask rather than assume.
   */
  referenceCapacity(): number;
};

export type VideoRequest = {
  prompt: string;
  negativePrompt: string;
  /** The frame the video is generated from. */
  image?: { bytes: Buffer; filename: string } | undefined;
  /** Driving narration, for speech-to-video. */
  audio?: { bytes: Buffer; filename: string } | undefined;
  /** Everything else the workflow exposes — width, fps, num_frames, steps. */
  params: Record<string, unknown>;
};

export type VideoBackend = {
  readonly label: string;
  generate(request: VideoRequest, options?: GenerateOptions): Promise<Buffer>;
};
