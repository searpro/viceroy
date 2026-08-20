"use client";

import { useState } from "react";
import {
  bindingsForRole,
  duplicateBindings,
  missingRequired,
  type BindingInfo,
} from "@/lib/comfy/bindings";
import {
  checkApiFormat,
  collectSites,
  guessBinds,
  guessOutputNode,
  guessType,
} from "@/lib/comfy/detect";

export type WorkflowVariable = {
  name: string;
  type: "string" | "number" | "boolean" | "image";
  binds:
    | "prompt"
    | "negativePrompt"
    | "width"
    | "height"
    | "seed"
    | "refImages"
    | "audio"
    | "free";
  defaultValue?: unknown;
};

export type Workflow = {
  id: string;
  providerId: string;
  role: WorkflowRole;
  name: string;
  graph: Record<string, unknown>;
  variables: WorkflowVariable[];
  outputNodeId: string | null;
};

export type WorkflowRole =
  | "text_to_image"
  | "text_to_image_ref"
  | "image_to_video"
  | "speech_to_video";

export const ROLES: { key: WorkflowRole; label: string; hint: string }[] = [
  {
    key: "text_to_image",
    label: "Text to image",
    hint: "Scenes with nobody in them, and the first pass at a character portrait.",
  },
  {
    key: "text_to_image_ref",
    label: "Text to image (with references)",
    hint: "Scenes with characters. Needs a LoadImage hole per reference slot — this is what holds a face steady between frames.",
  },
  { key: "image_to_video", label: "Image to video", hint: "Animates a still frame." },
  {
    key: "speech_to_video",
    label: "Speech to video",
    hint: "Animates a still frame against driving narration.",
  },
];

export const ROLES_BY_KIND: Record<"image" | "video", WorkflowRole[]> = {
  image: ["text_to_image", "text_to_image_ref"],
  video: ["image_to_video", "speech_to_video"],
};

type TestResult = {
  ok?: boolean;
  error?: string;
  nodeErrors?: { nodeId: string; classType: string; details: string[] }[];
  dataUrl?: string | null;
  mimeType?: string;
  bytes?: number;
  elapsedMs?: number;
};

export function WorkflowSection({
  providerId,
  kind,
  workflows,
  onChange,
}: {
  providerId: string;
  kind: "image" | "video";
  workflows: Workflow[];
  onChange: (workflows: Workflow[]) => void;
}) {
  const roles = ROLES_BY_KIND[kind];

  return (
    <div className="mt-4 space-y-3 border-t border-white/5 pt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">Workflows</h4>
      {roles.map((role) => (
        <RoleSlot
          key={role}
          providerId={providerId}
          role={role}
          workflow={workflows.find((w) => w.role === role)}
          onChange={(next) => {
            const others = workflows.filter((w) => w.role !== role);
            onChange(next ? [...others, next] : others);
          }}
        />
      ))}
    </div>
  );
}

function RoleSlot({
  providerId,
  role,
  workflow,
  onChange,
}: {
  providerId: string;
  role: WorkflowRole;
  workflow: Workflow | undefined;
  onChange: (workflow: Workflow | null) => void;
}) {
  const meta = ROLES.find((r) => r.key === role)!;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(workflow?.name ?? meta.label);
  const [graphText, setGraphText] = useState(
    workflow ? JSON.stringify(workflow.graph, null, 2) : "",
  );
  const [variables, setVariables] = useState<WorkflowVariable[]>(workflow?.variables ?? []);
  const [outputNodeId, setOutputNodeId] = useState(workflow?.outputNodeId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  /** Re-read the pasted graph and reconcile the variable table against it. */
  function scan(text: string): void {
    setGraphText(text);
    setError(null);
    if (!text.trim()) return;

    let graph: unknown;
    try {
      graph = JSON.parse(text);
    } catch {
      setError("That is not valid JSON");
      return;
    }
    const problem = checkApiFormat(graph);
    if (problem) return setError(problem);

    const sites = collectSites(graph);
    // Keep what the user already classified; add what is new; drop what the
    // graph no longer mentions, so an edited graph cannot leave a stale
    // binding behind that silently fills nothing.
    setVariables((current) =>
      sites.map((site) => {
        const existing = current.find((v) => v.name === site.name);
        if (existing) return existing;
        const binds = guessBinds(site);
        return { name: site.name, type: guessType(binds), binds };
      }),
    );

    const guessed = guessOutputNode(graph);
    if (guessed && !outputNodeId) setOutputNodeId(guessed);
  }

  async function save() {
    let graph: unknown;
    try {
      graph = JSON.parse(graphText);
    } catch {
      return setError("That is not valid JSON");
    }
    const problem = checkApiFormat(graph);
    if (problem) return setError(problem);

    setBusy(true);
    setError(null);
    const payload = {
      providerId,
      role,
      name,
      graph,
      variables,
      outputNodeId: outputNodeId.trim() || null,
    };
    const response = workflow
      ? await fetch(`/api/workflows/${workflow.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/workflows", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });

    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not save the workflow");
    else onChange(body.workflow as Workflow);
    setBusy(false);
  }

  async function remove() {
    if (!workflow) return;
    setBusy(true);
    const response = await fetch(`/api/workflows/${workflow.id}`, { method: "DELETE" });
    if (response.status === 204) {
      onChange(null);
      setGraphText("");
      setVariables([]);
      setOpen(false);
    } else {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not delete");
    }
    setBusy(false);
  }

  async function runTest() {
    if (!workflow) return;
    setBusy(true);
    setTest(null);
    const response = await fetch("/api/workflows/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: workflow.id }),
    });
    setTest(await response.json());
    setBusy(false);
  }

  const available = bindingsForRole(role);
  const unbound = variables.filter((v) => v.binds === "free" && v.defaultValue === undefined);
  const missing = graphText.trim() ? missingRequired(role, variables) : [];
  const duplicated = duplicateBindings(variables);

  return (
    <section className="rounded-md border border-white/10 bg-black/20 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h5 className="text-xs font-medium">
            {meta.label}{" "}
            {workflow ? (
              <span className="text-[10px] text-emerald-300">configured</span>
            ) : (
              <span className="text-[10px] text-white/25">not set</span>
            )}
          </h5>
          <p className="mt-0.5 text-[10px] leading-relaxed text-white/30">{meta.hint}</p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-[11px] text-white/40 hover:text-amber-300"
        >
          {open ? "close" : workflow ? "edit" : "add"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="block text-[11px] text-white/45">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-1.5 text-sm outline-none focus:border-white/25"
            />
          </label>

          <BindingHints bindings={available} />

          <label className="block">
            <span className="block text-[11px] text-white/45">
              Workflow JSON — ComfyUI → Workflow → Export (API). Put {"{{variables}}"} where the
              pipeline should fill values in.
            </span>
            <textarea
              rows={8}
              value={graphText}
              onChange={(event) => scan(event.target.value)}
              placeholder='{ "9": { "class_type": "SaveImage", "inputs": { ... } } }'
              className="mt-1 w-full resize-y rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] outline-none focus:border-white/25"
            />
          </label>

          {variables.length > 0 && (
            <div className="rounded-md border border-white/10">
              <table className="w-full text-[11px]">
                <thead className="text-white/35">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">Variable</th>
                    <th className="px-2 py-1 text-left font-normal">Fills with</th>
                    <th className="px-2 py-1 text-left font-normal">Value (free only)</th>
                  </tr>
                </thead>
                <tbody>
                  {variables.map((variable, index) => (
                    <tr key={variable.name} className="border-t border-white/5">
                      <td className="px-2 py-1 font-mono text-white/70">{variable.name}</td>
                      <td className="px-2 py-1">
                        <select
                          value={variable.binds}
                          onChange={(event) => {
                            const binds = event.target.value as WorkflowVariable["binds"];
                            setVariables(
                              variables.map((v, i) =>
                                i === index ? { ...v, binds, type: guessType(binds) } : v,
                              ),
                            );
                          }}
                          className="w-full rounded border border-white/10 bg-black/40 px-1 py-0.5 outline-none"
                        >
                          {available.map((bind) => (
                            <option key={bind.key} value={bind.key}>
                              {bind.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        {variable.binds === "free" ? (
                          <input
                            value={
                              variable.defaultValue === undefined ? "" : String(variable.defaultValue)
                            }
                            onChange={(event) => {
                              const raw = event.target.value;
                              // A numeric-looking value is stored as a number:
                              // the graph slot it lands in is usually an INT or
                              // FLOAT, and keeping the type is free here.
                              const parsed =
                                raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
                              setVariables(
                                variables.map((v, i) =>
                                  i === index
                                    ? { ...v, defaultValue: raw === "" ? undefined : parsed }
                                    : v,
                                ),
                              );
                            }}
                            className="w-full rounded border border-white/10 bg-black/40 px-1 py-0.5 outline-none"
                          />
                        ) : (
                          <span className="text-white/20">set by the pipeline</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {missing.map((binding) => (
            <p key={binding.key} className="text-[11px] text-amber-300">
              Nothing is bound to <strong>{binding.label}</strong>. {missingConsequence(role, binding)}
            </p>
          ))}
          {duplicated.length > 0 && (
            <p className="text-[11px] text-amber-300">
              Two variables both fill {duplicated.join(", ")} — they will get the same value.
            </p>
          )}
          {unbound.length > 0 && (
            <p className="text-[11px] text-amber-300">
              {unbound.map((v) => v.name).join(", ")} {unbound.length === 1 ? "has" : "have"} no
              value — the workflow will fail until you set{" "}
              {unbound.length === 1 ? "it" : "them"} or bind {unbound.length === 1 ? "it" : "them"}{" "}
              to something.
            </p>
          )}

          <label className="block">
            <span className="block text-[11px] text-white/45">
              Output node id (blank = whichever node saves a file)
            </span>
            <input
              value={outputNodeId}
              onChange={(event) => setOutputNodeId(event.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-1.5 font-mono text-[11px] outline-none focus:border-white/25"
            />
          </label>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={busy || !graphText.trim()}
              className="rounded-md bg-amber-400 px-3 py-1.5 text-[11px] font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={runTest}
              disabled={busy || !workflow}
              title={workflow ? "" : "Save the workflow before testing it"}
              className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] transition hover:border-white/35 disabled:opacity-40"
            >
              {busy ? "Running…" : "Test run"}
            </button>
            {workflow && (
              <button
                onClick={remove}
                disabled={busy}
                className="text-[11px] text-white/40 transition hover:text-red-300 disabled:opacity-40"
              >
                delete
              </button>
            )}
          </div>

          {test && <TestReport result={test} />}
        </div>
      )}
    </section>
  );
}

/**
 * Why a missing binding matters, in terms of what the render will look like.
 *
 * These are the two failures that produce a plausible picture rather than an
 * error, so "required" on its own does not convey the stakes.
 */
function missingConsequence(role: WorkflowRole, binding: BindingInfo): string {
  if (binding.key === "prompt") {
    return "Every generation would use whatever text was hardcoded in the exported node.";
  }
  if (binding.key === "refImages") {
    return role === "text_to_image_ref"
      ? "This workflow cannot carry a character portrait, so every scene would draw a different face."
      : "There is nowhere to put the frame being animated.";
  }
  if (binding.key === "audio") {
    return "There is nowhere to put the narration that drives the animation.";
  }
  return "This role cannot run without it.";
}

/**
 * The vocabulary, spelled out.
 *
 * A workflow author is writing against an interface with no other
 * documentation — nothing in a graph says what this project can supply.
 * Collapsed once a graph is in place, since by then it is reference material
 * rather than instruction.
 */
function BindingHints({ bindings }: { bindings: BindingInfo[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[11px] text-white/55">
          What the pipeline can fill in — {bindings.length} values for this role
        </span>
        <span className="text-[11px] text-white/35">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-white/5 px-3 py-2">
          <p className="text-[10px] leading-relaxed text-white/35">
            Name your variables whatever suits the graph — what matters is the “Fills with” column
            below, not the name. Put <code className="text-white/50">{"{{yourName}}"}</code> in any
            node input; a string that is <em>only</em> a variable keeps the value&rsquo;s type, so{" "}
            <code className="text-white/50">{'"seed": "{{seed}}"'}</code> stays a number.
          </p>
          <dl className="space-y-1.5">
            {bindings.map((binding) => (
              <div key={binding.key} className="grid grid-cols-[7rem_1fr] gap-2">
                <dt className="text-[11px] text-white/60">
                  {binding.label}
                  <span className="block font-mono text-[10px] text-white/25">
                    {`{{${binding.suggests}}}`}
                  </span>
                </dt>
                <dd className="text-[10px] leading-relaxed text-white/40">
                  {binding.provides}
                  {binding.repeatable && (
                    <span className="text-white/30"> Bind one variable per slot.</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function TestReport({ result }: { result: TestResult }) {
  const seconds = result.elapsedMs ? (result.elapsedMs / 1000).toFixed(1) : null;

  if (result.ok) {
    return (
      <div className="mt-2 rounded-md border border-emerald-400/25 bg-emerald-400/5 p-2">
        <p className="text-[11px] text-emerald-300">
          Generated {result.bytes?.toLocaleString()} bytes{seconds && ` in ${seconds}s`}
        </p>
        {result.dataUrl && result.mimeType?.startsWith("image/") && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={result.dataUrl}
            alt="Test generation"
            className="mt-2 max-h-64 rounded border border-white/10"
          />
        )}
        {result.dataUrl && result.mimeType?.startsWith("video/") && (
          <video src={result.dataUrl} controls className="mt-2 max-h-64 rounded border border-white/10" />
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-red-400/25 bg-red-400/5 p-2">
      <p className="text-[11px] text-red-300">{result.error}</p>
      {result.nodeErrors && result.nodeErrors.length > 0 && (
        <ul className="mt-1 space-y-1">
          {result.nodeErrors.map((node) => (
            <li key={node.nodeId} className="text-[11px] text-red-200/80">
              <span className="font-mono">
                node {node.nodeId} ({node.classType})
              </span>
              <ul className="ml-3 list-disc text-red-200/60">
                {node.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
