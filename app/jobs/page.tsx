import { getDb } from "@/lib/db/client";
import { listAllJobs } from "@/lib/projects";
import { JobsView } from "./jobs-view";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  // Serialised through JSON so the client component's props match exactly
  // what its poll will later replace them with — Dates would arrive as
  // strings on the second render and not the first.
  return <JobsView initial={JSON.parse(JSON.stringify(listAllJobs(getDb())))} />;
}
