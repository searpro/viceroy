import { and, eq, sql } from "drizzle-orm";
import { createDb, createSqlite, type Db } from "./client";
import { runMigrations } from "./migrate";
import { resolveConfig } from "../config";
import { loadEnvFiles } from "../env";
import {
  captionStyles,
  directionStyles,
  imageStyles,
  narrativeStyles,
  preferences,
  productionDesignStyles,
  promptTemplates,
  providers,
  voiceStyles,
} from "./schema";
import { DEFAULT_PROMPT_TEMPLATES } from "../prompts/defaults";
import { DEFAULT_CAPTION_STYLE } from "../../remotion/schema";

/**
 * Built-in narrative styles.
 *
 * The evaluation checklist is deliberately per style rather than one global
 * list: a bleak ending is a flaw in an underdog story and the point of a
 * cautionary one, so a single vocabulary could not judge both. The evaluator
 * is held to its own style's keys.
 */
const NARRATIVE_STYLES = [
  {
    name: "Crime Documentary",
    description:
      "Cold, factual retelling of a real-feeling crime. Builds through mounting specifics rather than drama.",
    plannerGuidance:
      "Structure as investigation: the scheme working, the first crack, the unravelling, the reckoning. " +
      "Anchor every beat to a concrete detail — a sum, a date, a document, a name. Withhold the full " +
      "picture until the turn. The audience should feel they are being shown evidence, not told a story.",
    writingGuidance:
      "Flat, precise, unhurried. Short declarative sentences. Let the facts carry the weight and never " +
      "editorialise — no 'shockingly', no 'unbelievably'. Specifics over adjectives: not 'a huge sum' " +
      "but 'a hundred and four million dollars'. Present tense for immediacy in the central beats.",
    // What is in the world, not how it is rendered — the grade and lighting
    // register that used to live here is now the image style's
    // `renderGuidance`, so portraits and scenes share it (ADR 0002).
    //
    // Phrased entirely as what IS in frame. Negations belong in a
    // negativePrompt: a diffusion prompt has no "not", so "no fantasy
    // elements" pasted into a positive prompt asks for fantasy elements.
    sceneGuidance:
      "Institutional interiors, paperwork, surveillance angles, plain functional surfaces. " +
      "Evidence rooms, records offices, car parks, front doors.",
    evaluationChecklist: [
      { key: "specificity", description: "Every claim is anchored to a concrete detail, not a generality." },
      { key: "restraint", description: "The prose never editorialises or reaches for shock." },
      { key: "escalation", description: "Each beat raises the stakes on the one before it." },
      { key: "payoff", description: "The reckoning lands and answers the hook the opening set." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
    // Stated explicitly on every built-in rather than left to the column
    // default, because this is the knob a user reaches for first: it decides
    // how often the picture changes, and on this hardware it is also what
    // decides whether a project takes twenty minutes or three hours to
    // generate (findings F12, F30). All three sit at the same values until
    // there is a measured reason for one to differ.
    shotTargetMs: 2500,
    shotMinMs: 1500,
    shotMaxMs: 3500,
  },
  {
    name: "Underdog Rise",
    description:
      "An ordinary person outmanoeuvres a system that dismissed them. Warm, propulsive, satisfying.",
    plannerGuidance:
      "Structure as ascent: the dismissal, the overlooked advantage, the gambit, the vindication. The " +
      "protagonist must win through wit and specific competence, never luck. The opposition should be " +
      "credible and not cartoonish — a system's indifference is a better antagonist than a villain.",
    writingGuidance:
      "Warm, forward-leaning, a little wry. Vary sentence length and let the short ones land the turns. " +
      "Show competence through specific action, not through being told the character is clever. Earn the " +
      "ending — no sudden reversals the story has not paid for.",
    sceneGuidance:
      "Working environments and civic spaces — workshops, municipal halls, streets, meeting rooms. " +
      "Faces and hands doing real work. Tools, benches, paperwork handled rather than filed.",
    evaluationChecklist: [
      { key: "earned_win", description: "The victory follows from choices the story showed, not luck." },
      { key: "credible_opposition", description: "What stands in the way is real and not a caricature." },
      { key: "momentum", description: "Every beat pushes forward; nothing restates what came before." },
      { key: "warmth", description: "The tone invites the listener in rather than lecturing them." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
    shotTargetMs: 2500,
    shotMinMs: 1500,
    shotMaxMs: 3500,
  },
  {
    name: "Cautionary Tale",
    description:
      "A slow slide into consequence. The listener sees the ending coming and cannot look away.",
    plannerGuidance:
      "Structure as descent: the small first compromise, the normalisation, the point of no return, the " +
      "cost. Plant the ending in the opening beat so the listener recognises it when it arrives. The " +
      "protagonist's logic must be understandable at every step — the horror is that it makes sense.",
    writingGuidance:
      "Measured and quiet, tightening as it goes. Resist the urge to moralise; the consequence is the " +
      "argument. Keep the protagonist sympathetic even at their worst. End on the cost, not on a lesson.",
    sceneGuidance:
      "Domestic and ordinary settings made uneasy by framing and empty space — kitchens, hallways, " +
      "parked cars, desks at night. Reflections, doorways, the room after someone has left it.",
    evaluationChecklist: [
      { key: "inevitability", description: "The ending feels foretold by the opening, not tacked on." },
      { key: "sympathy", description: "The protagonist's reasoning stays understandable throughout." },
      { key: "no_moralising", description: "The story never states its lesson outright." },
      { key: "tightening", description: "Tension compounds rather than resetting between beats." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
    shotTargetMs: 2500,
    shotMinMs: 1500,
    shotMaxMs: 3500,
  },
];

// `ttsInstruct` reaches the voice-design model verbatim, and ONLY through the
// task runner — see docs/findings.md F2. Phrases describing pitch, age and
// pace measurably move the output; vaguer mood words do much less.
const VOICE_STYLES = [
  {
    name: "Gravelly Documentarian",
    description: "Low, weathered, unhurried. Suits crime and cautionary material.",
    ttsInstruct:
      "a deep, gravelly older man speaking slowly and deliberately, low pitch, calm and grave, " +
      "with long pauses between sentences",
    deliveryCues:
      "Long sentences are fine; this voice has patience. Give it hard consonants and full stops to " +
      "land on. Avoid exclamation and avoid questions.",
  },
  {
    name: "Warm Storyteller",
    description: "Mid-range, friendly, conversational. Suits underdog and human-interest material.",
    ttsInstruct:
      "a warm friendly adult voice at a natural conversational pace, medium pitch, light and engaged, " +
      "with gentle emphasis on key words",
    deliveryCues:
      "Vary sentence length and let short sentences carry the turns. Direct address works well. Keep " +
      "clauses short enough to say in one breath.",
  },
  {
    name: "Urgent Newsreader",
    description: "Clipped, brisk, high-attention. Suits fast-moving reveals.",
    ttsInstruct:
      "a crisp professional newsreader speaking quickly and clearly, slightly raised pitch, urgent and " +
      "precise, minimal pauses",
    deliveryCues:
      "Short declarative sentences only. Front-load the fact in every sentence. Avoid subordinate " +
      "clauses — this pace cannot carry them.",
  },
];

// flux2-klein-4b measured at 51s per 432x768 frame on CPU (M0 step 3), against
// 55s for ssd-1b — faster AND a generation ahead in quality, so it wins on
// both counts. Its params are the bundle manifest's own: FLUX.2 klein is
// distilled to 4 steps at cfg 1, and raising either costs time without
// improving the image. Model and params are provider configuration, not style
// guidance — see the image provider entry in PROVIDERS below.
//
// The provider's negative prompt is the model-level floor, concatenated under
// every generation whatever style is chosen: these are artifacts flux2 produces
// regardless of the look being asked for. Aesthetic exclusions belong on the
// style, where they cannot leak into a style that wants the opposite — noir's
// "flat lighting" against documentary's available light being the case that
// forced them apart (BUG-014).
const IMAGE_PARAMS = { steps: 4, cfg_scale: 1, sampler: "euler" };
const IMAGE_MODEL = "flux2-klein-4b";
const IMAGE_NEGATIVE_PROMPT =
  "text, watermark, extra fingers, deformed hands, malformed limbs, distorted face";

// `renderGuidance` is prose for the LLM composing a prompt; prefix/suffix are
// the mechanical wrapper applied to whatever it writes. They must agree — the
// whole point of showing the style to the model is that it stops writing
// prompts the wrapper then contradicts (ADR 0002). `negativePrompt` is
// per-style again: one merged list left documentary generations arguing
// against their own available light.
const IMAGE_STYLES = [
  {
    name: "Documentary Realism",
    description: "Desaturated, available-light realism. Reads as footage rather than illustration.",
    renderGuidance:
      "Photographic. Available light, desaturated colour, hard shadows, handheld framing. Natural " +
      "skin texture and ordinary imperfection. Reads as a frame of documentary footage.",
    promptPrefix: "documentary photograph, available light, ",
    promptSuffix: ", desaturated colour, 35mm, natural skin texture, shallow depth of field",
    // Aesthetic only — the model-level artifact terms come from the provider.
    negativePrompt: "illustration, cartoon, painting, cgi, oversaturated, glossy",
  },
  {
    name: "Cinematic Noir",
    description: "High contrast, hard shadows, cool palette. Suits cautionary and crime material.",
    renderGuidance:
      "Composed like a film still. High contrast, hard directional light, deep shadow, cool colour " +
      "grade. Faces partly in shadow. Deliberate, held framing rather than observed.",
    promptPrefix: "cinematic film still, high contrast lighting, ",
    promptSuffix: ", deep shadows, cool colour grade, anamorphic, film grain",
    negativePrompt: "illustration, cartoon, painting, cgi, flat lighting, low contrast",
  },
];

// M7 PR2. Text register only (ADR 0002) — genre/tone/pacing for the
// Development chain's writer stages. See the field-level comment on
// `directionStyles` in lib/db/schema.ts for why this must stay out of any
// image-generation prompt path.
const DIRECTION_STYLES = [
  {
    name: "Feature Drama",
    description: "Character-led, patient pacing. A default that suits most single-story projects.",
    genreGuidance:
      "Contemporary character drama. Grounded stakes — relationships, ambition, consequence — " +
      "rather than genre trappings like crime or fantasy machinery.",
    toneGuidance:
      "Sincere and specific. Earn emotion through concrete detail and behaviour, not stated feeling. " +
      "Restraint over melodrama.",
    pacingGuidance:
      "Patient in the first act, tightening through the second. Let scenes breathe where the " +
      "relationship is doing the work; cut faster once the plot is moving.",
  },
  {
    name: "Genre Thriller",
    description: "Plot-forward, escalating stakes. Suits crime, conspiracy and pursuit premises.",
    genreGuidance:
      "Thriller mechanics: a ticking clock, an information asymmetry, a protagonist working against " +
      "both the antagonist and the truth.",
    toneGuidance: "Tense, controlled, a little cold. Withhold rather than explain; let dread accumulate.",
    pacingGuidance:
      "Fast from the inciting incident. Short scenes, hard cuts at the peak of a beat rather than its " +
      "resolution. Structure toward reversals, not toward comfort.",
  },
];

// M7 PR6. Production design's own register (ADR 0002) — nothing consumes
// this yet (PR8 wires the consuming stage), but the two built-ins ship now
// the same way Direction Style's did a PR ahead of anything reading them.
const PRODUCTION_DESIGN_STYLES = [
  {
    name: "Naturalistic",
    description: "Muted, observed, practical-light sensibility. A default that suits most grounded material.",
    visualLanguageGuidance:
      "Observed rather than composed — spaces and objects look lived-in and unstaged, as they would if a " +
      "documentary crew had simply arrived. Nothing is dressed for the camera's benefit alone.",
    paletteGuidance:
      "Muted, desaturated, true-to-source. Light reads as motivated by what is actually in the room or " +
      "location — window light, practical lamps, overcast sky — not a designed grade sitting on top of it.",
    textureGuidance:
      "Worn, imperfect, specific: chipped paint, mismatched furniture, clothing that shows wear. Period and " +
      "class detail is exact rather than suggested, and nothing looks new unless the story needs it to.",
  },
  {
    name: "Heightened",
    description: "Bold palette, stylised and formal. Suits genre, fable and anything larger-than-life.",
    visualLanguageGuidance:
      "Composed and deliberate — symmetry, saturated blocks of colour, and framing that announces itself " +
      "as a choice rather than an observation. Spaces are designed for the frame, not merely inhabited.",
    paletteGuidance:
      "Bold, high-saturation, a limited and controlled palette per location or faction. Lighting is a " +
      "design element in its own right, not a neutral rendering of what is already there.",
    textureGuidance:
      "Clean, considered, exaggerated where it serves the world — surfaces read as chosen rather than " +
      "found. Period and class detail is stylised into a motif rather than reproduced literally.",
  },
];

const CAPTION_STYLES = [
  {
    name: "Standard",
    description: "Large white caption with a heavy black outline. Legible over any frame.",
    ...DEFAULT_CAPTION_STYLE,
  },
  {
    name: "Bold Uppercase",
    description: "All-caps, tighter to the bottom edge. Suits fast-cut, high-urgency material.",
    ...DEFAULT_CAPTION_STYLE,
    fontSize: 64,
    bottomOffset: 0.1,
    uppercase: true,
  },
];

// The model ids here must be the ids sd-api itself resolves, not the friendly
// names used to discuss them: `/v1/llm/chat/completions` 400s on an unknown id
// rather than falling back, so a wrong one here breaks every LLM stage on a
// fresh install. Check against `GET /v1/llm/models` before changing one.

// Starting values for a Wan speech-to-video workflow's own variables. Under
// ComfyUI these are no longer request fields — the graph decides what it
// exposes — but they remain the right numbers to prefill an editor with.
//
// `fps` is 16 because Wan's speech-to-video conditioning is built at 16 fps:
// any other value desynchronises the generated mouth from the driving audio,
// which is the video-side version of the caption-drift mistake this project
// exists not to repeat.
const VIDEO_PARAMS = {
  width: 832,
  height: 480,
  num_frames: 33,
  fps: 16,
  num_inference_steps: 40,
  guidance_scale: 4.5,
};
const VIDEO_NEGATIVE_PROMPT =
  "text, watermark, distorted face, deformed hands, flickering, morphing artifacts";

const PROVIDERS = [
  { kind: "llm" as const, name: "sd-api (local)", model: "mistral-nemo-instruct-2407" },
  {
    kind: "image" as const,
    name: "sd-api (local)",
    model: IMAGE_MODEL,
    defaultParams: IMAGE_PARAMS,
    negativePrompt: IMAGE_NEGATIVE_PROMPT,
  },
  { kind: "audio" as const, name: "sd-api (local)", model: "qwen3-tts-voicedesign" },
  { kind: "asr" as const, name: "sd-api (local)", model: "parakeet-tdt" },
  {
    kind: "video" as const,
    adapter: "comfyui" as const,
    name: "comfyui (runpod)",
    // ComfyUI has no model name to carry: the checkpoint is a loader node
    // inside the workflow. The Wan model this row used to name is now chosen
    // in the graph the user pastes on the Providers screen.
    model: "",
    defaultParams: VIDEO_PARAMS,
    negativePrompt: VIDEO_NEGATIVE_PROMPT,
  },
];

/**
 * Seed built-in data.
 *
 * Idempotent, and deliberately non-destructive: existing rows are left exactly
 * as they are. Prompt templates and styles are meant to be edited, so a
 * re-seed must never quietly revert someone's tuning.
 */
export function seed(db: Db): { inserted: Record<string, number> } {
  const inserted: Record<string, number> = {};

  inserted.promptTemplates = db
    .insert(promptTemplates)
    .values(DEFAULT_PROMPT_TEMPLATES.map((t) => ({ ...t, builtinTemplate: t.template })))
    .onConflictDoNothing()
    .returning({ key: promptTemplates.key })
    .all().length;

  // Upgrade built-in templates nobody has edited to the current library.
  //
  // `onConflictDoNothing` above protects someone's tuning, which is right —
  // but on its own it also froze every untouched row at whatever text was
  // first seeded, with no way to tell "unedited but old" from "deliberately
  // edited": the only thing available to compare against was the current
  // library, which is precisely what changes.
  //
  // The cost was silent. VIC-003 added `{{groundingInstruction}}` to the
  // story-content templates and not one existing row ever received it, so
  // Context mode's grounding clause was handed to `renderPrompt` and dropped,
  // for every project, without erroring — a supplied-but-unused variable is
  // legal, only the reverse is a failure. Tests never saw it because they seed
  // a fresh database, where the library and the rows agree by construction.
  //
  // `builtinTemplate` breaks that tie: it is what this row was last seeded or
  // reset from, so an edit is `template <> builtinTemplate` regardless of what
  // the library says now. An untouched row is upgraded whole; an edited one is
  // left exactly as it is, and `listPromptTemplates` reports that its built-in
  // has moved on so the editor can offer a reset.
  for (const builtin of DEFAULT_PROMPT_TEMPLATES) {
    db.update(promptTemplates)
      .set({
        section: builtin.section,
        label: builtin.label,
        description: builtin.description,
        variables: builtin.variables,
        template: builtin.template,
        builtinTemplate: builtin.template,
      })
      .where(
        and(
          eq(promptTemplates.key, builtin.key),
          eq(promptTemplates.template, promptTemplates.builtinTemplate),
        ),
      )
      .run();
  }

  inserted.narrativeStyles = db
    .insert(narrativeStyles)
    .values(NARRATIVE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: narrativeStyles.id })
    .all().length;

  inserted.voiceStyles = db
    .insert(voiceStyles)
    .values(VOICE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: voiceStyles.id })
    .all().length;

  inserted.imageStyles = db
    .insert(imageStyles)
    .values(IMAGE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: imageStyles.id })
    .all().length;

  inserted.captionStyles = db
    .insert(captionStyles)
    .values(CAPTION_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: captionStyles.id })
    .all().length;

  inserted.directionStyles = db
    .insert(directionStyles)
    .values(DIRECTION_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: directionStyles.id })
    .all().length;

  inserted.productionDesignStyles = db
    .insert(productionDesignStyles)
    .values(PRODUCTION_DESIGN_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: productionDesignStyles.id })
    .all().length;

  const config = resolveConfig();
  const existingProviders = db.select({ kind: providers.kind }).from(providers).all();
  const haveKinds = new Set(existingProviders.map((p) => p.kind));
  const newProviders = PROVIDERS.filter((p) => !haveKinds.has(p.kind)).map((p) => ({
    ...p,
    // Every kind but video is served by sd-api. Video is ComfyUI, which is a
    // separate process on its own host — pointing it at SD_API_URL would seed
    // a row that 404s on its first request. The seeded row is a placeholder
    // either way: it cannot generate until a workflow is attached to it.
    baseUrl: p.kind === "video" ? config.comfyApiUrl : config.sdApiUrl,
    isDefault: true,
  }));
  if (newProviders.length > 0) {
    db.insert(providers).values(newProviders).run();
  }
  inserted.providers = newProviders.length;

  db.insert(preferences)
    .values([
      { key: "defaultNarrativeStyle", value: NARRATIVE_STYLES[0]!.name },
      { key: "defaultVoiceStyle", value: VOICE_STYLES[0]!.name },
      { key: "defaultImageStyle", value: IMAGE_STYLES[0]!.name },
      { key: "defaultCaptionStyle", value: CAPTION_STYLES[0]!.name },
      { key: "defaultDirectionStyle", value: DIRECTION_STYLES[0]!.name },
      { key: "defaultProductionDesignStyle", value: PRODUCTION_DESIGN_STYLES[0]!.name },
      { key: "defaultMode", value: "auto" },
    ])
    .onConflictDoNothing()
    .run();

  return { inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Run directly via tsx, which does not read .env files the way Next does —
  // without this, `pnpm db:migrate` and `pnpm db:seed` operate on the default
  // database while the app runs on the configured one.
  loadEnvFiles();
  const config = resolveConfig();
  const sqlite = createSqlite(config.databasePath);
  const db = createDb(sqlite);
  runMigrations(db);
  const { inserted } = seed(db);
  sqlite.close();
  console.log(
    `seeded ${config.databasePath}: ` +
      Object.entries(inserted)
        .map(([k, v]) => `${v} ${k}`)
        .join(", "),
  );
}

export { sql };
