"use client";

import Link from "next/link";
import { useState } from "react";

type NarrativeStyle = {
  id: string;
  name: string;
  description: string;
  plannerGuidance: string;
  writingGuidance: string;
  visualGuidance: string;
  evaluationChecklist: { key: string; description: string }[];
  targetSceneCount: number;
  targetWordCount: number;
  isBuiltin: boolean;
};

type VoiceStyle = {
  id: string;
  name: string;
  description: string;
  ttsInstruct: string;
  deliveryCues: string;
  model: string;
  isBuiltin: boolean;
};

type ImageStyle = {
  id: string;
  name: string;
  description: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
  model: string;
  defaultParams: Record<string, number | string>;
  isBuiltin: boolean;
};

const TABS = [
  { key: "narrative", label: "Narrative" },
  { key: "voice", label: "Voice" },
  { key: "image", label: "Image" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function StylesView({
  narrativeStyles,
  voiceStyles,
  imageStyles,
}: {
  narrativeStyles: NarrativeStyle[];
  voiceStyles: VoiceStyle[];
  imageStyles: ImageStyle[];
}) {
  const [tab, setTab] = useState<Tab>("narrative");
  const [narrative, setNarrative] = useState(narrativeStyles);
  const [voice, setVoice] = useState(voiceStyles);
  const [image, setImage] = useState(imageStyles);

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Styles</h1>
      <p className="mt-2 text-sm text-white/45">
        Narrative, voice and image styles a project can be built with. Built-in styles can be
        edited but not deleted.
      </p>

      <nav className="mt-6 flex gap-1 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm transition ${
              tab === t.key
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === "narrative" && <NarrativeTab styles={narrative} onChange={setNarrative} />}
        {tab === "voice" && <VoiceTab styles={voice} onChange={setVoice} />}
        {tab === "image" && <ImageTab styles={image} onChange={setImage} />}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------- narrative */

const EMPTY_NARRATIVE = {
  name: "",
  description: "",
  plannerGuidance: "",
  writingGuidance: "",
  visualGuidance: "",
  checklistText: "",
  targetSceneCount: 8,
  targetWordCount: 320,
};

function checklistToText(checklist: { key: string; description: string }[]): string {
  return checklist.map((c) => `${c.key}: ${c.description}`).join("\n");
}

function textToChecklist(text: string): { key: string; description: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":");
      return { key: (key ?? "").trim(), description: rest.join(":").trim() };
    })
    .filter((c) => c.key && c.description);
}

function NarrativeTab({
  styles,
  onChange,
}: {
  styles: NarrativeStyle[];
  onChange: (styles: NarrativeStyle[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_NARRATIVE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/narrative", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, evaluationChecklist: textToChecklist(form.checklistText) }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_NARRATIVE);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<NarrativeStyle>): Promise<string | null> {
    const response = await fetch(`/api/styles/narrative/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await response.json();
    if (!response.ok) return body.error ?? "Could not save";
    onChange(styles.map((s) => (s.id === id ? body.style : s)));
    return null;
  }

  async function remove(id: string): Promise<string | null> {
    const response = await fetch(`/api/styles/narrative/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(styles.filter((s) => s.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      {styles.map((style) => (
        <NarrativeCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New narrative style
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Planner guidance"
            value={form.plannerGuidance}
            onChange={(v) => setForm({ ...form, plannerGuidance: v })}
            multiline
          />
          <Field
            label="Writing guidance"
            value={form.writingGuidance}
            onChange={(v) => setForm({ ...form, writingGuidance: v })}
            multiline
          />
          <Field
            label="Visual guidance"
            value={form.visualGuidance}
            onChange={(v) => setForm({ ...form, visualGuidance: v })}
            multiline
          />
          <Field
            label="Evaluation checklist (one 'key: description' per line)"
            value={form.checklistText}
            onChange={(v) => setForm({ ...form, checklistText: v })}
            multiline
          />
          <div className="flex gap-2">
            <Field
              label="Target scenes"
              value={String(form.targetSceneCount)}
              onChange={(v) => setForm({ ...form, targetSceneCount: Number(v) || 0 })}
            />
            <Field
              label="Target words"
              value={String(form.targetWordCount)}
              onChange={(v) => setForm({ ...form, targetWordCount: Number(v) || 0 })}
            />
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          onClick={create}
          disabled={busy || !form.name}
          className="mt-3 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          Create
        </button>
      </section>
    </div>
  );
}

function NarrativeCard({
  style,
  onSave,
  onDelete,
}: {
  style: NarrativeStyle;
  onSave: (id: string, patch: Partial<NarrativeStyle>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: style.name,
    description: style.description,
    plannerGuidance: style.plannerGuidance,
    writingGuidance: style.writingGuidance,
    visualGuidance: style.visualGuidance,
    checklistText: checklistToText(style.evaluationChecklist),
    targetSceneCount: style.targetSceneCount,
    targetWordCount: style.targetWordCount,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const err = await onSave(style.id, {
      ...form,
      evaluationChecklist: textToChecklist(form.checklistText),
    });
    setError(err);
    setBusy(false);
    if (!err) setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(await onDelete(style.id));
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {style.name} {style.isBuiltin && <span className="text-xs text-white/35">built-in</span>}
        </h3>
        <div className="flex gap-3 text-xs text-white/40">
          <button onClick={() => setEditing((v) => !v)} className="hover:text-amber-300">
            {editing ? "cancel" : "edit"}
          </button>
          {!style.isBuiltin && (
            <button onClick={remove} disabled={busy} className="hover:text-red-300">
              delete
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-white/50">{style.description}</p>
      <p className="mt-1 text-[11px] text-white/30">
        {style.targetSceneCount} scenes · {style.targetWordCount} words ·{" "}
        {style.evaluationChecklist.length} checklist items
      </p>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Planner guidance"
            value={form.plannerGuidance}
            onChange={(v) => setForm({ ...form, plannerGuidance: v })}
            multiline
          />
          <Field
            label="Writing guidance"
            value={form.writingGuidance}
            onChange={(v) => setForm({ ...form, writingGuidance: v })}
            multiline
          />
          <Field
            label="Visual guidance"
            value={form.visualGuidance}
            onChange={(v) => setForm({ ...form, visualGuidance: v })}
            multiline
          />
          <Field
            label="Evaluation checklist (one 'key: description' per line)"
            value={form.checklistText}
            onChange={(v) => setForm({ ...form, checklistText: v })}
            multiline
          />
          <div className="flex gap-2">
            <Field
              label="Target scenes"
              value={String(form.targetSceneCount)}
              onChange={(v) => setForm({ ...form, targetSceneCount: Number(v) || 0 })}
            />
            <Field
              label="Target words"
              value={String(form.targetWordCount)}
              onChange={(v) => setForm({ ...form, targetWordCount: Number(v) || 0 })}
            />
          </div>
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

/* ------------------------------------------------------------------ voice */

const EMPTY_VOICE = {
  name: "",
  description: "",
  ttsInstruct: "",
  deliveryCues: "",
  model: "qwen3-tts-voicedesign",
};

function VoiceTab({
  styles,
  onChange,
}: {
  styles: VoiceStyle[];
  onChange: (styles: VoiceStyle[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_VOICE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_VOICE);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<VoiceStyle>): Promise<string | null> {
    const response = await fetch(`/api/styles/voice/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await response.json();
    if (!response.ok) return body.error ?? "Could not save";
    onChange(styles.map((s) => (s.id === id ? body.style : s)));
    return null;
  }

  async function remove(id: string): Promise<string | null> {
    const response = await fetch(`/api/styles/voice/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(styles.filter((s) => s.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      {styles.map((style) => (
        <VoiceCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New voice style
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Voice-design instruction (sent as `instruct`)"
            value={form.ttsInstruct}
            onChange={(v) => setForm({ ...form, ttsInstruct: v })}
            multiline
          />
          <Field
            label="Delivery cues (handed to the writer)"
            value={form.deliveryCues}
            onChange={(v) => setForm({ ...form, deliveryCues: v })}
            multiline
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          onClick={create}
          disabled={busy || !form.name}
          className="mt-3 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          Create
        </button>
      </section>
    </div>
  );
}

function VoiceCard({
  style,
  onSave,
  onDelete,
}: {
  style: VoiceStyle;
  onSave: (id: string, patch: Partial<VoiceStyle>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: style.name,
    description: style.description,
    ttsInstruct: style.ttsInstruct,
    deliveryCues: style.deliveryCues,
    model: style.model,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const err = await onSave(style.id, form);
    setError(err);
    setBusy(false);
    if (!err) setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(await onDelete(style.id));
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {style.name} {style.isBuiltin && <span className="text-xs text-white/35">built-in</span>}
        </h3>
        <div className="flex gap-3 text-xs text-white/40">
          <button onClick={() => setEditing((v) => !v)} className="hover:text-amber-300">
            {editing ? "cancel" : "edit"}
          </button>
          {!style.isBuiltin && (
            <button onClick={remove} disabled={busy} className="hover:text-red-300">
              delete
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-white/50">{style.description}</p>
      <p className="mt-1 text-[11px] text-white/30">{style.model}</p>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Voice-design instruction"
            value={form.ttsInstruct}
            onChange={(v) => setForm({ ...form, ttsInstruct: v })}
            multiline
          />
          <Field
            label="Delivery cues"
            value={form.deliveryCues}
            onChange={(v) => setForm({ ...form, deliveryCues: v })}
            multiline
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
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

/* ------------------------------------------------------------------ image */

const EMPTY_IMAGE = {
  name: "",
  description: "",
  promptPrefix: "",
  promptSuffix: "",
  negativePrompt: "",
  model: "",
  paramsText: "{}",
};

function parseParams(text: string): { value: Record<string, number | string> | null; error: string | null } {
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

function ImageTab({
  styles,
  onChange,
}: {
  styles: ImageStyle[];
  onChange: (styles: ImageStyle[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_IMAGE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    const { value: defaultParams, error: paramsError } = parseParams(form.paramsText);
    if (paramsError) return setError(paramsError);

    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...form, defaultParams }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_IMAGE);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<ImageStyle>): Promise<string | null> {
    const response = await fetch(`/api/styles/image/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await response.json();
    if (!response.ok) return body.error ?? "Could not save";
    onChange(styles.map((s) => (s.id === id ? body.style : s)));
    return null;
  }

  async function remove(id: string): Promise<string | null> {
    const response = await fetch(`/api/styles/image/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(styles.filter((s) => s.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      {styles.map((style) => (
        <ImageCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New image style
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          <Field
            label="Prompt prefix"
            value={form.promptPrefix}
            onChange={(v) => setForm({ ...form, promptPrefix: v })}
          />
          <Field
            label="Prompt suffix"
            value={form.promptSuffix}
            onChange={(v) => setForm({ ...form, promptSuffix: v })}
          />
          <Field
            label="Negative prompt"
            value={form.negativePrompt}
            onChange={(v) => setForm({ ...form, negativePrompt: v })}
          />
          <Field
            label="Default params (JSON)"
            value={form.paramsText}
            onChange={(v) => setForm({ ...form, paramsText: v })}
            multiline
          />
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          onClick={create}
          disabled={busy || !form.name || !form.model}
          className="mt-3 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
        >
          Create
        </button>
      </section>
    </div>
  );
}

function ImageCard({
  style,
  onSave,
  onDelete,
}: {
  style: ImageStyle;
  onSave: (id: string, patch: Partial<ImageStyle>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: style.name,
    description: style.description,
    promptPrefix: style.promptPrefix,
    promptSuffix: style.promptSuffix,
    negativePrompt: style.negativePrompt,
    model: style.model,
    paramsText: JSON.stringify(style.defaultParams, null, 2),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const { value: defaultParams, error: paramsError } = parseParams(form.paramsText);
    if (paramsError) return setError(paramsError);

    setBusy(true);
    const err = await onSave(style.id, { ...form, defaultParams: defaultParams! });
    setError(err);
    setBusy(false);
    if (!err) setEditing(false);
  }

  async function remove() {
    setBusy(true);
    setError(await onDelete(style.id));
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {style.name} {style.isBuiltin && <span className="text-xs text-white/35">built-in</span>}
        </h3>
        <div className="flex gap-3 text-xs text-white/40">
          <button onClick={() => setEditing((v) => !v)} className="hover:text-amber-300">
            {editing ? "cancel" : "edit"}
          </button>
          {!style.isBuiltin && (
            <button onClick={remove} disabled={busy} className="hover:text-red-300">
              delete
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-white/50">{style.description}</p>
      <p className="mt-1 text-[11px] text-white/30">{style.model}</p>

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field label="Model" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          <Field
            label="Prompt prefix"
            value={form.promptPrefix}
            onChange={(v) => setForm({ ...form, promptPrefix: v })}
          />
          <Field
            label="Prompt suffix"
            value={form.promptSuffix}
            onChange={(v) => setForm({ ...form, promptSuffix: v })}
          />
          <Field
            label="Negative prompt"
            value={form.negativePrompt}
            onChange={(v) => setForm({ ...form, negativePrompt: v })}
          />
          <Field
            label="Default params (JSON)"
            value={form.paramsText}
            onChange={(v) => setForm({ ...form, paramsText: v })}
            multiline
          />
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

/* ----------------------------------------------------------------- shared */

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
