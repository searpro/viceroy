import Link from "next/link";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { captionStyles, imageStyles, narrativeStyles, voiceStyles } from "@/lib/db/schema";
import { listPreferences } from "@/lib/preferences";
import { listProjects } from "@/lib/projects";
import { resolutionPresets } from "@/lib/resolution";
import { createSdApi } from "@/lib/sdapi";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = resolveConfig();
  const db = getDb();
  const healthy = await createSdApi({ baseUrl: config.sdApiUrl }).health();

  const projects = listProjects(db);
  const styles = {
    narrativeStyles: db.select().from(narrativeStyles).all(),
    voiceStyles: db.select().from(voiceStyles).all(),
    imageStyles: db.select().from(imageStyles).all(),
    captionStyles: db.select().from(captionStyles).all(),
  };
  const defaultMode = listPreferences(db).defaultMode === "manual" ? "manual" : "auto";

  const seeded = styles.narrativeStyles.length > 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Viceroy</h1>
        <span className="flex items-center gap-3 text-xs text-white/40">
          <Link href="/styles" className="transition hover:text-white/70">
            styles
          </Link>
          <Link href="/providers" className="transition hover:text-white/70">
            providers
          </Link>
          <Link href="/prompt-templates" className="transition hover:text-white/70">
            prompts
          </Link>
          <Link href="/preferences" className="transition hover:text-white/70">
            preferences
          </Link>
          <Link href="/jobs" className="transition hover:text-white/70">
            jobs
          </Link>
          <span>
            sd-api{" "}
            <span className={healthy ? "text-emerald-400" : "text-red-400"}>
              {healthy ? "reachable" : "unreachable"}
            </span>
          </span>
        </span>
      </header>

      {!seeded ? (
        <p className="mt-10 rounded-md bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          No styles found. Run <code className="font-mono">pnpm db:seed</code> to install the
          built-in narrative, voice and image styles.
        </p>
      ) : (
        <section className="mt-10 rounded-lg border border-white/10 bg-white/[0.02] p-6">
          <NewProjectForm
            {...styles}
            resolutionPresets={resolutionPresets(config)}
            defaultMode={defaultMode}
          />
        </section>
      )}

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Projects</h2>
        {projects.length === 0 ? (
          <p className="mt-4 text-sm text-white/40">Nothing yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between gap-4 py-3 transition hover:text-amber-300"
                >
                  <span className="truncate text-sm">{project.title ?? project.idea}</span>
                  <span className="shrink-0 font-mono text-xs text-white/35">
                    {project.awaitingReview ? "needs review" : project.stage}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
