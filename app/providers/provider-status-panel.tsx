"use client";

import { useCallback, useEffect, useState } from "react";

type Health = {
  kind: "llm" | "image" | "audio" | "asr" | "video";
  status: "ok" | "unreachable" | "unconfigured";
  providerId: string | null;
  name: string | null;
  adapter: "sdapi" | "comfyui" | null;
  model: string | null;
  host: string | null;
  detail: string | null;
  latencyMs: number | null;
  checkedAt: string;
};

const KIND_LABELS: Record<Health["kind"], string> = {
  llm: "LLM",
  image: "Image",
  audio: "Audio (TTS)",
  asr: "ASR",
  video: "Video",
};

/**
 * Reachability of the default provider for every kind.
 *
 * Replaces the home page's `sd-api reachable/unreachable` badge, which had two
 * problems beyond being in the wrong place. It named one host, when a movie
 * run touches up to four different ones — and it probed the URL out of
 * `config.sdApiUrl` rather than the provider rows the stages resolve, so a
 * project whose image provider is a stopped RunPod pod and whose LLM is a
 * hosted endpoint reported "reachable" on the strength of a service neither of
 * them uses.
 *
 * Each row names the row `resolveProvider` will actually pick, and clicking one
 * opens that kind's tab below — the status and the thing you'd change about it
 * are on the same screen.
 */
export function ProviderStatusPanel({
  onSelectKind,
}: {
  onSelectKind: (kind: Health["kind"]) => void;
}) {
  const [rows, setRows] = useState<Health[] | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    const response = await fetch("/api/providers/status", { cache: "no-store" }).catch(() => null);
    setRows(response?.ok ? (await response.json()).providers : null);
    setChecking(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-white/85">Status</h2>
        <button
          onClick={refresh}
          disabled={checking}
          className="text-xs text-white/40 transition hover:text-white/70 disabled:opacity-40"
        >
          {checking ? "checking…" : "re-check"}
        </button>
      </div>

      {rows === null && !checking && (
        <p className="mt-3 text-xs text-white/40">Could not run the check.</p>
      )}

      <ul className="mt-3 space-y-1">
        {(rows ?? []).map((row) => (
          <li key={row.kind}>
            <button
              onClick={() => onSelectKind(row.kind)}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/5"
            >
              <span className={`size-1.5 shrink-0 rounded-full ${dotFor(row.status)}`} />
              <span className="w-24 shrink-0 text-white/70">{KIND_LABELS[row.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-white/50">
                {row.name ? (
                  <>
                    {row.name}
                    {row.model ? <span className="text-white/30"> · {row.model}</span> : null}
                    {row.host ? <span className="text-white/25"> · {row.host}</span> : null}
                  </>
                ) : (
                  <span className="text-amber-300">nothing configured</span>
                )}
              </span>
              {row.status === "ok" && row.latencyMs !== null && (
                <span className="shrink-0 tabular-nums text-white/30">{row.latencyMs}ms</span>
              )}
              <span className={`w-24 shrink-0 text-right ${textFor(row.status)}`}>{row.status}</span>
            </button>
            {row.status !== "ok" && row.detail && (
              <p className="px-2 pb-1.5 pl-9 text-[11px] text-white/35">{row.detail}</p>
            )}
          </li>
        ))}
        {rows === null && checking && <p className="text-xs text-white/35">Checking five hosts…</p>}
      </ul>

      <p className="mt-2 text-[11px] text-white/30">
        A check times out after 4 seconds — a provider reported unreachable may simply be a pod
        that is stopped, or a host slower than the badge is willing to wait for. Jobs use the full
        timeout regardless of what this says.
      </p>
    </section>
  );
}

function dotFor(status: Health["status"]): string {
  if (status === "ok") return "bg-emerald-400";
  if (status === "unreachable") return "bg-red-400";
  return "bg-amber-300";
}

function textFor(status: Health["status"]): string {
  if (status === "ok") return "text-emerald-400";
  if (status === "unreachable") return "text-red-400";
  return "text-amber-300";
}
