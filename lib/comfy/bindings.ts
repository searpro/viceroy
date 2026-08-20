import type { WorkflowRole, WorkflowVariable } from "../db/schema";

/**
 * The vocabulary a workflow can draw on: what the pipeline is able to put into
 * a `{{variable}}`, and which roles each value exists for.
 *
 * A workflow author is writing against an interface they cannot see. Nothing
 * in a graph says that this project can supply a reference portrait but not,
 * say, a camera angle — so without this list the only way to find the
 * vocabulary is to read the pipeline source. That is the gap this closes.
 *
 * Note what is *not* fixed here: the variable's name. A graph may call the
 * prompt `{{positive}}` or `{{text}}` or anything else; `binds` is the join.
 * The `suggests` field is only a starting name for a graph being written from
 * scratch.
 */
export type BindingInfo = {
  key: WorkflowVariable["binds"];
  label: string;
  /** A conventional name, offered when inserting a fresh variable. */
  suggests: string;
  /** What the pipeline puts here, in the author's terms. */
  provides: string;
  /** Roles where this value exists at all. */
  roles: readonly WorkflowRole[];
  /** Roles where a workflow without it cannot do its job. */
  requiredFor: readonly WorkflowRole[];
  /** Whether several variables may bind to this, each taking the next value. */
  repeatable?: boolean;
};

const IMAGE_ROLES = ["text_to_image", "text_to_image_ref"] as const;
const VIDEO_ROLES = ["image_to_video", "speech_to_video"] as const;
const ALL_ROLES = [...IMAGE_ROLES, ...VIDEO_ROLES] as const;

export const BINDINGS: readonly BindingInfo[] = [
  {
    key: "prompt",
    label: "Prompt",
    suggests: "prompt",
    provides:
      "The composed positive prompt — the image style's prefix and suffix wrapped around the " +
      "scene or character description.",
    roles: ALL_ROLES,
    requiredFor: ALL_ROLES,
  },
  {
    key: "negativePrompt",
    label: "Negative prompt",
    suggests: "negativePrompt",
    provides:
      "The provider's avoid-list and the image style's, concatenated. Empty string when neither " +
      "is set, so the slot is always filled.",
    roles: ALL_ROLES,
    requiredFor: [],
  },
  {
    key: "width",
    label: "Width",
    suggests: "width",
    provides: "Source frame width from config (SOURCE_IMAGE_WIDTH). Always a multiple of 16.",
    roles: ALL_ROLES,
    requiredFor: [],
  },
  {
    key: "height",
    label: "Height",
    suggests: "height",
    provides: "Source frame height from config (SOURCE_IMAGE_HEIGHT). Always a multiple of 16.",
    roles: ALL_ROLES,
    requiredFor: [],
  },
  {
    key: "seed",
    label: "Seed",
    suggests: "seed",
    provides:
      "A fresh random integer per generation. Worth binding: ComfyUI caches node outputs, so a " +
      "graph submitted twice with a fixed seed returns the identical file instead of re-rolling — " +
      "which makes a redo look broken.",
    roles: ALL_ROLES,
    requiredFor: [],
  },
  {
    key: "refImages",
    label: "Reference image",
    suggests: "refImage",
    provides:
      "The filename of a portrait already uploaded to this ComfyUI's input folder — feed it to a " +
      "LoadImage node. Bind one variable per slot: the first takes the scene's first character, " +
      "the second the next, and so on. For video roles this is the still frame being animated.",
    roles: ["text_to_image_ref", ...VIDEO_ROLES],
    requiredFor: ["text_to_image_ref", ...VIDEO_ROLES],
    repeatable: true,
  },
  {
    key: "audio",
    label: "Audio",
    suggests: "narration",
    provides:
      "The filename of the generated narration, uploaded as a WAV — feed it to a LoadAudio node.",
    roles: ["speech_to_video"],
    requiredFor: ["speech_to_video"],
  },
  {
    key: "free",
    label: "Free (you set it)",
    suggests: "steps",
    provides:
      "Never set by the pipeline. Takes the provider's default params if a key of the same name " +
      "exists there, otherwise the value you type here. Use it for steps, cfg, sampler, fps — " +
      "anything that is a property of your setup rather than of the scene.",
    roles: ALL_ROLES,
    requiredFor: [],
  },
];

/** The bindings that mean anything for this role. */
export function bindingsForRole(role: WorkflowRole): BindingInfo[] {
  return BINDINGS.filter((binding) => binding.roles.includes(role));
}

/**
 * Bindings this role needs that the workflow has not used.
 *
 * The point is to catch the mistakes that produce a *plausible* result rather
 * than an error: a `text_to_image_ref` graph with no reference slot generates
 * a perfectly good image of a different person, and a graph with no prompt
 * binding renders whatever text was left hardcoded in the exported node.
 */
export function missingRequired(
  role: WorkflowRole,
  variables: Pick<WorkflowVariable, "binds">[],
): BindingInfo[] {
  const used = new Set(variables.map((variable) => variable.binds));
  return BINDINGS.filter(
    (binding) => binding.requiredFor.includes(role) && !used.has(binding.key),
  );
}

/** Bindings used more than once where that is not meaningful. */
export function duplicateBindings(
  variables: Pick<WorkflowVariable, "binds">[],
): WorkflowVariable["binds"][] {
  const counts = new Map<WorkflowVariable["binds"], number>();
  for (const variable of variables) {
    counts.set(variable.binds, (counts.get(variable.binds) ?? 0) + 1);
  }

  const repeatable = new Set(
    BINDINGS.filter((binding) => binding.repeatable).map((binding) => binding.key),
  );
  // `free` is exempt: every knob in a graph binds to it, and that is the point.
  repeatable.add("free");

  return [...counts.entries()]
    .filter(([key, count]) => count > 1 && !repeatable.has(key))
    .map(([key]) => key);
}
