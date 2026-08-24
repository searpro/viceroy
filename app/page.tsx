import Link from "next/link";
import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  captionStyles,
  directionStyles,
  imageStyles,
  narrativeStyles,
  productionDesignStyles,
  voiceStyles,
} from "@/lib/db/schema";
import { formatLabel, isDevFormat } from "@/lib/labels";
import { listPreferences } from "@/lib/preferences";
import { listProjects } from "@/lib/projects";
import { PAGE_SHELL } from "./components/page-shell";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = resolveConfig();
  const db = getDb();

  const projects = listProjects(db);
  const styles = {
    narrativeStyles: db.select().from(narrativeStyles).all(),
    voiceStyles: db.select().from(voiceStyles).all(),
    imageStyles: db.select().from(imageStyles).all(),
    captionStyles: db.select().from(captionStyles).all(),
    directionStyles: db.select().from(directionStyles).all(),
    productionDesignStyles: db.select().from(productionDesignStyles).all(),
  };
  const prefs = listPreferences(db);
  const defaultMode = prefs.defaultMode === "manual" ? "manual" : "auto";

  const seeded = styles.narrativeStyles.length > 0;

  return (
    <main className={`${PAGE_SHELL} py-10`}>
      <h1 className="text-2xl font-semibold tracking-tight">New project</h1>

      {!seeded ? (
        <p className="mt-6 rounded-md bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          No styles found. Run <code className="font-mono">pnpm db:seed</code> to install the
          built-in narrative, voice and image styles.
        </p>
      ) : (
        <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-6">
          <NewProjectForm
            {...styles}
            basePixels={config.video.width * config.video.height}
            defaultMode={defaultMode}
            defaultFormat={prefs.defaultFormat}
            defaultAspectRatio={prefs.defaultAspectRatio}
            defaultResolutionKey={prefs.defaultResolution}
            defaultNarrativeStyleName={prefs.defaultNarrativeStyle}
            defaultVoiceStyleName={prefs.defaultVoiceStyle}
            defaultImageStyleName={prefs.defaultImageStyle}
            defaultCaptionStyleName={prefs.defaultCaptionStyle}
            defaultDirectionStyleName={prefs.defaultDirectionStyle}
            defaultProductionDesignStyleName={prefs.defaultProductionDesignStyle}
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
                  <span className="flex min-w-0 items-center gap-2.5">
                    {/* Which pipeline this project runs is the single most
                        useful thing to know from a list — the two flows share
                        almost no vocabulary past this point. */}
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        isDevFormat(project.format)
                          ? "bg-sky-400/10 text-sky-300"
                          : "bg-white/5 text-white/40"
                      }`}
                    >
                      {formatLabel(project.format, true)}
                    </span>
                    <span className="min-w-0 truncate text-sm" title={project.title ?? project.idea}>
                      {project.title ?? project.idea}
                    </span>
                  </span>
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
