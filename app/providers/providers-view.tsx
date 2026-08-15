"use client";

import Link from "next/link";
import { useState } from "react";

type Provider = {
  id: string;
  kind: "llm" | "image" | "audio" | "asr";
  name: string;
  baseUrl: string;
  model: string;
  defaultParams: Record<string, unknown>;
  negativePrompt: string;
  isDefault: boolean;
  hasApiKey: boolean;
};

const KINDS = [
  { key: "llm", label: "LLM" },
  { key: "image", label: "Image" },
  { key: "audio", label: "Audio (TTS)" },
  { key: "asr", label: "ASR" },
] as const;
type Kind = (typeof KINDS)[number]["key"];

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

export function ProvidersView({ providers }: { providers: Provider[] }) {
  const [tab, setTab] = useState<Kind>("llm");
  const [rows, setRows] = useState(providers);

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Providers</h1>
      <p className="mt-2 text-sm text-white/45">
        Where each kind of inference call goes. Exactly one provider per kind is the default —
        stages use whichever is marked default, falling back to any provider of that kind.
      </p>

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
        />
      </div>
    </main>
  );
}

const emptyForm = (kind: Kind) => ({
  kind,
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
}: {
  kind: Kind;
  rows: Provider[];
  all: Provider[];
  onChange: (rows: Provider[]) => void;
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
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey.trim() || undefined,
        model: form.model,
        isDefault: form.isDefault,
        defaultParams,
        ...(kind === "image" ? { negativePrompt: form.negativePrompt } : {}),
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
        <ProviderCard key={provider.id} provider={provider} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New {KINDS.find((k) => k.key === kind)!.label} provider
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Base URL"
            value={form.baseUrl}
            onChange={(v) => setForm({ ...form, baseUrl: v })}
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
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
          {kind === "image" && (
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
          disabled={busy || !form.name || !form.baseUrl || !form.model}
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
}: {
  provider: Provider;
  onSave: (id: string, patch: Record<string, unknown>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
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

  async function save() {
    const { value: defaultParams, error: paramsError } = parseParams(form.paramsText);
    if (paramsError) return setError(paramsError);

    setBusy(true);
    const err = await onSave(provider.id, {
      name: form.name,
      baseUrl: form.baseUrl,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      model: form.model,
      isDefault: form.isDefault,
      defaultParams,
      ...(provider.kind === "image" ? { negativePrompt: form.negativePrompt } : {}),
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
        {provider.model} · {provider.baseUrl} ·{" "}
        {provider.hasApiKey ? "api key set" : "no api key"}
      </p>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Base URL"
            value={form.baseUrl}
            onChange={(v) => setForm({ ...form, baseUrl: v })}
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
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
          {provider.kind === "image" && (
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
