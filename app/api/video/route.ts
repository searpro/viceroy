import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { inlineAudioReference } from "@/lib/video/audio";
import { describeVideoError, type VideoUpload } from "@/lib/video/client";
import { resolveVideoClient } from "@/lib/video/provider";

export const dynamic = "force-dynamic";

export const VIDEO_MODES = ["text", "image", "speech"] as const;
export type VideoMode = (typeof VIDEO_MODES)[number];

/**
 * What each mode needs before the request is worth sending.
 *
 * The server does not enforce this: a speech-to-video model handed no audio
 * accepts the job, occupies the GPU for minutes, and returns something that
 * ignores the mode entirely. Refusing here costs nothing and saves that.
 */
const REQUIRED_REFERENCE: Record<VideoMode, "image" | "audio" | null> = {
  text: null,
  image: "image",
  speech: "audio",
};

// A ceiling on what this route will read into memory at all, well above any
// real portrait or narration. The server's own limits are much tighter and are
// handled per modality below.
const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

const requestSchema = z.object({
  mode: z.enum(VIDEO_MODES),
  prompt: z.string().trim().min(1, "A prompt is required"),
  negativePrompt: z.string().trim().optional(),
  model: z.string().trim().optional(),
  imageUrl: z.string().trim().optional(),
  audioUrl: z.string().trim().optional(),
  videoUrl: z.string().trim().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export async function GET() {
  try {
    const { video } = resolveVideoClient(getDb(), resolveConfig());
    return NextResponse.json({ jobs: await video.listJobs() });
  } catch (error) {
    return NextResponse.json({ error: describeVideoError(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse({
    mode: form.get("mode") ?? undefined,
    prompt: form.get("prompt") ?? undefined,
    negativePrompt: textOrUndefined(form.get("negativePrompt")),
    model: textOrUndefined(form.get("model")),
    imageUrl: textOrUndefined(form.get("imageUrl")),
    audioUrl: textOrUndefined(form.get("audioUrl")),
    videoUrl: textOrUndefined(form.get("videoUrl")),
    params: parseParams(form.get("params")),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const input = parsed.data;

  let imageReference = input.imageUrl;
  let videoReference = input.videoUrl;
  let audioReference = input.audioUrl;
  let upload: VideoUpload | undefined;
  try {
    // Uploaded image or video bytes go up as a real file part, which the
    // server's 1 MB text-field cap does not apply to. Only one of them can:
    // `input_reference` is a single field.
    const imageFile = asFile(form.get("imageFile"));
    const videoFile = asFile(form.get("videoFile"));
    if (imageFile && videoFile) {
      return NextResponse.json(
        { error: "Upload either an image or a video reference, not both" },
        { status: 400 },
      );
    }
    const referenceFile = imageFile ?? videoFile;
    if (referenceFile) {
      upload = await readUpload(referenceFile);
      // A file part and a reference URL for the same slot are mutually
      // exclusive server-side, and the file is the more deliberate of the two.
      if (imageFile) imageReference = undefined;
      if (videoFile) videoReference = undefined;
    }

    // Audio has no file-part field on this endpoint, so it has to be inlined —
    // and shrunk first if it does not fit.
    const audioFile = asFile(form.get("audioFile"));
    if (audioFile) {
      const raw = await readUpload(audioFile);
      const inlined = await inlineAudioReference(raw.bytes, raw.contentType);
      audioReference = `data:${inlined.contentType};base64,${inlined.bytes.toString("base64")}`;
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const required = REQUIRED_REFERENCE[input.mode];
  if (required === "image" && !imageReference && !upload) {
    return NextResponse.json(
      { error: "Image-to-video needs a reference image — upload one or give a URL" },
      { status: 400 },
    );
  }
  if (required === "audio" && !audioReference) {
    return NextResponse.json(
      { error: "Speech-to-video needs driving audio — upload one or give a URL" },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const { provider, video } = resolveVideoClient(db, resolveConfig());
    const job = await video.createJob({
      prompt: input.prompt,
      model: input.model || provider.model,
      // The provider's negative prompt is the model-level floor, the same
      // arrangement image generation uses; the form's box overrides it only
      // when the user actually typed something.
      negativePrompt: input.negativePrompt || provider.negativePrompt || undefined,
      imageReference,
      audioReference,
      videoReference,
      upload,
      params: { ...provider.defaultParams, ...input.params },
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: describeVideoError(error) }, { status: 502 });
  }
}

function textOrUndefined(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseParams(value: FormDataEntryValue | null): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asFile(value: FormDataEntryValue | null): File | null {
  return value && typeof value !== "string" && value.size > 0 ? value : null;
}

async function readUpload(file: File): Promise<VideoUpload> {
  if (file.size > MAX_REFERENCE_BYTES) {
    throw new Error(
      `${file.name || "Reference file"} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ` +
        `${MAX_REFERENCE_BYTES / 1024 / 1024} MB`,
    );
  }
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    filename: file.name || "reference",
    contentType: file.type || "application/octet-stream",
  };
}
