"use client";

import { useState } from "react";
import { PAGE_SHELL } from "@/app/components/page-shell";
import { CaptionPreviewPlayer } from "./caption-preview-player";

type NarrativeStyle = {
  id: string;
  name: string;
  description: string;
  plannerGuidance: string;
  writingGuidance: string;
  sceneGuidance: string;
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
  isBuiltin: boolean;
};

type ImageStyle = {
  id: string;
  name: string;
  description: string;
  renderGuidance: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
  isBuiltin: boolean;
};

type DirectionStyle = {
  id: string;
  name: string;
  description: string;
  genreGuidance: string;
  toneGuidance: string;
  pacingGuidance: string;
  isBuiltin: boolean;
};

type ProductionDesignStyle = {
  id: string;
  name: string;
  description: string;
  visualLanguageGuidance: string;
  paletteGuidance: string;
  textureGuidance: string;
  isBuiltin: boolean;
};

type CaptionStyle = {
  id: string;
  name: string;
  description: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  bottomOffset: number;
  uppercase: boolean;
  isBuiltin: boolean;
};

const TABS = [
  { key: "narrative", label: "Narrative" },
  { key: "voice", label: "Voice" },
  { key: "image", label: "Image" },
  { key: "caption", label: "Caption" },
  { key: "direction", label: "Direction" },
  { key: "production-design", label: "Production Design" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function StylesView({
  narrativeStyles,
  voiceStyles,
  imageStyles,
  captionStyles,
  directionStyles,
  productionDesignStyles,
}: {
  narrativeStyles: NarrativeStyle[];
  voiceStyles: VoiceStyle[];
  imageStyles: ImageStyle[];
  captionStyles: CaptionStyle[];
  directionStyles: DirectionStyle[];
  productionDesignStyles: ProductionDesignStyle[];
}) {
  const [tab, setTab] = useState<Tab>("narrative");
  const [narrative, setNarrative] = useState(narrativeStyles);
  const [voice, setVoice] = useState(voiceStyles);
  const [image, setImage] = useState(imageStyles);
  const [caption, setCaption] = useState(captionStyles);
  const [direction, setDirection] = useState(directionStyles);
  const [productionDesign, setProductionDesign] = useState(productionDesignStyles);

  return (
    <main className={`${PAGE_SHELL} py-10`}>
      <h1 className="text-2xl font-semibold tracking-tight">Styles</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/45">
        Narrative, voice, image, caption and direction styles a project can be built with.
        Built-in styles can be edited but not deleted.
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
        {tab === "caption" && <CaptionTab styles={caption} onChange={setCaption} />}
        {tab === "direction" && <DirectionTab styles={direction} onChange={setDirection} />}
        {tab === "production-design" && (
          <ProductionDesignTab styles={productionDesign} onChange={setProductionDesign} />
        )}
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
  sceneGuidance: "",
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
            label="Scene guidance (settings, props, subjects — not how it is rendered)"
            value={form.sceneGuidance}
            onChange={(v) => setForm({ ...form, sceneGuidance: v })}
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
    sceneGuidance: style.sceneGuidance,
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
            label="Scene guidance (settings, props, subjects — not how it is rendered)"
            value={form.sceneGuidance}
            onChange={(v) => setForm({ ...form, sceneGuidance: v })}
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
  renderGuidance: "",
  negativePrompt: "",
  name: "",
  description: "",
  promptPrefix: "",
  promptSuffix: "",
};

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
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
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
          <Field
            label="Render guidance (prose — shown to the model that writes each scene prompt)"
            value={form.renderGuidance}
            onChange={(v) => setForm({ ...form, renderGuidance: v })}
            multiline
          />
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
            label="Negative prompt (leave empty to use the image provider's)"
            value={form.negativePrompt}
            onChange={(v) => setForm({ ...form, negativePrompt: v })}
            multiline
          />
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
    renderGuidance: style.renderGuidance,
    promptPrefix: style.promptPrefix,
    promptSuffix: style.promptSuffix,
    negativePrompt: style.negativePrompt,
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

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Render guidance (prose — shown to the model that writes each scene prompt)"
            value={form.renderGuidance}
            onChange={(v) => setForm({ ...form, renderGuidance: v })}
            multiline
          />
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
            label="Negative prompt (leave empty to use the image provider's)"
            value={form.negativePrompt}
            onChange={(v) => setForm({ ...form, negativePrompt: v })}
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

/* ---------------------------------------------------------------- caption */

const EMPTY_CAPTION = {
  name: "",
  description: "",
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  fontSize: 76,
  fontWeight: 800,
  color: "#ffffff",
  outlineColor: "#000000",
  outlineWidth: 10,
  bottomOffset: 0.17,
  uppercase: false,
};

type CaptionForm = typeof EMPTY_CAPTION;

function CaptionTab({
  styles,
  onChange,
}: {
  styles: CaptionStyle[];
  onChange: (styles: CaptionStyle[]) => void;
}) {
  const [form, setForm] = useState<CaptionForm>(EMPTY_CAPTION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_CAPTION);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<CaptionForm>): Promise<string | null> {
    const response = await fetch(`/api/styles/caption/${id}`, {
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
    const response = await fetch(`/api/styles/caption/${id}`, { method: "DELETE" });
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
        <CaptionCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New caption style
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field
              label="Description"
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
            />
            <Field
              label="Font family"
              value={form.fontFamily}
              onChange={(v) => setForm({ ...form, fontFamily: v })}
            />
            <div className="flex gap-2">
              <NumberField
                label="Font size"
                value={form.fontSize}
                onChange={(v) => setForm({ ...form, fontSize: v })}
              />
              <NumberField
                label="Font weight"
                value={form.fontWeight}
                onChange={(v) => setForm({ ...form, fontWeight: v })}
              />
            </div>
            <div className="flex gap-2">
              <ColorField
                label="Text color"
                value={form.color}
                onChange={(v) => setForm({ ...form, color: v })}
              />
              <ColorField
                label="Outline color"
                value={form.outlineColor}
                onChange={(v) => setForm({ ...form, outlineColor: v })}
              />
            </div>
            <div className="flex gap-2">
              <NumberField
                label="Outline width"
                value={form.outlineWidth}
                onChange={(v) => setForm({ ...form, outlineWidth: v })}
              />
              <NumberField
                label="Bottom offset (0-1)"
                value={form.bottomOffset}
                step={0.01}
                onChange={(v) => setForm({ ...form, bottomOffset: v })}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-white/60">
              <input
                type="checkbox"
                checked={form.uppercase}
                onChange={(event) => setForm({ ...form, uppercase: event.target.checked })}
              />
              Uppercase
            </label>
          </div>
          <CaptionPreviewPlayer captionStyle={form} />
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

function CaptionCard({
  style,
  onSave,
  onDelete,
}: {
  style: CaptionStyle;
  onSave: (id: string, patch: Partial<CaptionForm>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CaptionForm>({
    name: style.name,
    description: style.description,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    outlineColor: style.outlineColor,
    outlineWidth: style.outlineWidth,
    bottomOffset: style.bottomOffset,
    uppercase: style.uppercase,
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
      <p className="mt-1 text-[11px] text-white/30">
        {style.fontFamily.split(",")[0]} · {style.fontSize}px{style.uppercase ? " · uppercase" : ""}
      </p>

      {editing && (
        <div className="mt-3 grid gap-4 border-t border-white/5 pt-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field
              label="Description"
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
            />
            <Field
              label="Font family"
              value={form.fontFamily}
              onChange={(v) => setForm({ ...form, fontFamily: v })}
            />
            <div className="flex gap-2">
              <NumberField
                label="Font size"
                value={form.fontSize}
                onChange={(v) => setForm({ ...form, fontSize: v })}
              />
              <NumberField
                label="Font weight"
                value={form.fontWeight}
                onChange={(v) => setForm({ ...form, fontWeight: v })}
              />
            </div>
            <div className="flex gap-2">
              <ColorField
                label="Text color"
                value={form.color}
                onChange={(v) => setForm({ ...form, color: v })}
              />
              <ColorField
                label="Outline color"
                value={form.outlineColor}
                onChange={(v) => setForm({ ...form, outlineColor: v })}
              />
            </div>
            <div className="flex gap-2">
              <NumberField
                label="Outline width"
                value={form.outlineWidth}
                onChange={(v) => setForm({ ...form, outlineWidth: v })}
              />
              <NumberField
                label="Bottom offset (0-1)"
                value={form.bottomOffset}
                step={0.01}
                onChange={(v) => setForm({ ...form, bottomOffset: v })}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-white/60">
              <input
                type="checkbox"
                checked={form.uppercase}
                onChange={(event) => setForm({ ...form, uppercase: event.target.checked })}
              />
              Uppercase
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
          <CaptionPreviewPlayer captionStyle={form} />
        </div>
      )}
      {!editing && error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}

/* -------------------------------------------------------------- direction */

const EMPTY_DIRECTION = {
  name: "",
  description: "",
  genreGuidance: "",
  toneGuidance: "",
  pacingGuidance: "",
};

function DirectionTab({
  styles,
  onChange,
}: {
  styles: DirectionStyle[];
  onChange: (styles: DirectionStyle[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_DIRECTION);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/direction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_DIRECTION);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<DirectionStyle>): Promise<string | null> {
    const response = await fetch(`/api/styles/direction/${id}`, {
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
    const response = await fetch(`/api/styles/direction/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(styles.filter((s) => s.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-white/40">
        Genre, tone and pacing guidance for the Development chain's writer stages (concept
        through story structure). Text register only — never reaches an image prompt.
      </p>
      {styles.map((style) => (
        <DirectionCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New direction style
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Genre guidance"
            value={form.genreGuidance}
            onChange={(v) => setForm({ ...form, genreGuidance: v })}
            multiline
          />
          <Field
            label="Tone guidance"
            value={form.toneGuidance}
            onChange={(v) => setForm({ ...form, toneGuidance: v })}
            multiline
          />
          <Field
            label="Pacing guidance"
            value={form.pacingGuidance}
            onChange={(v) => setForm({ ...form, pacingGuidance: v })}
            multiline
          />
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

function DirectionCard({
  style,
  onSave,
  onDelete,
}: {
  style: DirectionStyle;
  onSave: (id: string, patch: Partial<DirectionStyle>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: style.name,
    description: style.description,
    genreGuidance: style.genreGuidance,
    toneGuidance: style.toneGuidance,
    pacingGuidance: style.pacingGuidance,
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

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Genre guidance"
            value={form.genreGuidance}
            onChange={(v) => setForm({ ...form, genreGuidance: v })}
            multiline
          />
          <Field
            label="Tone guidance"
            value={form.toneGuidance}
            onChange={(v) => setForm({ ...form, toneGuidance: v })}
            multiline
          />
          <Field
            label="Pacing guidance"
            value={form.pacingGuidance}
            onChange={(v) => setForm({ ...form, pacingGuidance: v })}
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

/* -------------------------------------------------------- production design */

const EMPTY_PRODUCTION_DESIGN = {
  name: "",
  description: "",
  visualLanguageGuidance: "",
  paletteGuidance: "",
  textureGuidance: "",
};

function ProductionDesignTab({
  styles,
  onChange,
}: {
  styles: ProductionDesignStyle[];
  onChange: (styles: ProductionDesignStyle[]) => void;
}) {
  const [form, setForm] = useState(EMPTY_PRODUCTION_DESIGN);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/styles/production-design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not create style");
    } else {
      onChange([...styles, body.style]);
      setForm(EMPTY_PRODUCTION_DESIGN);
    }
    setBusy(false);
  }

  async function save(id: string, patch: Partial<ProductionDesignStyle>): Promise<string | null> {
    const response = await fetch(`/api/styles/production-design/${id}`, {
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
    const response = await fetch(`/api/styles/production-design/${id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(styles.filter((s) => s.id !== id));
      return null;
    }
    const body = await response.json().catch(() => ({}));
    return body.error ?? "Could not delete";
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-white/40">
        Visual language, palette and texture guidance for Preproduction's production-design text
        stages. Nothing generates from this yet — the stage that reads it ships in a later PR.
      </p>
      {styles.map((style) => (
        <ProductionDesignCard key={style.id} style={style} onSave={save} onDelete={remove} />
      ))}

      <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
          New production design style
        </h2>
        <div className="mt-3 space-y-2">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Visual language guidance"
            value={form.visualLanguageGuidance}
            onChange={(v) => setForm({ ...form, visualLanguageGuidance: v })}
            multiline
          />
          <Field
            label="Palette guidance"
            value={form.paletteGuidance}
            onChange={(v) => setForm({ ...form, paletteGuidance: v })}
            multiline
          />
          <Field
            label="Texture guidance"
            value={form.textureGuidance}
            onChange={(v) => setForm({ ...form, textureGuidance: v })}
            multiline
          />
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

function ProductionDesignCard({
  style,
  onSave,
  onDelete,
}: {
  style: ProductionDesignStyle;
  onSave: (id: string, patch: Partial<ProductionDesignStyle>) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: style.name,
    description: style.description,
    visualLanguageGuidance: style.visualLanguageGuidance,
    paletteGuidance: style.paletteGuidance,
    textureGuidance: style.textureGuidance,
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

      {editing && (
        <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Field
            label="Description"
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Field
            label="Visual language guidance"
            value={form.visualLanguageGuidance}
            onChange={(v) => setForm({ ...form, visualLanguageGuidance: v })}
            multiline
          />
          <Field
            label="Palette guidance"
            value={form.paletteGuidance}
            onChange={(v) => setForm({ ...form, paletteGuidance: v })}
            multiline
          />
          <Field
            label="Texture guidance"
            value={form.textureGuidance}
            onChange={(v) => setForm({ ...form, textureGuidance: v })}
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

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
}) {
  return (
    <label className="block flex-1">
      <span className="block text-xs text-white/45">{label}</span>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
        className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block flex-1">
      <span className="block text-xs text-white/45">{label}</span>
      <div className="mt-1 flex items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
        />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent text-sm outline-none"
        />
      </div>
    </label>
  );
}
