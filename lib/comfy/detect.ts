import type { WorkflowVariable } from "../db/schema";

/**
 * Reading a pasted workflow: is it the right kind of export, what holes does
 * it have, and what is each hole probably for.
 *
 * Deliberately free of database and server imports so the Providers screen can
 * run the same code in the browser. Two implementations of "is this an API
 * export" would drift, and the one the user sees while typing is the one that
 * has to agree with the one that rejects the save.
 */

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Where a `{{variable}}` was found, which is a better clue than its name. */
export type VariableSite = {
  name: string;
  classType: string;
  /** The node's `_meta.title` — where a user writes "Negative Prompt". */
  title: string;
  /** The input key it sits on, e.g. `text`, `image`, `noise_seed`. */
  inputKey: string;
};

/**
 * Check a graph is ComfyUI's API-format export.
 *
 * The editor's own save format is a different document — it has `nodes`,
 * `links` and canvas geometry, and `POST /prompt` rejects it. Both are "the
 * workflow JSON", so pasting the wrong one is the mistake everyone makes once;
 * it deserves a specific message rather than whatever ComfyUI says about a
 * shape it did not expect.
 */
export function checkApiFormat(graph: unknown): string | null {
  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
    return "The workflow must be a JSON object";
  }
  if (Array.isArray((graph as { nodes?: unknown }).nodes)) {
    return (
      "This looks like the editor's save format, not an API export — it has a top-level " +
      '"nodes" array. In ComfyUI use Workflow → Export (API), which produces a flat map ' +
      "of node id to { class_type, inputs }."
    );
  }

  const entries = Object.entries(graph as Record<string, unknown>);
  if (entries.length === 0) return "The workflow graph is empty";

  for (const [nodeId, node] of entries) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return `Node "${nodeId}" is not an API-format node — every entry needs a "class_type" and an "inputs" object`;
    }
    const typed = node as { class_type?: unknown; inputs?: unknown };
    if (typeof typed.class_type !== "string" || typed.class_type === "") {
      return `Node "${nodeId}" has no class_type — that is not an API-format export`;
    }
    if (typed.inputs !== undefined && (typeof typed.inputs !== "object" || typed.inputs === null)) {
      return `Node "${nodeId}" has an "inputs" that is not an object`;
    }
  }
  return null;
}

/** Every `{{variable}}`, in first-seen order, with the node it sits in. */
export function collectSites(graph: unknown): VariableSite[] {
  const sites: VariableSite[] = [];
  if (!graph || typeof graph !== "object") return sites;

  for (const node of Object.values(graph as Record<string, unknown>)) {
    if (!node || typeof node !== "object") continue;
    const typed = node as {
      class_type?: string;
      _meta?: { title?: string };
      inputs?: Record<string, unknown>;
    };

    const scan = (value: unknown, inputKey: string): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(VARIABLE)) {
          const name = match[1]!;
          if (sites.some((site) => site.name === name)) continue;
          sites.push({
            name,
            classType: typed.class_type ?? "",
            title: typed._meta?.title ?? "",
            inputKey,
          });
        }
      } else if (Array.isArray(value)) {
        value.forEach((item) => scan(item, inputKey));
      } else if (value && typeof value === "object") {
        Object.entries(value).forEach(([key, item]) => scan(item, key));
      }
    };

    Object.entries(typed.inputs ?? {}).forEach(([key, value]) => scan(value, key));
  }
  return sites;
}

/**
 * Guess what a variable is for.
 *
 * Node type first, name second. A `LoadImage` input is a reference slot
 * whatever the user called it — guessing from the name alone classified
 * `{{startFrame}}` as a free knob, which would have left the driving frame
 * unset and the workflow failing on an unresolved variable.
 *
 * Only ever a starting point: the user corrects it in the editor's table, and
 * whatever they choose is what gets stored.
 */
export function guessBinds(site: VariableSite): WorkflowVariable["binds"] {
  const type = site.classType.toLowerCase();
  const label = `${site.title} ${site.name}`.toLowerCase();

  if (type.includes("loadimage")) return "refImages";
  if (type.includes("loadaudio")) return "audio";

  // A graph's two text encoders are identical from the inside — they differ
  // only in which conditioning input they feed, which the node cannot see. The
  // title the user gave it is the available signal.
  if (type.includes("cliptextencode") || site.inputKey === "text") {
    return /negative|neg\b/.test(label) ? "negativePrompt" : "prompt";
  }

  const key = `${site.inputKey} ${site.name}`.toLowerCase();
  if (/negative/.test(label)) return "negativePrompt";
  if (key.includes("prompt")) return "prompt";
  if (key.includes("width")) return "width";
  if (key.includes("height")) return "height";
  if (key.includes("seed") || key.includes("noise")) return "seed";
  if (key.includes("audio") || key.includes("speech")) return "audio";

  // Deliberately narrow. `LoadImage` above catches the cases that matter, so
  // this only has to handle a reference threaded through some other node — and
  // a loose pattern does real damage here: matching a bare "frame" turned
  // `num_frames`, a plain integer knob, into a reference slot.
  //
  // Matched against each part on its own rather than the joined string,
  // because `$` anchors to the end of the whole string: joined, "portrait" sat
  // before a space and matched nothing.
  const referenceLike = /^(ref|refs|reference|portrait|image)(_.*)?$|^.*_(ref|reference|portrait|image)$/;
  if ([site.inputKey.toLowerCase(), site.name.toLowerCase()].some((part) => referenceLike.test(part))) {
    return "refImages";
  }
  return "free";
}

export function guessType(binds: WorkflowVariable["binds"]): WorkflowVariable["type"] {
  if (binds === "width" || binds === "height" || binds === "seed") return "number";
  if (binds === "refImages" || binds === "audio") return "image";
  return "string";
}

/** The node most likely to be the one whose output should be collected. */
export function guessOutputNode(graph: unknown): string | null {
  if (!graph || typeof graph !== "object") return null;
  const saveNodes = Object.entries(graph as Record<string, { class_type?: string }>)
    .filter(([, node]) => /save|preview/i.test(node?.class_type ?? ""))
    .map(([id]) => id);
  // Only when it is unambiguous. Picking one of several would be a guess the
  // user cannot see, and collecting the wrong node's file is a silent wrong
  // answer rather than an error.
  return saveNodes.length === 1 ? saveNodes[0]! : null;
}
