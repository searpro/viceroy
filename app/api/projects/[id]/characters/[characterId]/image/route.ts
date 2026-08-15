import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { EXTENSIONS, storeAsset } from "@/lib/assets";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { characters, projects } from "@/lib/db/schema";
import { resolveProvider } from "@/lib/pipeline/context";
import { regenerate } from "@/lib/projects";
import { listJobs } from "@/lib/queue";
import { createSdApi } from "@/lib/sdapi";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; characterId: string }> };

// Only image/* kinds — EXTENSIONS also covers audio/video, neither of which
// is a valid character reference.
const ACCEPTED_MIME_TYPES = new Set(
  Object.keys(EXTENSIONS).filter((mimeType) => mimeType.startsWith("image/")),
);

// Nothing upstream bounds this today; a browser upload has no ffprobe or
// generation-job ceiling to inherit, so this endpoint sets its own.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

type LoadedCharacter =
  | { ok: true; project: typeof projects.$inferSelect; character: typeof characters.$inferSelect }
  | { ok: false; response: NextResponse };

function loadCharacter(projectId: string, characterId: string): LoadedCharacter {
  const project = getDb().select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return { ok: false, response: NextResponse.json({ error: "No such project" }, { status: 404 }) };
  }

  const character = getDb()
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .get();
  if (!character || character.projectId !== projectId) {
    return { ok: false, response: NextResponse.json({ error: "No such character" }, { status: 404 }) };
  }

  return { ok: true, project, character };
}

/**
 * Upload a user-supplied reference image for a cast member (VIC-002).
 *
 * Manual-mode-only: this is a review-surface control, and auto mode has no
 * review surface to host it on. Writes directly rather than enqueueing a
 * job — same as how a generated portrait already displays immediately via
 * `imageAssetId` with no job in flight.
 */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId, characterId } = await params;
  const loaded = loadCharacter(projectId, characterId);
  if (!loaded.ok) return loaded.response;
  const { project, character } = loaded;

  if (project.mode !== "manual") {
    return NextResponse.json(
      { error: "Cast image upload is only available in manual mode" },
      { status: 400 },
    );
  }

  // A job already touching this project could race with the direct write
  // below (e.g. an in-flight character_images run overwriting the row right
  // after this handler sets it).
  const active = listJobs(getDb(), { projectId }).some((job) => ACTIVE_JOB_STATUSES.has(job.status));
  if (active) {
    return NextResponse.json(
      { error: "A job is already running for this project; wait for it to finish" },
      { status: 409 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Expected a multipart 'file' field" }, { status: 400 });
  }

  if (!ACCEPTED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported image type "${file.type}"; use PNG, JPEG or WebP` },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Image is too large (${file.size} bytes); the limit is ${MAX_UPLOAD_BYTES} bytes` },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const config = resolveConfig();
  const db = getDb();

  const slug = character.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const asset = storeAsset(db, config, {
    kind: "image",
    bytes,
    mimeType: file.type,
    projectId,
    label: `character-${slug}-upload`,
    meta: { characterId, source: "upload", originalFilename: file.name },
  });

  // The reference upload must land on the same host that will later
  // generate scenes from it — the image provider, not necessarily the
  // machine `SD_API_URL` points at.
  const imageProvider = resolveProvider(db, "image");
  const sdApi = createSdApi({
    baseUrl: imageProvider.baseUrl,
    apiKey: imageProvider.apiKey ?? undefined,
    timeoutMs: config.sdApiTimeoutMs,
  });
  const refInputName = await sdApi.image.uploadInput(bytes, file.name || `${characterId}.png`);

  // imagePrompt: null — it's currently the only tell that a generated
  // portrait's displayed prompt is stale, and there is no generated prompt
  // to show for an image the user picked themselves.
  const [updated] = db
    .update(characters)
    .set({ imageAssetId: asset.id, refInputName, imageSource: "uploaded", imagePrompt: null })
    .where(eq(characters.id, characterId))
    .returning()
    .all();

  return NextResponse.json({ character: updated });
}

/**
 * Revert to a generated portrait: clear the uploaded reference and re-run
 * `character_images` for just this character, reusing the redo path a
 * portrait redo already uses rather than duplicating its enqueue logic.
 */
export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const { id: projectId, characterId } = await params;
  const loaded = loadCharacter(projectId, characterId);
  if (!loaded.ok) return loaded.response;
  const { project } = loaded;

  if (project.mode !== "manual") {
    return NextResponse.json(
      { error: "Cast image upload is only available in manual mode" },
      { status: 400 },
    );
  }

  try {
    const job = regenerate(getDb(), projectId, { target: "character_images", characterId });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
