import { resolveConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { listJobs } from "@/lib/queue";
import { createSdApi } from "@/lib/sdapi";

export const dynamic = "force-dynamic";

// PR1 has no pipeline yet, so this page exists to prove the foundation is
// wired: config resolves, migrations applied, the queue reads, and sd-api
// answers. PR2 replaces it with the idea-entry screen.
export default async function Home() {
  const config = resolveConfig();
  const sdApi = createSdApi({ baseUrl: config.sdApiUrl });
  const [healthy, jobs] = await Promise.all([
    sdApi.health(),
    Promise.resolve(listJobs(getDb(), { limit: 20 })),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Viceroy</h1>
      <p className="mt-2 text-[--color-ink-muted]">
        Foundation only — the generation pipeline lands in PR2–PR5.
      </p>

      <section className="mt-10 rounded-lg border border-white/10 bg-[--color-surface-raised] p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[--color-ink-muted]">
          System
        </h2>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-[--color-ink-muted]">sd-api</dt>
          <dd>
            <span className={healthy ? "text-emerald-400" : "text-red-400"}>
              {healthy ? "reachable" : "unreachable"}
            </span>{" "}
            <span className="text-[--color-ink-muted]">{config.sdApiUrl}</span>
          </dd>

          <dt className="text-[--color-ink-muted]">database</dt>
          <dd className="font-mono text-xs">{config.databasePath}</dd>

          <dt className="text-[--color-ink-muted]">source frame</dt>
          <dd>
            {config.sourceImage.width}×{config.sourceImage.height} → {config.video.width}×
            {config.video.height}
          </dd>

          <dt className="text-[--color-ink-muted]">jobs</dt>
          <dd>{jobs.length === 0 ? "none queued" : `${jobs.length} in queue`}</dd>
        </dl>
      </section>
    </main>
  );
}
