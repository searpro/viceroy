import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { bindVariables, referenceSlots } from "@/lib/backends/comfy-bind";
import { createComfyClient, selectOutput, ComfyValidationError } from "@/lib/comfy/client";
import { applyTemplate } from "@/lib/comfy/template";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { providers, workflows } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * A 64x64 grey PNG, stood in for a character portrait.
 *
 * A workflow with reference slots cannot be exercised without something to put
 * in them, and the point of a test run is to prove the wiring — that the
 * LoadImage node resolves an uploaded name and the graph validates — not to
 * produce a good picture.
 */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PMQ0AAAwDoEqv9ErYvQQckD4XAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAYHLAB8+AWnmfUycAAAAAElFTkSuQmCC",
  "base64",
);

/** One second of silence at 24 kHz, for a workflow with an audio slot. */
function silentWav(seconds = 1, sampleRate = 24_000): Buffer {
  const samples = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

/** Above this, hand back a summary rather than a data URL the browser must hold. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { workflowId?: string; prompt?: string } | null;
  if (!body?.workflowId) {
    return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
  }

  const db = getDb();
  const workflow = db.select().from(workflows).where(eq(workflows.id, body.workflowId)).get();
  if (!workflow) return NextResponse.json({ error: "No such workflow" }, { status: 404 });

  const provider = db.select().from(providers).where(eq(providers.id, workflow.providerId)).get();
  if (!provider) return NextResponse.json({ error: "No such provider" }, { status: 404 });

  const config = resolveConfig();
  const client = createComfyClient({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    service: provider.name,
    timeoutMs: config.sdApiTimeoutMs,
  });

  const startedAt = Date.now();
  try {
    // Anything the graph reads by name has to be on the host first.
    const slots = referenceSlots(workflow.variables);
    const needsAudio = workflow.variables.some((variable) => variable.binds === "audio");

    const references: string[] = [];
    for (let index = 0; index < slots; index++) {
      references.push(await client.uploadImage(PLACEHOLDER_PNG, `viceroy-test-ref-${index}.png`));
    }
    const audio = needsAudio
      ? await client.uploadFile(silentWav(), "viceroy-test.wav", "audio/wav")
      : undefined;

    const values = bindVariables(
      workflow.variables,
      {
        prompt: body.prompt?.trim() || "a lighthouse on a storm-lashed cliff at dusk, cinematic",
        negativePrompt: provider.negativePrompt,
        width: config.sourceImage.width,
        height: config.sourceImage.height,
        seed: Math.floor(Math.random() * 2 ** 31),
        references,
        ...(audio ? { audio } : {}),
      },
      provider.defaultParams,
    );

    const outputs = await client.generate(applyTemplate(workflow.graph, values), {
      timeoutMs: config.sdApiTimeoutMs,
    });
    const ref = selectOutput(outputs, workflow.outputNodeId);
    const bytes = await client.fetchOutput(ref);

    const extension = ref.filename.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";

    return NextResponse.json({
      ok: true,
      filename: ref.filename,
      mimeType,
      bytes: bytes.length,
      elapsedMs: Date.now() - startedAt,
      // Data URL rather than a stored asset: a test run is a throwaway, and
      // writing it into the project's outputs would leave frames behind that
      // no scene refers to.
      dataUrl:
        bytes.length <= MAX_INLINE_BYTES
          ? `data:${mimeType};base64,${bytes.toString("base64")}`
          : null,
    });
  } catch (error) {
    if (error instanceof ComfyValidationError) {
      return NextResponse.json(
        { error: error.message, nodeErrors: error.nodeErrors, elapsedMs: Date.now() - startedAt },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      },
      { status: 400 },
    );
  }
}
