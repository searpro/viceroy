"use client";

import { useCallback, useEffect, useState } from "react";

export type Compute = {
  kind: "runpod";
  podId: string;
  port: number;
  idleStopMinutes?: number;
} | null;

type PodInfo = {
  id: string;
  name: string;
  status: string;
  costPerHr: number | null;
  uptimeMs: number | null;
  httpPorts: number[];
  proxyUrl: string;
  gpu: string | null;
  gpuCount: number | null;
};

type Spend = { total: number; billedMs: number; from: string; to: string } | null;

type PodSummary = {
  id: string;
  name: string;
  status: string;
  costPerHr: number | null;
  httpPorts: number[];
  uptimeMs: number | null;
};

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const money = (value: number) => `$${value.toFixed(2)}`;

function statusColour(status: string): string {
  if (status === "RUNNING") return "text-emerald-300";
  if (status === "EXITED") return "text-white/40";
  return "text-amber-300";
}

/**
 * Start/stop and cost for the pod a ComfyUI provider runs on.
 *
 * Kept out of the provider's edit form deliberately: the fields there describe
 * how to talk to a host, while these buttons spend money and change the state
 * of a machine. Mixing them would put "stop the pod" one stray click from
 * "save the base URL".
 */
export function RunpodPanel({
  baseUrl,
  compute,
  onSave,
}: {
  baseUrl: string;
  compute: Compute;
  onSave: (patch: Record<string, unknown>) => Promise<string | null>;
}) {
  const [pods, setPods] = useState<PodSummary[] | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [info, setInfo] = useState<PodInfo | null>(null);
  const [spend, setSpend] = useState<Spend>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [podId, setPodId] = useState(compute?.podId ?? "");
  const [port, setPort] = useState(String(compute?.port ?? 8188));

  const refresh = useCallback(async () => {
    if (!compute?.podId) return;
    const response = await fetch(
      `/api/runpod/pods/${compute.podId}?port=${compute.port}`,
    ).then((r) => r.json());

    setConfigured(response.configured ?? null);
    if (response.error) {
      setError(response.error);
      setInfo(null);
      return;
    }
    setError(null);
    setInfo(response.pod ?? null);
    setSpend(response.spend ?? null);
  }, [compute?.podId, compute?.port]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadPods() {
    setBusy(true);
    const response = await fetch("/api/runpod/pods").then((r) => r.json());
    setConfigured(response.configured ?? false);
    setPods(response.pods ?? []);
    setError(response.error ?? null);
    setBusy(false);
  }

  async function act(action: "start" | "stop") {
    if (!compute?.podId) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/runpod/pods/${compute.podId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).then((r) => r.json());

    if (response.error) setError(response.error);
    else await refresh();
    setBusy(false);
  }

  async function link() {
    const parsedPort = Number(port);
    if (!podId.trim() || !Number.isInteger(parsedPort) || parsedPort <= 0) {
      return setError("A pod id and a numeric port are both required");
    }

    setBusy(true);
    // The base URL is derived rather than typed: pod id plus port *is* the
    // address, so letting them disagree would mean a provider pointing at a
    // pod it does not control.
    const saveError = await onSave({
      compute: { kind: "runpod", podId: podId.trim(), port: parsedPort },
      baseUrl: `https://${podId.trim()}-${parsedPort}.proxy.runpod.net`,
    });
    setError(saveError);
    setBusy(false);
  }

  async function unlink() {
    setBusy(true);
    setError(await onSave({ compute: null }));
    setInfo(null);
    setBusy(false);
  }

  return (
    <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h5 className="text-xs font-medium">RunPod</h5>
        {compute?.podId && (
          <button
            onClick={refresh}
            disabled={busy}
            className="text-[11px] text-white/40 transition hover:text-amber-300 disabled:opacity-40"
          >
            refresh
          </button>
        )}
      </div>

      {configured === false && (
        <p className="mt-2 text-[11px] text-amber-300">
          RUNPOD_API_KEY is not set, so the pod cannot be controlled from here. Set it in the
          environment and restart the dev server.
        </p>
      )}

      {compute?.podId ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px]">
            <span className="font-mono text-white/60">{compute.podId}</span>
            <span className={statusColour(info?.status ?? "")}>{info?.status ?? "…"}</span>
            {info?.gpu && (
              <span className="text-white/35">
                {info.gpuCount && info.gpuCount > 1 ? `${info.gpuCount}× ` : ""}
                {info.gpu}
              </span>
            )}
            {info?.uptimeMs !== null && info?.uptimeMs !== undefined && (
              <span className="text-white/35">up {formatDuration(info.uptimeMs)}</span>
            )}
          </div>

          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px]">
            {info?.costPerHr != null && (
              <span className="text-white/45">
                {money(info.costPerHr)}/hr
                {info.status === "RUNNING" && info.uptimeMs != null && (
                  <span className="text-white/30">
                    {" "}
                    · this session ≈ {money((info.costPerHr * info.uptimeMs) / 3_600_000)}
                  </span>
                )}
              </span>
            )}
            {spend && (
              // Real billing records, not rate × uptime — a stopped pod still
              // bills for its disk, which a rate calculation would miss
              // exactly when someone is checking whether stopping helped.
              <span className="text-white/45">
                last 30d: {money(spend.total)}
                <span className="text-white/30">
                  {" "}
                  · {formatDuration(spend.billedMs)} billed
                </span>
              </span>
            )}
          </div>

          {info && info.httpPorts.length > 0 && !info.httpPorts.includes(compute.port) && (
            <p className="text-[11px] text-amber-300">
              This pod exposes {info.httpPorts.join(", ")} over HTTP, but the provider is pointed at{" "}
              {compute.port}.
            </p>
          )}
          {info && info.proxyUrl !== baseUrl.replace(/\/$/, "") && (
            <p className="text-[11px] text-amber-300">
              The provider&rsquo;s base URL is {baseUrl}, which is not this pod&rsquo;s proxy URL
              ({info.proxyUrl}).
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => act("start")}
              disabled={busy || info?.status === "RUNNING"}
              className="rounded-md bg-emerald-400/90 px-3 py-1.5 text-[11px] font-medium text-black transition hover:bg-emerald-300 disabled:opacity-30"
            >
              Start
            </button>
            <button
              onClick={() => act("stop")}
              disabled={busy || info?.status !== "RUNNING"}
              className="rounded-md border border-white/20 px-3 py-1.5 text-[11px] transition hover:border-red-400/60 hover:text-red-300 disabled:opacity-30"
            >
              Stop
            </button>
            <button
              onClick={unlink}
              disabled={busy}
              className="text-[11px] text-white/40 transition hover:text-red-300 disabled:opacity-40"
            >
              unlink
            </button>
          </div>

          {info?.status !== "RUNNING" && info && (
            <p className="text-[10px] text-white/30">
              Starting is not the same as ready: the first generation after a start also waits for
              the model to load, around half a minute for a 4B image model.
            </p>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] leading-relaxed text-white/35">
            Link a pod to control it from here. The base URL is derived from the id and port, so it
            stays correct when a pod is rebuilt.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={podId}
              onChange={(event) => setPodId(event.target.value)}
              placeholder="pod id"
              className="min-w-40 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] outline-none focus:border-white/25"
            />
            <input
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="port"
              className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] outline-none focus:border-white/25"
            />
            <button
              onClick={link}
              disabled={busy || !podId.trim()}
              className="rounded-md bg-amber-400 px-3 py-1.5 text-[11px] font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
            >
              Link
            </button>
          </div>

          <div>
            <button
              onClick={loadPods}
              disabled={busy}
              className="text-[11px] text-white/40 transition hover:text-amber-300 disabled:opacity-40"
            >
              {busy ? "loading…" : "list my pods"}
            </button>
            {pods && pods.length > 0 && (
              <ul className="mt-1 space-y-1">
                {pods.map((pod) => (
                  <li key={pod.id} className="flex items-baseline gap-2 text-[11px]">
                    <button
                      onClick={() => {
                        setPodId(pod.id);
                        if (pod.httpPorts[0]) setPort(String(pod.httpPorts[0]));
                      }}
                      className="font-mono text-white/60 underline decoration-white/20 hover:text-amber-300"
                    >
                      {pod.id}
                    </button>
                    <span className="text-white/45">{pod.name}</span>
                    <span className={statusColour(pod.status)}>{pod.status}</span>
                    {pod.costPerHr != null && (
                      <span className="text-white/30">{money(pod.costPerHr)}/hr</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {pods && pods.length === 0 && !error && (
              <p className="mt-1 text-[11px] text-white/30">No pods on this account.</p>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
