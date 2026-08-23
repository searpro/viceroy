import { notFound } from "next/navigation";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { getProjectDetail } from "@/lib/projects";
import { ProjectView } from "./project-view";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getProjectDetail(getDb(), id);
  if (!detail) notFound();

  const config = resolveConfig();

  // Serialised through JSON so the client component's props match exactly what
  // its poll will later replace them with — Dates would arrive as strings on
  // the second render and not the first.
  return (
    <ProjectView
      initial={JSON.parse(JSON.stringify(detail))}
      // The machine's pixel budget, for labelling the frame-size options. Same
      // reason the new-project form is given it: `lib/config.ts` imports
      // node:path and cannot be bundled for the client, and the labels are
      // dimensions that depend on a shape the user is choosing right now.
      basePixels={config.video.width * config.video.height}
    />
  );
}
