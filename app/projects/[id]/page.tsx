import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getProjectDetail } from "@/lib/projects";
import { ProjectView } from "./project-view";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getProjectDetail(getDb(), id);
  if (!detail) notFound();

  // Serialised through JSON so the client component's props match exactly what
  // its poll will later replace them with — Dates would arrive as strings on
  // the second render and not the first.
  return <ProjectView initial={JSON.parse(JSON.stringify(detail))} />;
}
