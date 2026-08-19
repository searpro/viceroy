"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Provider = {
  name: string;
  baseUrl: string;
  model: string;
  defaultParams: Record<string, unknown>;
  negativePrompt: string;
};

type Job = {
  id: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  model: string;
  prompt: string;
  error: { message: string } | null;
  inference_time_s: number | null;
};

const MODES = [
  {
    key: "text",
    label: "Text → Video",
    blurb: "Prompt only. The model invents the whole frame.",
    needs: [] as ReferenceKind[],
  },
  {
    key: "image",
    label: "Image → Video",
    blurb: "A still is the first frame; the prompt describes what happens next.",
    needs: ["image"] as ReferenceKind[],
  },
  {
    key: "speech",
    label: "Speech → Video",
    blurb: "Driving audio animates a reference portrait. Length comes from the audio.",
    needs: ["image", "audio"] as ReferenceKind[],
  },
] as const;

type Mode = (typeof MODES)[number]["key"];
type ReferenceKind = "image" | "audio";

// Only the fields worth a dedicated box. Anything else the server accepts —
// flow_shift, lora, frame interpolation — goes through the JSON escape hatch
// below rather than growing this list.
const PARAM_FIELDS = [
  { key: "width", label: "Width" },
  { key: "height", label: "Height" },
  { key: "num_frames", label: "Frames" },
  { key: "fps", label: "FPS" },
  { key: "num_inference_steps", label: "Steps" },
  { key: "guidance_scale", label: "Guidance" },
  { key: "seed", label: "Seed" },
] as const;

const TERMINAL = new Set(["completed", "failed"]);

export function VideoView({ provider }: { provider: Provider | null }) {
  const [mode, setMode] = useState<Mode>("speech");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const imageFileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      PARAM_FIELDS.map((f) => [f.key, stringifyParam(provider?.defaultParams?.[f.key])]),
    ),
  );
  const [extraParams, setExtraParams] = useState("{}");

  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const active = job !== null && !TERMINAL.has(job.status);

  // The server's own `progress` is 0 until it is 100 (it never reports
  // anything in between), so elapsed time is the only honest liveness signal
  // there is while a generation runs.
  useEffect(() => {
    if (!active || startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  useEffect(() => {
    if (!active || !job) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/video/${job.id}`);
      const body = await response.json();
      if (cancelled) return;
      if (!response.ok) return setError(body.error ?? "Could not read job status");
      setJob(body.job as Job);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, job]);

  async function generate() {
    setBusy(true);
    setError(null);
    setJob(null);

    const form = new FormData();
    form.set("mode", mode);
    form.set("prompt", prompt);
    if (negativePrompt.trim()) form.set("negativePrompt", negativePrompt);
    if (imageUrl.trim()) form.set("imageUrl", imageUrl);
    if (audioUrl.trim()) form.set("audioUrl", audioUrl);
    const imageFile = imageFileRef.current?.files?.[0];
    const audioFile = audioFileRef.current?.files?.[0];
    if (imageFile) form.set("imageFile", imageFile);
    if (audioFile) form.set("audioFile", audioFile);

    const merged = { ...numericParams(params), ...parseJsonObject(extraParams) };
    form.set("params", JSON.stringify(merged));

    const response = await fetch("/api/video", { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Could not start generation");
    } else {
      setJob(body.job as Job);
      setStartedAt(Date.now());
      setElapsed(0);
    }
    setBusy(false);
  }

  const current = MODES.find((m) => m.key === mode)!;
  const needsImage = current.needs.includes("image");
  const needsAudio = current.needs.includes("audio");

  return (
    <main className="mx-auto max-w-3xl px-6 py-14">
      <Link href="/" className="text-xs text-white/40 transition hover:text-white/70">
        ← home
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Video</h1>
      <p className="mt-2 text-sm text-white/45">
        A bench for the video provider, outside the story pipeline. Generations here are not
        attached to a project and are not rendered into anything.
      </p>

      {provider ? (
        <p className="mt-3 text-[11px] text-white/30">
          {provider.name} · {provider.model} · {provider.baseUrl}
        </p>
      ) : (
        <p className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          No video provider is configured.{" "}
          <Link href="/providers" className="underline">
            Add one
          </Link>{" "}
          — or run <code className="text-amber-200">pnpm db:seed</code>, which installs the default.
        </p>
      )}

      <nav className="mt-6 flex gap-1 border-b border-white/10">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`px-3 py-2 text-sm transition ${
              mode === m.key
                ? "border-b-2 border-amber-400 text-white"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <p className="mt-3 text-xs text-white/40">{current.blurb}</p>

      <div className="mt-5 space-y-4">
        <Field
          label="Prompt"
          value={prompt}
          onChange={setPrompt}
          multiline
          placeholder="A person singing, warm studio light"
        />
        <Field
          label={`Negative prompt${provider?.negativePrompt ? " (blank uses the provider's)" : ""}`}
          value={negativePrompt}
          onChange={setNegativePrompt}
          placeholder={provider?.negativePrompt}
        />

        {needsImage && (
          <Reference
            label="Reference image"
            url={imageUrl}
            onUrl={setImageUrl}
            fileRef={imageFileRef}
            accept="image/*"
          />
        )}
        {needsAudio && (
          <Reference
            label="Driving audio"
            url={audioUrl}
            onUrl={setAudioUrl}
            fileRef={audioFileRef}
            accept="audio/*"
          />
        )}

        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">Parameters</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PARAM_FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="text-[11px] uppercase tracking-wide text-white/35">{f.label}</span>
                <input
                  value={params[f.key] ?? ""}
                  onChange={(event) => setParams({ ...params, [f.key]: event.target.value })}
                  className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none focus:border-amber-400/50"
                />
              </label>
            ))}
          </div>
          {needsAudio && (
            <p className="mt-3 text-[11px] text-white/35">
              Speech-to-video conditioning is built at 16 fps, and the clip&apos;s length comes from
              the audio rather than from Frames — a shorter frame count will not shorten it.
            </p>
          )}
          <label className="mt-3 block">
            <span className="text-[11px] uppercase tracking-wide text-white/35">
              Extra params (JSON, merged last)
            </span>
            <textarea
              value={extraParams}
              onChange={(event) => setExtraParams(event.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs outline-none focus:border-amber-400/50"
            />
          </label>
        </section>
      </div>

      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}

      <button
        onClick={generate}
        disabled={busy || active || !prompt.trim() || !provider}
        className="mt-4 rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-black transition hover:bg-amber-300 disabled:opacity-40"
      >
        {active ? "Generating…" : "Generate"}
      </button>

      {job && <Result job={job} elapsed={elapsed} active={active} />}
    </main>
  );
}

function Result({ job, elapsed, active }: { job: Job; elapsed: number; active: boolean }) {
  return (
    <section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">
          {job.status === "failed" ? (
            <span className="text-red-300">failed</span>
          ) : job.status === "completed" ? (
            <span className="text-amber-300">completed</span>
          ) : (
            <span className="text-white/60">{job.status.replace("_", " ")}</span>
          )}
        </h2>
        <p className="text-[11px] text-white/30">
          {active ? `${elapsed}s elapsed` : job.inference_time_s ? `${Math.round(job.inference_time_s)}s` : null}
        </p>
      </div>
      <p className="mt-1 font-mono text-[11px] text-white/25">{job.id}</p>

      {job.status === "failed" && (
        <p className="mt-2 text-xs text-red-400">{job.error?.message ?? "No reason given"}</p>
      )}

      {job.status === "completed" && (
        <div className="mt-3 space-y-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={`/api/video/${job.id}/content`}
            controls
            className="w-full rounded-md border border-white/10"
          />
          <a
            href={`/api/video/${job.id}/content`}
            download={`${job.id}.mp4`}
            className="inline-block text-xs text-white/40 transition hover:text-amber-300"
          >
            download mp4
          </a>
        </div>
      )}
    </section>
  );
}

function Reference({
  label,
  url,
  onUrl,
  fileRef,
  accept,
}: {
  label: string;
  url: string;
  onUrl: (value: string) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
  accept: string;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">{label}</h2>
      <p className="mt-1 text-[11px] text-white/30">
        A URL the video host can reach, or a file from this machine. A file wins if both are given.
      </p>
      <input
        value={url}
        onChange={(event) => onUrl(event.target.value)}
        placeholder="https://…"
        className="mt-2 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none focus:border-amber-400/50"
      />
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        className="mt-2 block w-full text-xs text-white/40 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-xs file:text-white/70"
      />
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  placeholder?: string | undefined;
}) {
  const className =
    "mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none focus:border-amber-400/50";
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-white/35">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          placeholder={placeholder}
          className={className}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={className}
        />
      )}
    </label>
  );
}

function stringifyParam(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Blank means "not set", not zero — an empty box has to leave the field out
 * entirely so the server falls back to its own default.
 */
function numericParams(values: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!raw.trim()) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
