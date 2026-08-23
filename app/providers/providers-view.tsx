"use client";

import { useState } from "react";
import { RunpodPanel, type Compute } from "./runpod-panel";
import { ProviderStatusPanel } from "./provider-status-panel";
import { ROLES_BY_KIND, WorkflowSection, type Workflow } from "./workflow-editor";

type Provider = {
  id: string;
  kind: "llm" | "image" | "audio" | "asr" | "video";
  adapter: "sdapi" | "comfyui";
  name: string;
  baseUrl: string;
  model: string;
  defaultParams: Record<string, unknown>;
  negativePrompt: string;
  isDefault: boolean;
  hasApiKey: boolean;
  compute: Compute;
};

const KINDS = [
  { key: "llm", label: "LLM" },
  { key: "image", label: "Image" },
  { key: "audio", label: "Audio (TTS)" },
  { key: "asr", label: "ASR" },
  { key: "video", label: "Video" },
] as const;
type Kind = (typeof KINDS)[number]["key"];

// The two diffusion kinds are the only ones a negative prompt means anything
// to — every other kind stores "" and never reads it.
const HAS_NEGATIVE_PROMPT = new Set<Kind>(["image", "video"]);

// Which adapters can serve a kind. Mirrors ADAPTER_KINDS in lib/providers.ts;
// the server rejects an impossible pair anyway, but offering it in a dropdown
// and then failing is a worse way to find out.
const ADAPTERS_FOR: Record<Kind, { key: Adapter; label: string }[]> = {
  llm: [{ key: "sdapi", label: "sd-api" }],
  image: [
    { key: "sdapi", label: "sd-api" },
    { key: "comfyui", label: "ComfyUI" },
  ],
  audio: [{ key: "sdapi", label: "sd-api" }],
  asr: [{ key: "sdapi", label: "sd-api" }],
  video: [{ key: "comfyui", label: "ComfyUI" }],
};
type Adapter = "sdapi" | "comfyui";

/** ComfyUI has no model name: the checkpoint is a loader node in the workflow. */
const NEEDS_MODEL = (adapter: Adapter) => adapter === "sdapi";

function parseParams(text: string): { value: Record<string, unknown> | null; error: string | null } {
  try {
    const parsed = JSON.parse(text || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: "Params must be a JSON object" };
    }
    return { value: parsed, error: null };
  } catch {
    return { value: null, error: "Params must be valid JSON" };
  }
}

export function ProvidersView({
  providers,
  workflows,
}: {
  providers: Provider[];
  workflows: Workflow[];
}) {
  const [tab, setTab] = useState<Kind>("llm");
  const [rows, setRows] = useState(providers);
  const [flows, setFlows] = useState(workflows);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
      <p className="mt-2 text-sm text-white/45">
        Where each kind of inference call goes. Exactly one provider per kind is the default —
        stages use whichever is marked default, falling back to any provider of that kind.
      </p>

      {/* The reachability of the five defaults, in the one place that can do
          something about it. This is what the home page's single "sd-api
          reachable" badge was standing in for, and it was standing in badly:
          it probed one URL from the config regardless of which providers a
          run would actually call. */}
      <ProviderStatusPanel onSelectKind={setTab} />

      <nav className="mt-6 flex gap-1 border-b border-white/10">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setTab(k.key)}
            className={`px-3 py-2 text-sm transition ${
              tab === k.key
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {k.label}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        <KindTab
          key={tab}
          kind={tab}
          rows={rows.filter((r) => r.kind === tab)}
          onChange={setRows}
          all={rows}
          workflows={flows}
          onWorkflowsChange={setFlows}
        />
      </div>
    </main>
  );
}

const emptyForm = (kind: Kind) => ({
  kind,
  adapter: ADAPTERS_FOR[kind][0]!.key,
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  isDefault: false,
  paramsText: "{}",
  negativePrompt: "",
});

function KindTab({
  kind,
  rows,
  all,
  onChange,
  workflows,
  onWorkflowsChange,
}: {
  kind: Kind;
  rows: Provider[];
  all: Provider[];
  onChange: (rows: Provider[]) => void;
  workflows: Workflow[];
  onWorkflowsChange: (workflows: Workflow[]) => void;
}) {
  const [form, setForm] = useState(emptyForm(kind));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    const { value: defaultParams, error: paramsError } = parseParams(form.paramsText);
    if (paramsError) return setError(paramsError);

    setBusy(true);
    setError(null);
    const response = await fetch("/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: form.kind,
        adapter: form.adapter,
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey.trim() || undefined,
        model: form.model,
        isDefault: form.isDefault,
        defaultParams,
        ...(HAS_NEGATIVE_PROMPT.has(kind) ? { negativePrompt: form.negativePrompt } : {}),
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create provider");
    } else {
      const created = body.provider as Provider;
      // A new default demotes its sibling server-side; reflect that locally
      // too, or the list would show two defaults until the next reload.
      const next = created.isDefault
        ? all.map((p) => (p.kind === created.kind ? { ...p, isDefault: false } : p))
        : all;
      onChange([...next, created]);
      setForm(emptyForm(kind));
    }
    setBusy(false);
  }

  async function save(id: string, patch: Record<string, unknown>): Promise<string | null> {
    const response = await fetch(`/api/providers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await response.json();
    if (!response.ok) return body.error ?? "Could not save";
    const updated = body.provider as Provider;
    const next = updated.isDefault
      ? all.map((p) => (p.kind === updated.kind && p.id !== id ? { ...p, isDefault: false } : p))
      : all;
    onChange(next.map((p) => (p.id === id ? updated : p)));
    return null;
  }

  async function remove(id: string): Promise<string | null> {
    const response = await fetch(`/api/providers/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(all.filter((p) => p.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      {rows.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onSave={save}
          onDelete={remove}
          workflows={workflows.filter((w) => w.providerId === provider.id)}
          onWorkflowsChange={(next) => {
            const others = workflows.filter((w) => w.providerId !== provider.id);
            onWorkflowsChange([...others, ...next]);
          }}
        />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New {KINDS.find((k) => k.key === kind)!.label} provider
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          {ADAPTERS_FOR[kind].length > 1 && (
            <label className="block">
              <span className="block text-xs text-white/45">Adapter</span>
              <select
                value={form.adapter}
                onChange={(event) =>
                  setForm({ ...form, adapter: event.target.value as Adapter, model: "" })
                }
                className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
              >
                {ADAPTERS_FOR[kind].map((adapter) => (
                  <option key={adapter.key} value={adapter.key}>
                    {adapter.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Field
            label="Base URL"
            value={form.baseUrl}
            onChange={(v) => setForm({ ...form, baseUrl: v })}
          />
          {NEEDS_MODEL(form.adapter) && (
            <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          )}
          <Field
            label="API key (leave blank for a local provider with none)"
            value={form.apiKey}
            onChange={(v) => setForm({ ...form, apiKey: v })}
          />
          <Field
            label="Default params (JSON)"
            value={form.paramsText}
            onChange={(v) => setForm({ ...form, paramsText: v })}
            multiline
          />
          {HAS_NEGATIVE_PROMPT.has(kind) && (
            <Field
              label="Negative prompt"
              value={form.negativePrompt}
              onChange={(v) => setForm({ ...form, negativePrompt: v })}
            />
          )}
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
            />
            Make this the default {kind} provider
          </label>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          onClick={create}
          disabled={busy || !form.name || !form.baseUrl || (NEEDS_MODEL(form.adapter) && !form.model)}
          className="mt-3 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          Create
        </button>
      </section>
    </div>
  );
}

function ProviderCard({
  provider,
  onSave,
  onDelete,
  workflows,
  onWorkflowsChange,
}: {
  provider: Provider;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  workflows: Workflow[];
  onWorkflowsChange: (workflows: Workflow[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    model: provider.model,
    isDefault: provider.isDefault,
    paramsText: JSON.stringify(provider.defaultParams, null, 2),
    negativePrompt: provider.negativePrompt,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const missingRoles =
    provider.adapter === "comfyui"
      ? ROLES_BY_KIND[provider.kind as "image" | "video"].filter(
          (role) => !workflows.some((w) => w.role === role),
        )
      : [];

  async function save() {
    const { value: defaultParams, error: paramsError } = parseParams(form.paramsText);
    if (paramsError) return setError(paramsError);

    setBusy(true);
    const err = await onSave(provider.id, {
      name: form.name,
      baseUrl: form.baseUrl,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(provider.adapter === "sdapi" ? { model: form.model } : {}),
      isDefault: form.isDefault,
      defaultParams,
      ...(HAS_NEGATIVE_PROMPT.has(provider.kind) ? { negativePrompt: form.negativePrompt } : {}),
    });
    setError(err);
    setBusy(false);
    if (!err) setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(await onDelete(provider.id));
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {provider.name}{" "}
          {provider.isDefault && <span className="text-xs text-amber-300">default</span>}
        </h3>
        <div className="flex gap-3 text-xs text-white/40">
          <button onClick={() => setEditing((v) => !v)} className="hover:text-amber-300">
            {editing ? "cancel" : "edit"}
          </button>
          <button onClick={remove} disabled={busy} className="hover:text-red-300">
            delete
          </button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-white/30">
        {provider.adapter === "comfyui" ? "ComfyUI" : provider.model} · {provider.baseUrl} ·{" "}
        {provider.hasApiKey ? "api key set" : "no api key"}
        {provider.adapter === "comfyui" && (
          <>
            {" · "}
            <span className={missingRoles.length > 0 ? "text-amber-300" : "text-emerald-300/70"}>
              {workflows.length}/{ROLES_BY_KIND[provider.kind as "image" | "video"].length} workflows
            </span>
          </>
        )}
      </p>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          {/*
            The adapter is fixed once a row exists. Switching it would strand
            whatever the row was configured for — a ComfyUI provider's
            workflows mean nothing to sd-api, and an sd-api provider's model
            name means nothing to ComfyUI. Delete and recreate instead.
          */}
          <Field
            label="Base URL"
            value={form.baseUrl}
            onChange={(v) => setForm({ ...form, baseUrl: v })}
          />
          {provider.adapter === "sdapi" && (
            <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          )}
          <Field
            label={provider.hasApiKey ? "Replace API key (leave blank to keep it)" : "API key"}
            value={form.apiKey}
            onChange={(v) => setForm({ ...form, apiKey: v })}
          />
          <Field
            label="Default params (JSON)"
            value={form.paramsText}
            onChange={(v) => setForm({ ...form, paramsText: v })}
            multiline
          />
          {HAS_NEGATIVE_PROMPT.has(provider.kind) && (
            <Field
              label="Negative prompt"
              value={form.negativePrompt}
              onChange={(v) => setForm({ ...form, negativePrompt: v })}
            />
          )}
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
            />
            Default {provider.kind} provider
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={save}
            disabled={busy}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}
      {provider.adapter === "comfyui" && (
        <RunpodPanel
          baseUrl={provider.baseUrl}
          compute={provider.compute}
          onSave={(patch) => onSave(provider.id, patch)}
        />
      )}

      {provider.adapter === "comfyui" && (
        <WorkflowSection
          providerId={provider.id}
          kind={provider.kind as "image" | "video"}
          workflows={workflows}
          onChange={onWorkflowsChange}
        />
      )}

      {!editing && error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-white/45">{label}</span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
        />
      )}
    </label>
  );
}
