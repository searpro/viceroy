/**
 * Which prompt template produced the text a provider was sent.
 *
 * A trace row that shows only the final prompt still leaves the first
 * question unanswered: is this wrong because the template is wrong, or
 * because a variable expanded to something unexpected? Answering that needs
 * the template key and the variable values that went into it, recorded at the
 * moment `renderPrompt` ran.
 *
 * Threading that through would mean touching every one of the ~40 call sites
 * — each of which passes the rendered string straight into a `messages` array
 * or an `ImageRequest` — and every future one would have to remember. So the
 * render side records into a scope the worker opens around each job, and the
 * request side looks the prompt back up.
 *
 * **A module-level scope is safe here because the worker runs exactly one job
 * at a time**, deliberately and for reasons unrelated to this file (see
 * `worker/index.ts`). If that ever changes this must become an
 * `AsyncLocalStorage`; the API is shaped so that swap is local to this file.
 *
 * Recording is a no-op when no scope is open, so `renderPrompt` called from
 * the web app — the prompt-template editor's preview — costs nothing and
 * leaks nothing between requests.
 */

export type PromptRender = {
  key: string;
  vars: Record<string, string>;
  text: string;
};

/**
 * How many renders one job may accumulate before the oldest are dropped.
 *
 * A per-scene stage renders one template per scene, so this is a few dozen in
 * the worst realistic case. The cap exists so a runaway loop cannot grow the
 * buffer without bound, not because a normal job comes close to it.
 */
const SCOPE_LIMIT = 256;

/**
 * Renders shorter than this are not used for attribution.
 *
 * A template that expands to a handful of characters would match by accident
 * inside an unrelated prompt, and a wrong template key is worse than none —
 * it sends someone to edit a template that had nothing to do with the output.
 */
const MIN_ATTRIBUTABLE_LENGTH = 12;

let scope: PromptRender[] | undefined;

export function beginPromptScope(): void {
  scope = [];
}

export function endPromptScope(): void {
  scope = undefined;
}

export function recordPromptRender(render: PromptRender): void {
  if (!scope) return;
  scope.push(render);
  if (scope.length > SCOPE_LIMIT) scope.splice(0, scope.length - SCOPE_LIMIT);
}

/**
 * The templates whose rendered text appears in `prompt`, in the order they
 * appear in it.
 *
 * Containment rather than equality, because prompts are composed. An image
 * prompt is `imageStyle.promptPrefix` + a rendered template + an optional redo
 * direction + `imageStyle.promptSuffix`, and matching on equality would
 * attribute none of them. The span between the affixes is exactly the part a
 * prompt template can change.
 *
 * Later renders of the same key win: a per-scene stage re-renders one key with
 * different variables for every scene, and the one that produced *this* prompt
 * is the most recent match, not the first.
 */
export function attributeTemplates(prompt: string): { key: string; vars: Record<string, string> }[] {
  if (!scope || prompt.length === 0) return [];

  const hits = new Map<string, { key: string; vars: Record<string, string>; at: number }>();
  for (const render of scope) {
    if (render.text.length < MIN_ATTRIBUTABLE_LENGTH) continue;
    const at = prompt.indexOf(render.text);
    if (at === -1) continue;
    hits.set(render.key, { key: render.key, vars: render.vars, at });
  }

  return [...hits.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ key, vars }) => ({ key, vars }));
}
