"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PROJECT_FORMATS } from "@/lib/labels";
import { ASPECT_RATIOS, defaultAspectFor, resolutionPresetsFor } from "@/lib/resolution";

type Style = { id: string; name: string; description: string };

// Mirrors CONTEXT_MAX in lib/projects.ts — a sane UX ceiling, not a measured
// model token-budget limit. Enforced again server-side, since a client check
// alone is not validation.
const CONTEXT_MAX = 8000;

export function NewProjectForm({
  narrativeStyles,
  voiceStyles,
  imageStyles,
  captionStyles,
  directionStyles,
  productionDesignStyles,
  basePixels,
  defaultMode,
  defaultFormat,
  defaultAspectRatio,
  defaultResolutionKey,
  defaultNarrativeStyleName,
  defaultVoiceStyleName,
  defaultImageStyleName,
  defaultCaptionStyleName,
  defaultDirectionStyleName,
  defaultProductionDesignStyleName,
}: {
  narrativeStyles: Style[];
  voiceStyles: Style[];
  imageStyles: Style[];
  captionStyles: Style[];
  directionStyles: Style[];
  productionDesignStyles: Style[];
  /** Pixel budget of the configured base output, for labelling presets. */
  basePixels: number;
  defaultMode: "auto" | "manual";
  /** From Preferences. Absent keeps the historical `short_video_narrative` opening. */
  defaultFormat?: string;
  /** Absent means "follow the format", which is what most people mean. */
  defaultAspectRatio?: string;
  defaultResolutionKey?: string;
  defaultNarrativeStyleName?: string;
  defaultVoiceStyleName?: string;
  defaultImageStyleName?: string;
  defaultCaptionStyleName?: string;
  defaultDirectionStyleName?: string;
  defaultProductionDesignStyleName?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<"idea" | "context">("idea");
  const [idea, setIdea] = useState("");
  const [context, setContext] = useState("");
  const [format, setFormat] = useState(defaultFormat ?? "short_video_narrative");
  const isDevFormat = format !== "short_video_narrative";
  // M7.1 PR-E. Follows the format until the user touches it: picking "Short
  // movie" should not silently leave the project vertical, but having chosen a
  // shape deliberately, changing format must not overwrite that choice. A
  // pinned preference counts as having chosen.
  const [aspectTouched, setAspectTouched] = useState(Boolean(defaultAspectRatio));
  const [aspect, setAspect] = useState(
    (defaultAspectRatio as ReturnType<typeof defaultAspectFor>) ?? defaultAspectFor(format),
  );
  const effectiveAspect = aspectTouched ? aspect : defaultAspectFor(format);
  // Labels carry real pixel dimensions, which depend on the chosen shape, so
  // they are derived here rather than passed in already-rendered.
  const presets = resolutionPresetsFor(basePixels, effectiveAspect);

  async function submit(formData: FormData) {
    setError(null);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputMode,
        // Only the active mode's field is sent — the schema does not require
        // both, and sending the inactive one would just be stale leftovers.
        ...(inputMode === "context"
          ? { context: formData.get("context") }
          : { idea: formData.get("idea") }),
        format: formData.get("format"),
        // Whichever style group isn't rendered has no field in `formData` to
        // read — sending it as an explicit `null` fails the server's
        // `z.string().optional()` (optional allows a missing key, not a null
        // value), so each group is included only when its own select exists.
        ...(isDevFormat
          ? {
              directionStyleId: formData.get("directionStyleId"),
              productionDesignStyleId: formData.get("productionDesignStyleId"),
            }
          : {
              narrativeStyleId: formData.get("narrativeStyleId"),
              voiceStyleId: formData.get("voiceStyleId"),
              imageStyleId: formData.get("imageStyleId"),
              captionStyleId: formData.get("captionStyleId"),
            }),
        resolutionKey: formData.get("resolutionKey"),
        aspectRatio: effectiveAspect,
        mode: formData.get("mode"),
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not start the project");
      return;
    }
    startTransition(() => router.push(`/projects/${body.project.id}`));
  }

  return (
    <form action={submit} className="space-y-5">
      <fieldset className="flex gap-4">
        <legend className="mb-2 text-sm font-medium">Input</legend>
        {[
          { value: "idea" as const, label: "Idea based", hint: "A one-line idea, freely elaborated" },
          {
            value: "context" as const,
            label: "Context based",
            hint: "Paste in source material to stay grounded in",
          },
        ].map((option) => (
          <label
            key={option.value}
            className="flex flex-1 cursor-pointer gap-3 rounded-md border border-white/10 bg-black/20 p-3 has-[:checked]:border-amber-400/50 has-[:checked]:bg-amber-400/5"
          >
            <input
              type="radio"
              name="inputMode"
              value={option.value}
              checked={inputMode === option.value}
              onChange={() => setInputMode(option.value)}
              className="mt-1 accent-amber-400"
            />
            <span>
              <span className="block text-sm">{option.label}</span>
              <span className="block text-xs text-white/40">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {inputMode === "idea" ? (
        <div>
          <label htmlFor="idea" className="block text-sm font-medium">
            The idea
          </label>
          <textarea
            id="idea"
            name="idea"
            rows={3}
            required
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder="a plumber became mayor just by using his wits"
            className="mt-2 w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-base outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <p className="mt-1.5 text-xs text-white/40">
            One line is enough — the synopsis is written from it.
          </p>
        </div>
      ) : (
        <div>
          <label htmlFor="context" className="block text-sm font-medium">
            The context
          </label>
          <textarea
            id="context"
            name="context"
            rows={14}
            required
            maxLength={CONTEXT_MAX}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="Paste in an account of the real event, biography, or background notes the story should stay grounded in…"
            className="mt-2 w-full resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 text-base outline-none placeholder:text-white/25 focus:border-white/25"
          />
          <div className="mt-1.5 flex items-start justify-between gap-4">
            <p className="text-xs text-white/40">
              Every stage is instructed to stay inside this material rather than invent — but this is
              prompt adherence, not fact-checking. Nothing here is verified against the real world.
            </p>
            <p
              className={`shrink-0 text-xs tabular-nums ${
                context.length > CONTEXT_MAX * 0.95 ? "text-amber-400" : "text-white/40"
              }`}
            >
              {context.length}/{CONTEXT_MAX}
            </p>
          </div>
        </div>
      )}

      <div>
        <label htmlFor="format" className="block text-sm font-medium">
          Format
        </label>
        <select
          id="format"
          name="format"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
          className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25 sm:w-72"
        >
          {PROJECT_FORMATS.map((option) => (
            <option key={option.value} value={option.value} className="bg-neutral-900">
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-white/40">
          Anything other than a short video runs the Development chain — 22 stages from concept
          through screenplay, storyboards and shot list to a production timeline.
        </p>
      </div>

      {isDevFormat ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Direction style"
            name="directionStyleId"
            options={directionStyles}
            defaultName={defaultDirectionStyleName}
          />
          <Select
            label="Production design style"
            name="productionDesignStyleId"
            options={productionDesignStyles}
            defaultName={defaultProductionDesignStyleName}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Select
            label="Narrative style"
            name="narrativeStyleId"
            options={narrativeStyles}
            defaultName={defaultNarrativeStyleName}
          />
          <Select
            label="Voice style"
            name="voiceStyleId"
            options={voiceStyles}
            defaultName={defaultVoiceStyleName}
          />
          <Select
            label="Image style"
            name="imageStyleId"
            options={imageStyles}
            defaultName={defaultImageStyleName}
          />
          <Select
            label="Caption style"
            name="captionStyleId"
            options={captionStyles}
            defaultName={defaultCaptionStyleName}
          />
        </div>
      )}

      <div>
        <label htmlFor="aspectRatio" className="block text-sm font-medium">
          Aspect ratio
        </label>
        <select
          id="aspectRatio"
          name="aspectRatio"
          value={effectiveAspect}
          onChange={(event) => {
            setAspectTouched(true);
            setAspect(event.target.value as typeof aspect);
          }}
          className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25 sm:w-56"
        >
          {ASPECT_RATIOS.map((option) => (
            <option key={option.key} value={option.key} className="bg-neutral-900">
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="resolutionKey" className="block text-sm font-medium">
          Resolution
        </label>
        <select
          id="resolutionKey"
          name="resolutionKey"
          defaultValue={defaultResolutionKey ?? "hd"}
          className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25 sm:w-56"
        >
          {presets.map((preset) => (
            <option key={preset.key} value={preset.key} className="bg-neutral-900">
              {preset.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex gap-4">
        <legend className="mb-2 text-sm font-medium">Mode</legend>
        {[
          { value: "auto", label: "Full auto", hint: "Runs through; stops only on a threshold" },
          { value: "manual", label: "Manual", hint: "Stops for review at each stage" },
        ].map((option) => (
          <label
            key={option.value}
            className="flex flex-1 cursor-pointer gap-3 rounded-md border border-white/10 bg-black/20 p-3 has-[:checked]:border-amber-400/50 has-[:checked]:bg-amber-400/5"
          >
            <input
              type="radio"
              name="mode"
              value={option.value}
              defaultChecked={option.value === defaultMode}
              className="mt-1 accent-amber-400"
            />
            <span>
              <span className="block text-sm">{option.label}</span>
              <span className="block text-xs text-white/40">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={
          pending ||
          (inputMode === "idea" ? idea.trim().length < 8 : context.trim().length < 8)
        }
        className="rounded-md bg-amber-400 px-4 py-2 text-sm font-medium text-black transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Starting…" : "Start"}
      </button>
    </form>
  );
}

function Select({
  label,
  name,
  options,
  defaultName,
}: {
  label: string;
  name: string;
  options: Style[];
  defaultName?: string;
}) {
  // Preferences store the style's name, not its id (matches resolveStyle's lookup contract).
  // Find the id for the preferred name so <select> defaultValue works against option values.
  const defaultId = defaultName ? (options.find((o) => o.name === defaultName)?.id ?? undefined) : undefined;

  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultId}
        className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id} className="bg-neutral-900">
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}
