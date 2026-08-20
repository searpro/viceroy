import type { WorkflowVariable } from "../db/schema";

/**
 * Turn a workflow's declared variables into the values `applyTemplate` needs.
 *
 * This is the join between a user's arbitrary graph and the pipeline's fixed
 * vocabulary. The stage hands over a prompt; the workflow says which of its
 * holes is the prompt. Neither has to know what the other calls things.
 */
export type BindableRequest = {
  prompt?: string | undefined;
  negativePrompt?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  seed?: number | undefined;
  /** Host-side names, already uploaded. Consumed in order by `refImages` slots. */
  references?: string[] | undefined;
  /** Host-side name of the driving narration. */
  audio?: string | undefined;
};

/** How many reference slots a workflow exposes. */
export function referenceSlots(variables: WorkflowVariable[]): number {
  return variables.filter((variable) => variable.binds === "refImages").length;
}

/**
 * Fill a workflow's reference slots from the characters a scene actually has.
 *
 * A graph's reference slots are structural — two `LoadImage` nodes are wired
 * into the conditioning chain and both must resolve — but a scene's cast is
 * not: most scenes have one character, some have two, some have three. So the
 * two numbers routinely disagree in both directions.
 *
 * Too many characters: use as many as fit. The alternative is failing a scene
 * outright because the workflow has fewer slots than it has people, which
 * makes the workflow unusable rather than imperfect.
 *
 * Too few characters: repeat the last reference into the spare slots, because
 * leaving one unresolved fails the generation and there is nothing else to put
 * there. This is the compromise worth knowing about — the same portrait
 * referenced twice is not obviously identical to one portrait referenced once,
 * and on a graph whose prompt talks about "image 1" and "image 2" it could
 * plausibly ask the model for two people. Callers get told, via `notes`, so it
 * reaches the job log rather than being invisible.
 */
export function fillReferenceSlots(
  slots: number,
  references: string[],
): { filled: string[]; notes: string[] } {
  const notes: string[] = [];
  if (slots === 0 || references.length === 0) return { filled: [], notes };

  if (references.length > slots) {
    notes.push(
      `Scene has ${references.length} character reference(s) but the workflow exposes ${slots} ` +
        `slot(s) — generating with the first ${slots}`,
    );
    return { filled: references.slice(0, slots), notes };
  }

  const filled = [...references];
  while (filled.length < slots) filled.push(references[references.length - 1]!);
  if (filled.length > references.length) {
    notes.push(
      `Workflow exposes ${slots} reference slot(s) but the scene has ${references.length} — ` +
        `repeating the last reference to fill the rest`,
    );
  }
  return { filled, notes };
}

/**
 * Build the substitution map.
 *
 * `free` variables fall back to the provider's `defaultParams` under their own
 * name, then to the variable's declared default. That ordering lets a provider
 * carry install-wide settings — steps, cfg, sampler — without every workflow
 * having to restate them, while a workflow that wants a different value for
 * one of them can still say so.
 */
export function bindVariables(
  variables: WorkflowVariable[],
  request: BindableRequest,
  defaultParams: Record<string, unknown> = {},
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const references = request.references ?? [];
  let referenceIndex = 0;

  for (const variable of variables) {
    switch (variable.binds) {
      case "prompt":
        values[variable.name] = request.prompt ?? "";
        break;
      case "negativePrompt":
        values[variable.name] = request.negativePrompt ?? "";
        break;
      case "width":
        values[variable.name] = request.width;
        break;
      case "height":
        values[variable.name] = request.height;
        break;
      case "seed":
        values[variable.name] = request.seed;
        break;
      case "audio":
        values[variable.name] = request.audio;
        break;
      case "refImages": {
        // Slots are filled in declaration order, so the first character in the
        // scene lands in the first LoadImage hole. `references` has already
        // been sized to the slot count by `fillReferenceSlots`, so a slot only
        // comes back undefined when the caller passed nothing at all — which
        // `applyTemplate` then reports as an unresolved variable rather than
        // sending "undefined" to the sampler.
        values[variable.name] = references[referenceIndex];
        referenceIndex += 1;
        break;
      }
      case "free":
        values[variable.name] =
          variable.name in defaultParams ? defaultParams[variable.name] : variable.defaultValue;
        break;
    }
  }
  return values;
}
