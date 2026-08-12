"use client";

import Link from "next/link";
import { useState } from "react";

type Template = {
  key: string;
  section: string;
  label: string;
  description: string;
  template: string;
  variables: { name: string; description: string }[];
  isEdited: boolean;
};

export function PromptTemplatesView({ templates }: { templates: Template[] }) {
  const [rows, setRows] = useState(templates);

  const sections = [...new Set(rows.map((r) => r.section))];

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Prompt templates</h1>
      <p className="mt-2 text-sm text-white/45">
        The exact text sent to the model for each generation task. A template may only use the
        variables listed under it — anything else reaches the model as a literal{" "}
        <code className="font-mono">{"{{like_this}}"}</code> instead of failing until someone
        reads the output.
      </p>

      {sections.map((section) => (
        <section key={section} className="mt-8">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">{section}</h2>
          <div className="mt-3 space-y-3">
            {rows
              .filter((r) => r.section === section)
              .map((row) => (
                <TemplateCard
                  key={row.key}
                  row={row}
                  onSaved={(updated) =>
                    setRows((current) => current.map((r) => (r.key === updated.key ? updated : r)))
                  }
                />
              ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function TemplateCard({
  row,
  onSaved,
}: {
  row: Template;
  onSaved: (updated: Template) => void;
}) {
  const [text, setText] = useState(row.template);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== row.template;

  async function save() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/prompt-templates/${encodeURIComponent(row.key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: text }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not save");
    } else {
      onSaved(body.template);
    }
    setBusy(false);
  }

  async function reset() {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/prompt-templates/${encodeURIComponent(row.key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not reset");
    } else {
      setText(body.template.template);
      onSaved(body.template);
    }
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          {row.label}{" "}
          {row.isEdited && <span className="text-xs text-amber-300">edited</span>}
        </h3>
        <span className="font-mono text-[11px] text-white/30">{row.key}</span>
      </div>
      <p className="mt-1 text-xs text-white/50">{row.description}</p>

      <textarea
        rows={8}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="mt-3 w-full resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-white/25"
      />

      <details className="mt-2 text-[11px] text-white/35">
        <summary className="cursor-pointer">
          {row.variables.length} available variable{row.variables.length === 1 ? "" : "s"}
        </summary>
        <dl className="mt-2 space-y-1">
          {row.variables.map((v) => (
            <div key={v.name} className="flex gap-2">
              <dt className="shrink-0 font-mono text-white/45">{"{{" + v.name + "}}"}</dt>
              <dd>{v.description}</dd>
            </div>
          ))}
        </dl>
      </details>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={reset}
          disabled={busy || !row.isEdited}
          className="rounded-md border border-white/15 px-3 py-1.5 text-xs transition hover:border-white/35 disabled:opacity-40"
        >
          Reset to built-in
        </button>
      </div>
    </section>
  );
}
