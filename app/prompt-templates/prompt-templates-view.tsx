"use client";

import { useMemo, useState } from "react";
import { PAGE_SHELL } from "@/app/components/page-shell";

type Template = {
  key: string;
  section: string;
  label: string;
  description: string;
  template: string;
  variables: { name: string; description: string }[];
  isEdited: boolean;
};

/**
 * Which pipeline a template belongs to, from its key.
 *
 * The `section` a template declares says *where in a story* it runs
 * ("Preproduction"), not *which pipeline* — and both pipelines have sections
 * with overlapping names. The `dev.`/`casting.`/`concept_art.`/`storyboard.`
 * prefixes are what actually separate them, and a person looking for "the
 * prompt that writes my screenplay" is filtering by pipeline, not by section.
 */
const DEV_PREFIXES = ["dev.", "casting.", "concept_art.", "storyboard.", "character.reference_view"];

function flowOf(key: string): "development" | "narrative" {
  return DEV_PREFIXES.some((prefix) => key.startsWith(prefix)) ? "development" : "narrative";
}

const FLOWS = [
  { key: "all", label: "All" },
  { key: "development", label: "Movie" },
  { key: "narrative", label: "Short video" },
] as const;
type Flow = (typeof FLOWS)[number]["key"];

/**
 * The prompt library.
 *
 * Was a single page rendering all 34 templates as always-open eight-row
 * textareas — roughly twelve screens of scrolling with no landmarks, on which
 * finding "the one that writes the beat sheet" meant reading every heading on
 * the way past. Now: pick a section on the left, see that section's templates
 * as one-line rows, open the one you want. Search and the pipeline filter cut
 * across sections for when you don't know which one it's in.
 */
export function PromptTemplatesView({ templates }: { templates: Template[] }) {
  const [rows, setRows] = useState(templates);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<Flow>("all");
  const [editedOnly, setEditedOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const sections = useMemo(() => [...new Set(rows.map((row) => row.section))], [rows]);
  const [section, setSection] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (flow !== "all" && flowOf(row.key) !== flow) return false;
      if (editedOnly && !row.isEdited) return false;
      if (!needle) return true;
      // The template body is searched too: often the thing you remember is a
      // phrase you want to change, not the name of the stage that sends it.
      return (
        row.key.toLowerCase().includes(needle) ||
        row.label.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle) ||
        row.template.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, flow, editedOnly]);

  // A search or a filter looks across every section — narrowing to one as well
  // would hide the result you were searching for.
  const searching = query.trim() !== "" || flow !== "all" || editedOnly;
  const visible = searching ? matches : matches.filter((row) => row.section === (section ?? sections[0]));

  const activeSection = section ?? sections[0] ?? null;

  return (
    <main className={`${PAGE_SHELL} py-10`}>
      <h1 className="text-2xl font-semibold tracking-tight">Prompt templates</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/45">
        The exact text sent to the model for each generation task. A template may only use the
        variables listed under it — anything else reaches the model as a literal{" "}
        <code className="font-mono">{"{{like_this}}"}</code> instead of failing until someone reads
        the output.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search names, descriptions and prompt text…"
          className="min-w-56 flex-1 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <div className="flex rounded-md border border-white/10 p-0.5">
          {FLOWS.map((option) => (
            <button
              key={option.key}
              onClick={() => setFlow(option.key)}
              className={`rounded px-2.5 py-1 text-xs transition ${
                flow === option.key ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-white/45">
          <input
            type="checkbox"
            checked={editedOnly}
            onChange={(event) => setEditedOnly(event.target.checked)}
            className="accent-amber-400"
          />
          Edited only
        </label>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-[13rem_1fr] md:items-start">
        <nav className="md:sticky md:top-20" aria-label="Sections">
          <ul className="flex flex-wrap gap-1 md:block md:space-y-0.5">
            {sections.map((name) => {
              const inSection = rows.filter((row) => row.section === name);
              const edited = inSection.filter((row) => row.isEdited).length;
              const active = !searching && name === activeSection;
              return (
                <li key={name}>
                  <button
                    onClick={() => {
                      setSection(name);
                      setQuery("");
                      setFlow("all");
                      setEditedOnly(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition ${
                      active ? "bg-white/10 text-white" : "text-white/50 hover:bg-white/5 hover:text-white/80"
                    }`}
                  >
                    <span>{name}</span>
                    <span className="flex items-center gap-1.5 text-[11px]">
                      {edited > 0 && <span className="text-amber-300">{edited}</span>}
                      <span className="text-white/30">{inSection.length}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* `min-w-0`: a grid track's implicit `min-width: auto` refuses to
            shrink below its content, so a long template description made the
            whole page scroll sideways instead of truncating. */}
        <div className="min-w-0">
          {searching && (
            <p className="mb-3 text-xs text-white/40">
              {visible.length} match{visible.length === 1 ? "" : "es"} across all sections
            </p>
          )}
          <div className="space-y-2">
            {visible.length === 0 && <p className="text-sm text-white/35">Nothing matches.</p>}
            {visible.map((row) => (
              <TemplateCard
                key={row.key}
                row={row}
                open={openKey === row.key}
                showSection={searching}
                onToggle={() => setOpenKey((current) => (current === row.key ? null : row.key))}
                onSaved={(updated) =>
                  setRows((current) => current.map((r) => (r.key === updated.key ? updated : r)))
                }
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function TemplateCard({
  row,
  open,
  showSection,
  onToggle,
  onSaved,
}: {
  row: Template;
  open: boolean;
  showSection: boolean;
  onToggle: () => void;
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
    if (!response.ok) setError(body.error ?? "Could not save");
    else onSaved(body.template);
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
    <section
      className={`rounded-lg border bg-white/[0.02] transition ${
        open ? "border-white/20" : "border-white/10"
      }`}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-4 p-3 text-left"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-white/85">{row.label}</span>
            {(row.isEdited || dirty) && (
              <span className="rounded bg-amber-300/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                {dirty ? "unsaved" : "edited"}
              </span>
            )}
            {showSection && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/40">
                {row.section}
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-xs text-white/45">{row.description}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-[11px] text-white/25 sm:inline">{row.key}</span>
          <span className="text-white/30" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 p-3">
          <textarea
            rows={14}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="w-full resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-white/25"
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
        </div>
      )}
    </section>
  );
}
