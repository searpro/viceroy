"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PAGE_SHELL } from "./page-shell";

/**
 * The application's one navigation bar.
 *
 * There wasn't one. The home page carried six lowercase links in its own
 * header, and every other screen carried a single "← home" — so from Jobs you
 * could not reach Providers without two clicks through the project list, and
 * nothing anywhere told you which screen you were on. Living in the root
 * layout means every route gets it, including `/projects/[id]`, which
 * previously had no way out but the back button.
 */

const LINKS = [
  { href: "/", label: "Projects" },
  { href: "/jobs", label: "Jobs" },
  { href: "/styles", label: "Styles" },
  { href: "/prompt-templates", label: "Prompts" },
  { href: "/providers", label: "Providers" },
  { href: "/preferences", label: "Preferences" },
];

type Summary = { ok: number; total: number; degraded: boolean; worst: string };

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-surface/85 backdrop-blur">
      <div className={`${PAGE_SHELL} flex flex-wrap items-center gap-x-6 gap-y-2 py-3`}>
        <Link href="/" className="text-sm font-semibold tracking-tight text-white/90 hover:text-white">
          Viceroy
        </Link>

        <nav className="flex flex-wrap items-center gap-1" aria-label="Main">
          {LINKS.map((link) => {
            // "/" would otherwise prefix-match every route in the app.
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-2.5 py-1 text-xs transition ${
                  active ? "bg-white/10 text-white" : "text-white/45 hover:bg-white/5 hover:text-white/80"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <JobsBadge />
          <ProvidersBadge />
        </div>
      </div>
    </header>
  );
}

/**
 * Active work, anywhere.
 *
 * The floating jobs bar on a project page only ever knew about that project,
 * so a run kicked off on one project was invisible from every other screen —
 * including the screen you'd naturally sit on while it worked.
 */
function JobsBadge() {
  const [counts, setCounts] = useState<{ active: number; failed: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const response = await fetch("/api/jobs?counts=1", { cache: "no-store" }).catch(() => null);
      if (!response?.ok || cancelled) return;
      setCounts((await response.json()).counts);
    }
    poll();
    // Cheap (one local sqlite aggregate) and the only global signal that
    // something is happening, so it keeps ticking rather than stopping when
    // idle the way the per-project poller does.
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!counts || (counts.active === 0 && counts.failed === 0)) return null;

  return (
    <Link href="/jobs" className="flex items-center gap-2 text-xs transition hover:opacity-80">
      {counts.active > 0 && (
        <span className="flex items-center gap-1.5 text-amber-300">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-300" />
          {counts.active} running
        </span>
      )}
      {counts.failed > 0 && <span className="text-red-400">{counts.failed} failed</span>}
    </Link>
  );
}

/**
 * Reachability of every default provider, not of one host.
 *
 * Replaces the home page's "sd-api reachable" badge, which was both in the
 * wrong place (only one screen had it) and answering the wrong question (it
 * probed `config.sdApiUrl` regardless of which providers the project would
 * actually call — a movie run whose image provider is a stopped RunPod pod
 * showed green).
 */
function ProvidersBadge() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/providers/status", { cache: "no-store" }).catch(() => null);
    if (response?.ok) setSummary((await response.json()).summary);
    else setSummary(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // A minute, not seconds: each refresh costs up to five probes with a 4s
    // ceiling apiece, and a provider's reachability does not change on the
    // timescale a job list does.
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Both classes spelled out per state, never built by string surgery.
  // `tone.replace("text-", "bg-")` produced class names Tailwind's scanner
  // never sees in the source, so the dot was styled only when some *other*
  // file happened to contain the same literal — `bg-white/30` appears nowhere,
  // and the "status unknown" dot was therefore invisible.
  const tone: { text: string; dot: string } =
    summary === null
      ? { text: "text-white/30", dot: "bg-white/30" }
      : summary.worst === "ok"
        ? { text: "text-emerald-400", dot: "bg-emerald-400" }
        : summary.worst === "unreachable"
          ? { text: "text-red-400", dot: "bg-red-400" }
          : { text: "text-amber-300", dot: "bg-amber-300" };

  return (
    <Link
      href="/providers"
      title="Reachability of the default provider for each kind — click for detail"
      className="flex items-center gap-1.5 text-xs text-white/40 transition hover:text-white/70"
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      <span className={tone.text}>
        {loading && !summary ? "checking…" : summary ? `${summary.ok}/${summary.total} providers` : "status unknown"}
      </span>
    </Link>
  );
}
