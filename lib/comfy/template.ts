/**
 * Filling `{{variable}}` holes in a ComfyUI workflow graph.
 *
 * The graph is the user's document — it may contain nodes this codebase has
 * never heard of — so substitution walks it structurally and rewrites only
 * string leaves, leaving everything else, including node wiring like
 * `["4", 0]`, exactly as it was found.
 */

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** The same pattern, anchored: a string that is *only* a variable reference. */
const SOLE_VARIABLE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

export class UnresolvedVariableError extends Error {
  constructor(readonly names: string[]) {
    super(
      `Workflow graph has no value for ${names.map((n) => `{{${n}}}`).join(", ")} — ` +
        `declare the variable on the workflow, or remove it from the graph`,
    );
    this.name = "UnresolvedVariableError";
  }
}

/** Every distinct `{{name}}` the graph mentions, in first-seen order. */
export function collectVariables(graph: unknown): string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(VARIABLE)) found.add(match[1]!);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };

  walk(graph);
  return [...found];
}

/**
 * Substitute declared values into a graph, returning a new one.
 *
 * A string that is *entirely* one variable takes the value's own type —
 * `"seed": "{{seed}}"` becomes the number, not `"42"`. ComfyUI turns out to
 * coerce strings to INT/FLOAT anyway (finding F25), so this is not what makes
 * a workflow run; it is here because that coercion is ComfyUI's own validation
 * layer, and a custom node that reads `inputs["steps"]` directly never sees it.
 *
 * A variable embedded in surrounding text is interpolated as a string, which
 * is the only thing it could be.
 *
 * Unresolved variables are an error rather than a passthrough. Leaving
 * `{{prompt}}` in the graph would send that literal text to the sampler, and
 * FLUX.2 renders text well enough to stencil it into the frame (finding F14) —
 * so the failure would arrive as a plausible-looking image rather than an
 * error.
 */
export function applyTemplate(
  graph: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const missing = new Set<string>();

  const resolve = (name: string): unknown => {
    if (!(name in values) || values[name] === undefined) {
      missing.add(name);
      return undefined;
    }
    return values[name];
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const sole = node.match(SOLE_VARIABLE);
      if (sole) {
        const value = resolve(sole[1]!);
        // Keep the original text when unresolved so the error below is what
        // the caller sees, rather than a confusing `undefined` in the graph.
        return value === undefined ? node : value;
      }
      return node.replace(VARIABLE, (whole, name: string) => {
        const value = resolve(name);
        return value === undefined ? whole : String(value);
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    }
    return node;
  };

  const result = walk(graph) as Record<string, unknown>;
  if (missing.size > 0) throw new UnresolvedVariableError([...missing]);
  return result;
}
