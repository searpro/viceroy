"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PAGE_SHELL } from "@/app/components/page-shell";
import { formatLabel, isDevFormat, jobTypeLabel } from "@/lib/labels";

type Project = { id: string; idea: string; title: string | null; format: string };
type Template = { key: string; vars: Record<string, string> };

export type TraceSummary = {
  id: string;
  jobId: string;
  projectId: string | null;
  stage: string;
  kind: "llm" | "image" | "video";
  operation: string;
  sequence: number;
  attempt: number;
  providerName: string;
  adapter: string;
  model: string;
  templates: Template[];
  ok: boolean;
  error: string | null;
  durationMs: number;
  createdAt: string;
  promptPreview: string | null;
  responsePreview: string | null;
  responseLength: number;
  project: Project | null;
};

type TraceDetail = Omit<TraceSummary, "promptPreview" | "responsePreview" | "responseLength"> & {
  providerId: string | null;
  baseUrl: string;
  requestPath: string;
  request: Record<string, unknown>;
  resolved: Record<string, unknown> | null;
  response: string | null;
  responseMeta: Record<string, unknown> | null;
};

export type TraceFilterState = {
  kind: string;
  stage: string;
  failed: boolean;
  jobId: string | null;
  projectId: string | null;
};

const KINDS = [
  { key: "", label: "All" },
  { key: "llm", label: "LLM" },
  { key: "image", label: "Image" },
  { key: "video", label: "Video" },
] as const;

/**
 * Every generation request the pipeline has made, and what came back.
 *
 * The Jobs screen answers "did the stage run"; this answers "what did it
 * send". Those are different questions and only the second one is actionable
 * when the output is wrong — a stage that logs `Generating concept with
 * qwen3-30b` and returns nonsense could have a broken template, an empty
 * variable, the wrong provider row, or a model that simply answered badly,
 * and the log line distinguishes none of them.
 */
export function TracesView({
  initial,
  stages,
  limit,
  initialFilters,
}: {
  initial: TraceSummary[];
  stages: string[];
  limit: number;
  initialFilters: TraceFilterState;
}) {
  const [traces, setTraces] = useState(initial);
  const [stageOptions, setStageOptions] = useState(stages);
  const [filters, setFilters] = useState(initialFilters);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The first render already holds the server's answer for these exact
  // filters; refetching it immediately would just replace the list with
  // itself, one round trip after paint.
  const primed = useRef(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.stage) params.set("stage", filters.stage);
    if (filters.failed) params.set("failed", "1");
    if (filters.jobId) params.set("jobId", filters.jobId);
    if (filters.projectId) params.set("projectId", filters.projectId);
    return params.toString();
  }, [filters]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/traces?${query}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) {
      const payload = await response.json();
      setTraces(payload.traces);
      setStageOptions(payload.stages);
    }
    setLoading(false);
  }, [query]);

  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      return;
    }
    void refresh();
  }, [refresh]);

  const scoped = filters.jobId ?? filters.projectId;

  return (
    <main className={`${PAGE_SHELL} py-10`}>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="text-xs text-white/40 transition hover:text-white/70 disabled:opacity-30"
        >
          {loading ? "loading…" : "refresh"}
        </button>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/45">
        Every request the pipeline sent to a model, newest first — the prompt as it was actually
        composed, which template produced it, the provider and settings it ran against, and the raw
        response before anything parsed it.
      </p>

      <nav className="mt-6 flex flex-wrap items-center gap-1 border-b border-white/10">
        {KINDS.map((kind) => (
          <button
            key={kind.key}
            onClick={() => setFilters((current) => ({ ...current, kind: kind.key }))}
            className={`px-3 py-2 text-sm transition ${
              filters.kind === kind.key
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {kind.label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3 pb-1.5">
          <label className="flex items-center gap-1.5 text-xs text-white/40">
            <input
              type="checkbox"
              checked={filters.failed}
              onChange={(event) => setFilters((c) => ({ ...c, failed: event.target.checked }))}
              className="accent-amber-400"
            />
            failed only
          </label>
          <select
            value={filters.stage}
            onChange={(event) => setFilters((c) => ({ ...c, stage: event.target.value }))}
            className="rounded-md border border-white/10 bg-surface-raised px-2 py-1 text-xs text-white/70"
          >
            <option value="">every stage</option>
            {stageOptions.map((stage) => (
              <option key={stage} value={stage}>
                {jobTypeLabel(stage)}
              </option>
            ))}
          </select>
        </div>
      </nav>

      {scoped && (
        <p className="mt-3 flex items-center gap-2 text-xs text-white/40">
          <span>
            Scoped to {filters.jobId ? "one job" : "one project"}
            {filters.jobId && <span className="ml-1.5 font-mono text-white/30">{filters.jobId}</span>}
          </span>
          <button
            onClick={() => setFilters((c) => ({ ...c, jobId: null, projectId: null }))}
            className="text-amber-300/80 transition hover:text-amber-300"
          >
            show everything
          </button>
        </p>
      )}

      {traces.length >= limit && (
        <p className="mt-3 text-xs text-white/30">
          Showing the newest {limit} calls. Traces are removed with their job, so
          &ldquo;clear finished&rdquo; on the Jobs screen is what prunes them.
        </p>
      )}

      <ul className="mt-4 space-y-1.5">
        {traces.length === 0 && (
          <p className="text-sm text-white/35">
            Nothing here.{" "}
            {filters.jobId
              ? "This job made no provider calls — assembly stages like the story bible and the production plan compose their output from earlier artifacts and never call a model."
              : "Traces are recorded by the worker as it runs, and are removed along with their job."}
          </p>
        )}
        {traces.map((trace) => (
          <TraceRow
            key={trace.id}
            trace={trace}
            open={openId === trace.id}
            onToggle={() => setOpenId((current) => (current === trace.id ? null : trace.id))}
            onScopeJob={() => setFilters((c) => ({ ...c, jobId: trace.jobId, projectId: null }))}
          />
        ))}
      </ul>
    </main>
  );
}

function TraceRow({
  trace,
  open,
  onToggle,
  onScopeJob,
}: {
  trace: TraceSummary;
  open: boolean;
  onToggle: () => void;
  onScopeJob: () => void;
}) {
  return (
    <li className="rounded-md border border-white/10 bg-white/[0.02]">
      <button onClick={onToggle} className="w-full px-3 py-2 text-left">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className={`size-1.5 shrink-0 rounded-full ${trace.ok ? "bg-emerald-400" : "bg-red-400"}`} />
          <KindBadge kind={trace.kind} />
          <span className="w-40 shrink-0 truncate text-white/85" title={trace.stage}>
            {jobTypeLabel(trace.stage)}
          </span>
          <span className="w-16 shrink-0 truncate text-white/35" title={trace.operation}>
            {trace.operation}
          </span>
          <span className="min-w-0 flex-1 truncate text-white/45" title={`${trace.providerName} · ${trace.model}`}>
            {trace.model || trace.providerName || "—"}
          </span>
          <span className="shrink-0 tabular-nums text-white/35">{formatDuration(trace.durationMs)}</span>
          {/* `toLocaleTimeString` resolves against the renderer's locale and
              timezone, so the server's string and the browser's differ and
              React refuses to hydrate — which silently killed every click on
              this list, not just the timestamp. Suppressed rather than
              formatted in UTC: the useful question is what time it was *here*
              when the call went out. */}
          <span suppressHydrationWarning className="shrink-0 text-white/25">
            {new Date(trace.createdAt).toLocaleTimeString()}
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          {trace.templates.map((template) => (
            <span key={template.key} className="shrink-0 rounded bg-sky-400/10 px-1.5 py-0.5 font-mono text-sky-300/90">
              {template.key}
            </span>
          ))}
          <span className="min-w-0 flex-1 truncate text-white/30">{trace.promptPreview ?? ""}</span>
        </div>

        {!trace.ok && trace.error && (
          <p className="mt-1.5 line-clamp-2 text-[11px] text-red-300/90">{trace.error}</p>
        )}
      </button>

      {open && <TraceDetailPanel id={trace.id} trace={trace} onScopeJob={onScopeJob} />}
    </li>
  );
}

function TraceDetailPanel({
  id,
  trace,
  onScopeJob,
}: {
  id: string;
  trace: TraceSummary;
  onScopeJob: () => void;
}) {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch(`/api/traces/${id}`, { cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (!response?.ok) {
        setError("Could not load this trace.");
        return;
      }
      setDetail((await response.json()).trace);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <p className="border-t border-white/5 px-3 py-3 text-xs text-red-300/90">{error}</p>;
  if (!detail) return <p className="border-t border-white/5 px-3 py-3 text-xs text-white/30">loading…</p>;

  const messages = asMessages(detail.request.messages);

  return (
    <div className="space-y-4 border-t border-white/5 px-3 py-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px]">
        <Fact label="provider">{detail.providerName || "—"}</Fact>
        <Fact label="model">{detail.model || "—"}</Fact>
        {detail.adapter && <Fact label="adapter">{detail.adapter}</Fact>}
        {/* The host and path together are the whole of BUG-28: the same
            provider row against the wrong one of two chat paths fails in a way
            that looks like a bad model, not a bad route. */}
        <Fact label="host">
          {detail.baseUrl || "—"}
          {detail.requestPath}
        </Fact>
        <Fact label="call">
          #{detail.sequence}
          {detail.attempt > 1 && <span className="text-amber-300/80"> · attempt {detail.attempt}</span>}
        </Fact>
        <Fact label="took">{formatDuration(detail.durationMs)}</Fact>
        {typeof detail.responseMeta?.completionTokens === "number" && (
          <Fact label="completion tokens">{String(detail.responseMeta.completionTokens)}</Fact>
        )}
        {typeof detail.responseMeta?.bytes === "number" && (
          <Fact label="result">{formatBytes(detail.responseMeta.bytes)}</Fact>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        {detail.project && (
          <Link href={`/projects/${detail.project.id}`} className="flex items-center gap-1.5 text-white/50 transition hover:text-amber-300">
            <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              isDevFormat(detail.project.format) ? "bg-sky-400/10 text-sky-300" : "bg-white/5 text-white/40"
            }`}>
              {formatLabel(detail.project.format, true)}
            </span>
            {detail.project.title ?? detail.project.idea}
          </Link>
        )}
        {trace.jobId && (
          <button onClick={onScopeJob} className="text-white/40 transition hover:text-amber-300">
            everything this job sent
          </button>
        )}
      </div>

      {detail.templates.length > 0 && (
        <Section title="Rendered from">
          <div className="space-y-3">
            {detail.templates.map((template) => (
              <div key={template.key} className="rounded-md border border-white/10 bg-black/20 p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-sky-300/90">{template.key}</span>
                  <Link
                    href={`/prompt-templates?key=${encodeURIComponent(template.key)}`}
                    className="shrink-0 text-[11px] text-white/35 transition hover:text-amber-300"
                  >
                    edit template →
                  </Link>
                </div>
                {Object.keys(template.vars).length > 0 && (
                  <dl className="mt-2 space-y-1">
                    {Object.entries(template.vars).map(([name, value]) => (
                      <div key={name} className="flex gap-3 text-[11px]">
                        <dt className="w-40 shrink-0 truncate font-mono text-white/40">{`{{${name}}}`}</dt>
                        <dd className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                          value.trim() === "" ? "text-amber-300/70" : "text-white/55"
                        }`}>
                          {/* An empty variable is the single most common cause
                              of a prompt that reads fine and produces nothing —
                              it has to be visible, not an invisible gap. */}
                          {value.trim() === "" ? "(empty)" : value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {messages ? (
        <Section title="Prompt" copy={messages.map((m) => m.content).join("\n\n")}>
          <div className="space-y-2">
            {messages.map((message, index) => (
              <div key={index} className="rounded-md border border-white/10 bg-black/20">
                <p className="border-b border-white/5 px-2.5 py-1 text-[10px] uppercase tracking-wide text-white/35">
                  {message.role}
                </p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-relaxed text-white/70">
                  {message.content}
                </pre>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="Request" copy={JSON.stringify(detail.request, null, 2)}>
          <Json value={detail.request} />
        </Section>
      )}

      {detail.resolved && (
        <Section
          title="Resolved configuration"
          note="What the adapter turned the request into — steps, cfg, sampler and seed live here, not in the stage."
          copy={JSON.stringify(detail.resolved, null, 2)}
        >
          <Json value={detail.resolved} />
        </Section>
      )}

      {detail.response !== null && (
        <Section title="Response" note="Raw, before any JSON extraction." copy={detail.response}>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-white/70">
            {detail.response}
          </pre>
        </Section>
      )}

      {detail.error && (
        <Section title="Error">
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-400/20 bg-red-400/5 px-2.5 py-2 font-mono text-[11px] text-red-300/90">
            {detail.error}
          </pre>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  note,
  copy,
  children,
}: {
  title: string;
  note?: string;
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[10px] uppercase tracking-wider text-white/35">{title}</h2>
        {copy && <CopyButton value={copy} />}
      </div>
      {note && <p className="mb-1.5 text-[11px] text-white/30">{note}</p>}
      {children}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-[11px] text-white/30 transition hover:text-amber-300"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Json({ value }: { value: Record<string, unknown> }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-white/60">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-white/25">{label}</span>
      <span className="text-white/60">{children}</span>
    </span>
  );
}

function KindBadge({ kind }: { kind: TraceSummary["kind"] }) {
  const tone =
    kind === "llm"
      ? "bg-violet-400/10 text-violet-300"
      : kind === "image"
        ? "bg-emerald-400/10 text-emerald-300"
        : "bg-amber-400/10 text-amber-300";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>{kind}</span>
  );
}

/**
 * The messages of a chat request, if this is one.
 *
 * Rendering an LLM prompt as pretty-printed JSON puts every newline in the
 * prompt through `\n` — which is exactly the text you are trying to read.
 * Image requests have no messages and fall back to the JSON view.
 */
function asMessages(value: unknown): { role: string; content: string }[] | null {
  if (!Array.isArray(value)) return null;
  const messages = value.filter(
    (entry): entry is { role: string; content: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { role?: unknown }).role === "string" &&
      typeof (entry as { content?: unknown }).content === "string",
  );
  return messages.length === value.length && messages.length > 0 ? messages : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
