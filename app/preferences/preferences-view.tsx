"use client";

import { useState } from "react";
import { PAGE_SHELL } from "@/app/components/page-shell";
import { PROJECT_FORMATS } from "@/lib/labels";
import { ASPECT_RATIOS, defaultAspectFor, resolutionPresetsFor } from "@/lib/resolution";

type Style = { name: string };
type LlmProvider = { id: string; name: string; model: string };

type Preferences = {
  defaultNarrativeStyle?: string;
  defaultVoiceStyle?: string;
  defaultImageStyle?: string;
  defaultCaptionStyle?: string;
  defaultDirectionStyle?: string;
  defaultProductionDesignStyle?: string;
  defaultDevLlmProvider?: string;
  defaultFormat?: string;
  defaultAspectRatio?: string;
  defaultResolution?: string;
  defaultMode?: string;
};

/**
 * Defaults for a new project, grouped by which pipeline they apply to.
 *
 * The previous version listed four style selects and a mode radio in one flat
 * card. That was complete when there was one pipeline; since M7 there are two,
 * and the Development chain's own defaults — direction style, production
 * design style, and which LLM its stages use — were readable by
 * `createProject` and writable by nothing, so the only way to set them was to
 * pick them by hand on every new movie. The grouping is what makes it obvious
 * which half of the screen is talking about the project you are about to make.
 */
export function PreferencesView({
  preferences,
  narrativeStyles,
  voiceStyles,
  imageStyles,
  captionStyles,
  directionStyles,
  productionDesignStyles,
  llmProviders,
  basePixels,
}: {
  preferences: Preferences;
  narrativeStyles: Style[];
  voiceStyles: Style[];
  imageStyles: Style[];
  captionStyles: Style[];
  directionStyles: Style[];
  productionDesignStyles: Style[];
  llmProviders: LlmProvider[];
  basePixels: number;
}) {
  const [prefs, setPrefs] = useState(preferences);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  async function save(key: keyof Preferences, value: string) {
    setError(null);
    const response = await fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      // Silence here is what made a rejected value look accepted: the select
      // kept the new option on screen while the database kept the old one.
      setError(body?.error ?? "Could not save that setting");
      return;
    }
    setPrefs(body.preferences);
    setSavedKey(key);
    setTimeout(() => setSavedKey((current) => (current === key ? null : current)), 1500);
  }

  const format = prefs.defaultFormat ?? "short_video_narrative";
  // Same rule the new-project form applies: an unpinned aspect follows the
  // format, so the preview labels have to follow it too.
  const effectiveAspect = prefs.defaultAspectRatio ?? defaultAspectFor(format);
  const presets = resolutionPresetsFor(basePixels, effectiveAspect);

  return (
    <main className={`${PAGE_SHELL} py-10`}>
      <h1 className="text-2xl font-semibold tracking-tight">Preferences</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/45">
        Defaults for a new project. Each one only pre-fills the new-project form — a project can
        always be started with something different, and changing a default never touches a project
        that already exists.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <Section title="Project" hint="What the new-project form opens on.">
        <Field label="Format" saved={savedKey === "defaultFormat"}>
          <Select
            value={format}
            onChange={(value) => save("defaultFormat", value)}
            options={PROJECT_FORMATS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
        </Field>
        <Field
          label="Aspect ratio"
          hint="“Follow the format” gives a short video 9:16 and everything else 16:9."
          saved={savedKey === "defaultAspectRatio"}
        >
          <Select
            value={prefs.defaultAspectRatio ?? ""}
            onChange={(value) => save("defaultAspectRatio", value)}
            placeholder={`Follow the format (${defaultAspectFor(format)})`}
            options={ASPECT_RATIOS.map((entry) => ({ value: entry.key, label: entry.label }))}
          />
        </Field>
        <Field
          label="Resolution"
          hint="Scales of the configured output size. Draft and Low exist for reviewing a movie's coverage cheaply before committing to full-size frames."
          saved={savedKey === "defaultResolution"}
        >
          <Select
            value={prefs.defaultResolution ?? "hd"}
            onChange={(value) => save("defaultResolution", value)}
            options={presets.map((preset) => ({ value: preset.key, label: preset.label }))}
          />
        </Field>
        <Field label="Review mode" saved={savedKey === "defaultMode"}>
          <div className="flex gap-4">
            {(["auto", "manual"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="defaultMode"
                  value={mode}
                  checked={(prefs.defaultMode ?? "auto") === mode}
                  onChange={() => save("defaultMode", mode)}
                  className="accent-amber-400"
                />
                {mode === "auto" ? "Full auto" : "Manual"}
              </label>
            ))}
          </div>
        </Field>
      </Section>

      <Section
        title="Movie projects"
        hint="Used by the Development chain — short movie, short film, series and feature film."
        accent
      >
        <Field label="Direction style" saved={savedKey === "defaultDirectionStyle"}>
          <Select
            value={prefs.defaultDirectionStyle ?? ""}
            onChange={(value) => save("defaultDirectionStyle", value)}
            placeholder="— none set —"
            options={directionStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
        <Field label="Production design style" saved={savedKey === "defaultProductionDesignStyle"}>
          <Select
            value={prefs.defaultProductionDesignStyle ?? ""}
            onChange={(value) => save("defaultProductionDesignStyle", value)}
            placeholder="— none set —"
            options={productionDesignStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
        <Field
          label="Development LLM"
          hint="All 22 Development stages use this one provider, deliberately not the fast/cheap default the narrative pipeline uses. Falls back to the default LLM provider when unset."
          saved={savedKey === "defaultDevLlmProvider"}
        >
          <Select
            value={prefs.defaultDevLlmProvider ?? ""}
            onChange={(value) => save("defaultDevLlmProvider", value)}
            placeholder="— use the default LLM provider —"
            options={llmProviders.map((provider) => ({
              value: provider.id,
              label: provider.model ? `${provider.name} — ${provider.model}` : provider.name,
            }))}
          />
        </Field>
      </Section>

      <Section
        title="Short video projects"
        hint="Used by the narrative pipeline — the slideshow-plus-voiceover flow."
      >
        <Field label="Narrative style" saved={savedKey === "defaultNarrativeStyle"}>
          <Select
            value={prefs.defaultNarrativeStyle ?? ""}
            onChange={(value) => save("defaultNarrativeStyle", value)}
            placeholder="— none set —"
            options={narrativeStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
        <Field label="Voice style" saved={savedKey === "defaultVoiceStyle"}>
          <Select
            value={prefs.defaultVoiceStyle ?? ""}
            onChange={(value) => save("defaultVoiceStyle", value)}
            placeholder="— none set —"
            options={voiceStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
        <Field label="Image style" saved={savedKey === "defaultImageStyle"}>
          <Select
            value={prefs.defaultImageStyle ?? ""}
            onChange={(value) => save("defaultImageStyle", value)}
            placeholder="— none set —"
            options={imageStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
        <Field label="Caption style" saved={savedKey === "defaultCaptionStyle"}>
          <Select
            value={prefs.defaultCaptionStyle ?? ""}
            onChange={(value) => save("defaultCaptionStyle", value)}
            placeholder="— none set —"
            options={captionStyles.map((style) => ({ value: style.name, label: style.name }))}
          />
        </Field>
      </Section>
    </main>
  );
}

function Section({
  title,
  hint,
  accent = false,
  children,
}: {
  title: string;
  hint: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`mt-6 rounded-lg border bg-white/[0.02] p-4 ${
        accent ? "border-sky-400/20" : "border-white/10"
      }`}
    >
      <h2 className="text-sm font-medium text-white/85">{title}</h2>
      <p className="mt-1 text-xs text-white/40">{hint}</p>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  saved,
  children,
}: {
  label: string;
  hint?: string;
  saved: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[13rem_1fr] sm:items-start sm:gap-4">
      <div className="sm:pt-2">
        <span className="flex items-center gap-2 text-xs text-white/55">
          {label}
          {saved && <span className="text-[10px] text-emerald-400">saved</span>}
        </span>
      </div>
      <div>
        {children}
        {hint && <p className="mt-1 text-[11px] leading-relaxed text-white/35">{hint}</p>}
      </div>
    </div>
  );
}

function Select({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
    >
      {/* Kept only while nothing is chosen: re-selecting it would send an
          empty value, which `preferenceUpdateSchema` rejects — the control
          would look like it did something and silently fail. */}
      {!value && placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-neutral-900">
          {option.label}
        </option>
      ))}
    </select>
  );
}
