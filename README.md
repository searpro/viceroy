# Viceroy

A story-to-video pipeline. One line of an idea goes in; a rendered short film comes out — script, images, voiceover, captions and all — with every model running on self-hosted GPUs and nothing sent to a cloud inference API.

The interesting part isn't the films. It's what it takes to make a twenty-stage generative pipeline survive contact with reality: jobs that fail halfway, GPUs that disappear, models that return something unusable, and a run you want to resume tomorrow rather than restart.

---

## The pipeline

Twenty-plus stages modelled on how films actually get developed — concept, logline, characters, world-building, beat sheet, treatment, screenplay, story bible, scene breakdown, storyboards, shot list and previs, production timeline — each with a human approval gate before the next begins.

Stages live in `lib/pipeline/`, one module per stage, each with colocated tests.

Screenplays are generated in [Fountain](https://fountain.io) format (`fountain-js`) and exported to PDF (`pdfkit`), so the intermediate artifacts are real documents rather than a blob of model output.

## Durable orchestration

The queue (`lib/queue/`) is SQLite-backed with **atomic job claiming**, retries, abort support, and stale-job reclamation for workers that die mid-task.

The design decision worth calling out: **pipeline state is derived from the artifacts a run has produced, not from a status column.** A status column is a claim about the world that drifts the moment a process is killed. Reading state from what actually exists on disk means a crashed run resumes from where it genuinely got to, and re-running a stage is idempotent by construction.

The web app and the worker are separate processes sharing that database — which, as the commit history records, is exactly the kind of arrangement where you discover they were pointed at two different files.

## Pluggable inference

Image, video and LLM backends sit behind one interface (`lib/backends/`), resolved per job at runtime with no restart:

- **ComfyUI** — with dynamic workflow-graph binding (`comfy-bind.ts`), so a workflow JSON's nodes are located and parameterised at call time instead of being hardcoded
- **sd-api** — a local stable-diffusion.cpp server
- **RunPod / Vast AI** — burst GPUs for work the local box can't hold

Every prompt sent to every model is recorded by a tracing layer, browsable at `/traces`. Debugging a twenty-stage run without that is guesswork.

## Frame-accurate captions

Captions kept drifting out of sync with the narration. ASR transcripts had accurate timing but wrong words; the authored script had the right words and no timing.

The fix (`lib/pipeline/align.ts`) uses **ASR output for timing only**, aligning it onto the authored narration by token matching, with interpolated fallbacks where a match fails. Captions read exactly as written and stay locked to the audio.

## Rendering

Scene images, continuous voiceover, dialogue and word-timed captions are composed into a timeline and rendered with [Remotion](https://remotion.dev) (`remotion/`). Encoder output is asserted with `ffprobe` rather than eyeballed.

## Testing

**58 test files**, colocated with the modules they cover. None of them call a live model — backends are seams, so the suite is fast, free and deterministic. `pnpm check` runs typecheck and tests together.

---

## Stack

TypeScript (strict) · Next.js · React · Drizzle ORM + SQLite (`better-sqlite3`) · Zod · Remotion · Tailwind · Vitest · ComfyUI · RunPod / Vast AI

## Running it

```bash
pnpm install
pnpm db:migrate      # create the schema
pnpm db:seed         # narrative, voice, image, caption and direction styles

pnpm dev             # web app
pnpm dev:worker      # job worker (separate terminal)
```

`VICEROY_DATA_DIR` sets where the database and generated artifacts live.

You will also need at least one inference backend reachable — a ComfyUI instance, an sd-api server, or RunPod credentials — configured under `/providers` in the app.

```bash
pnpm check           # typecheck + tests
```

## Layout

```
app/          Next.js app — projects, jobs, providers, prompt templates, traces
lib/
  pipeline/   one module per stage, with colocated tests
  queue/      SQLite job queue: atomic claiming, retries, reclamation
  backends/   ComfyUI, sd-api, RunPod — behind one interface
  db/         Drizzle schema and migrations
remotion/     video composition and rendering
worker/       job runner
docs/         plan, ADRs, findings, status
```

## Status

A working personal project, not a product. There is no auth, no multi-user support, and no deployment story beyond running it yourself. The parts worth reading are the queue, the backend abstraction, and the caption alignment.
