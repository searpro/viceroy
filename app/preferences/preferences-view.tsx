"use client";

import Link from "next/link";
import { useState } from "react";

type Style = { name: string };

type Preferences = {
  defaultNarrativeStyle?: string;
  defaultVoiceStyle?: string;
  defaultImageStyle?: string;
  defaultMode?: string;
};

export function PreferencesView({
  preferences,
  narrativeStyles,
  voiceStyles,
  imageStyles,
}: {
  preferences: Preferences;
  narrativeStyles: Style[];
  voiceStyles: Style[];
  imageStyles: Style[];
}) {
  const [prefs, setPrefs] = useState(preferences);

  async function save(key: keyof Preferences, value: string) {
    const response = await fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (response.ok) {
      const body = await response.json();
      setPrefs(body.preferences);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Preferences</h1>
      <p className="mt-2 text-sm text-white/45">
        Defaults for a new project. Each one only applies when the new-project form's own choice
        is left unset — a project can still be started with something different.
      </p>

      <div className="mt-6 space-y-5 rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <PreferenceSelect
          label="Default narrative style"
          value={prefs.defaultNarrativeStyle ?? ""}
          options={narrativeStyles.map((s) => s.name)}
          onChange={(value) => save("defaultNarrativeStyle", value)}
        />
        <PreferenceSelect
          label="Default voice style"
          value={prefs.defaultVoiceStyle ?? ""}
          options={voiceStyles.map((s) => s.name)}
          onChange={(value) => save("defaultVoiceStyle", value)}
        />
        <PreferenceSelect
          label="Default image style"
          value={prefs.defaultImageStyle ?? ""}
          options={imageStyles.map((s) => s.name)}
          onChange={(value) => save("defaultImageStyle", value)}
        />

        <div>
          <span className="block text-xs text-white/45">Default mode</span>
          <div className="mt-2 flex gap-4">
            {(["auto", "manual"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="defaultMode"
                  value={mode}
                  checked={prefs.defaultMode === mode}
                  onChange={() => save("defaultMode", mode)}
                  className="accent-amber-400"
                />
                {mode === "auto" ? "Full auto" : "Manual"}
              </label>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function PreferenceSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-white/45">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-white/25"
      >
        {!value && <option value="">— none set —</option>}
        {options.map((name) => (
          <option key={name} value={name} className="bg-neutral-900">
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
