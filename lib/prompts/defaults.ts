export type PromptTemplateSeed = {
  key: string;
  section: string;
  label: string;
  description: string;
  template: string;
  variables: { name: string; description: string }[];
};

const STORY_VARS = [
  { name: "idea", description: "The one-line idea the user typed" },
  {
    name: "context",
    description: "The source material pasted in Context mode, verbatim",
  },
  { name: "sentences", description: "The narration, one numbered sentence per line" },
  { name: "sentenceCount", description: "How many numbered sentences there are" },
  { name: "sceneText", description: "The narration span belonging to this scene" },
  { name: "sceneDescription", description: "One-line summary of what this scene shows" },
  { name: "characters", description: "The cast, as name + appearance lines" },
  {
    name: "sceneGuidance",
    description: "The narrative style's world: settings, props, subjects — not how it is rendered",
  },
  {
    name: "imageStyleGuidance",
    description: "The image style's rendering register: grade, lighting quality, film stock",
  },
  { name: "characterName", description: "The character being portrayed" },
  { name: "characterDescription", description: "That character's written description" },
  { name: "synopsis", description: "The working synopsis" },
  { name: "story", description: "The full story text" },
  { name: "narrativeStyle", description: "Name of the selected narrative style" },
  { name: "plannerGuidance", description: "The narrative style's structural guidance" },
  { name: "writingGuidance", description: "The narrative style's prose guidance" },
  { name: "deliveryCues", description: "The voice style's delivery guidance" },
  { name: "targetSceneCount", description: "How many scenes the style asks for" },
  { name: "targetWordCount", description: "Target length of the narration, in words" },
  {
    name: "direction",
    description:
      "Free-text steer supplied by the user, pre-formatted with its own heading; " +
      "empty string when there is none, so no empty labelled section is left behind",
  },
  { name: "checklist", description: "The narrative style's evaluation checklist, pre-formatted" },
  { name: "issues", description: "Issues the evaluator raised, pre-formatted" },
  {
    name: "groundingInstruction",
    description:
      "Context-mode faithfulness clause; empty string in Idea mode, so the template " +
      "renders identically to today when this is unused",
  },
  {
    name: "contextBlock",
    description:
      "The source context text, pre-formatted with a heading, shown to the evaluator " +
      "only in Context mode; empty string otherwise",
  },
  // Development chain (M7 PR2). Direction Style's fields — genre/tone/pacing
  // guidance for the writer — never appear on any image-prompt template's
  // variable list, only these text-register ones (ADR 0002).
  { name: "genreGuidance", description: "The direction style's genre guidance" },
  { name: "toneGuidance", description: "The direction style's tone guidance" },
  { name: "pacingGuidance", description: "The direction style's pacing guidance" },
  { name: "concept", description: "The Development chain's approved concept" },
  { name: "logline", description: "The Development chain's approved logline" },
  {
    name: "castSummary",
    description: "The Development chain's cast so far, as name + description + arc lines",
  },
  {
    name: "worldSummary",
    description: "The Development chain's world-building notes plus its locations and props",
  },
  { name: "storyStructure", description: "The Development chain's approved numbered story structure" },
  { name: "beatSheet", description: "The Development chain's approved beat sheet" },
  { name: "treatment", description: "The Development chain's approved prose treatment" },
  { name: "screenplay", description: "The Development chain's screenplay, in Fountain syntax" },
  // Preproduction (M7 PR6).
  {
    name: "storyBible",
    description: "The Development chain's approved story bible — the capstone document Preproduction reads from",
  },
  {
    name: "scriptBreakdown",
    description: "The Preproduction chain's approved coarse script breakdown",
  },
  {
    name: "sceneBreakdown",
    description: "The Preproduction chain's approved fine-grained scene breakdown",
  },
  {
    name: "existingFacts",
    description: "Continuity facts already on record from an earlier pass, pre-formatted",
  },
  // Preproduction (M7 PR8). Production Design Style's fields — visual
  // language / palette / texture guidance for the production department —
  // like `genreGuidance`/`toneGuidance`/`pacingGuidance` above, confined to
  // these two text-register templates only (ADR 0002); PR9's image-prompt
  // templates resolve this style's guidance into their own variable fold,
  // not this one.
  { name: "visualLanguageGuidance", description: "The production design style's visual-language guidance" },
  { name: "paletteGuidance", description: "The production design style's colour/lighting-philosophy guidance" },
  { name: "textureGuidance", description: "The production design style's materials/texture/period-detail guidance" },
  {
    name: "visualBible",
    description:
      "The Preproduction chain's approved visual bible — production design style guidance plus every " +
      "approved location/prop and continuity fact, assembled",
  },
  // Preproduction (M7 PR9) — this stage's own image-prompt variable fold, per
  // the comment on `visualLanguageGuidance` above: a diffusion prompt wants
  // comma-separated phrases, not the prose `visualLanguageGuidance`/
  // `paletteGuidance`/`textureGuidance` are written for, so PR9 folds those
  // three into `productionDesignGuidance` itself rather than reusing the
  // prose variables here.
  {
    name: "subjectDescription",
    description: "A location's or prop's own name and description, folded into one phrase",
  },
  {
    name: "productionDesignGuidance",
    description:
      "Production Design Style's visual-language/palette/texture guidance, folded into " +
      "comma-separated phrases for a diffusion prompt — content, not the rendering register " +
      "(that's Image Style's promptPrefix/promptSuffix, applied around this template's output, " +
      "not inside it)",
  },
  // Preproduction (M7 PR10) — the structured shotType/cameraAngle/cameraMovement/lens
  // fields, folded into one comma-separated phrase for the diffusion prompt, same
  // fold-not-prose discipline `productionDesignGuidance` above already applies. The
  // four fields also live independently as `storyboard_panels` columns — this is
  // just their rendering into the one image-generation call, not their source of
  // truth.
  {
    name: "shotDescriptor",
    description:
      "A storyboard panel's shotType/cameraAngle/cameraMovement/lens, folded into one phrase",
  },
  // Preproduction (M7 PR11) — the approved storyboard panel's own assembled
  // diffusion prompt, handed to an LLM as *reference material* for splitting
  // into the keyframe/motion registers, not itself sent to an image backend
  // (that already happened in `runStoryboards`) — see `dev.shot_list`'s own
  // template for why its instructions explicitly tell the model to ignore
  // any rendering-register language already baked into this string.
  {
    name: "storyboardPanelPrompt",
    description: "The source storyboard panel's own assembled image prompt, for reference",
  },
];

function pick(...names: string[]) {
  return STORY_VARS.filter((v) => names.includes(v.name));
}

/**
 * The built-in prompt library.
 *
 * Seeded into `prompt_templates` and editable from there — the database row is
 * what runs, never this file. Re-seeding only fills in keys that are missing,
 * so an edited template is never silently reverted.
 */
export const DEFAULT_PROMPT_TEMPLATES: PromptTemplateSeed[] = [
  {
    key: "synopsis.generate",
    section: "Synopsis",
    label: "Generate synopsis",
    description: "Turns the user's one-line idea into a working synopsis.",
    variables: pick(
      "idea",
      "narrativeStyle",
      "plannerGuidance",
      "targetSceneCount",
      "groundingInstruction",
    ),
    template: `You are a story developer working in the "{{narrativeStyle}}" style.

Style guidance:
{{plannerGuidance}}
{{groundingInstruction}}

Develop the following into a synopsis for a short narrated video of about {{targetSceneCount}} scenes:

"{{idea}}"

The synopsis must:
- name the central figure and what they want
- state what stands in their way
- carry a specific, concrete hook in the first sentence
- end on the turn or reversal the story is built around
- stay grounded in the idea as given; do not swap the premise for a different one

Write 120-180 words of flowing prose. No headings, no bullet points, no
preamble, no closing commentary. Output only the synopsis.`,
  },
  {
    key: "synopsis.fromContext",
    section: "Synopsis",
    label: "Generate synopsis from source material",
    description:
      "Context mode's opening stage. Distinct from synopsis.generate because the input is " +
      "pasted source material to be condensed, not a one-line idea to be elaborated.",
    variables: pick("context", "narrativeStyle", "plannerGuidance", "targetSceneCount"),
    template: `You are a story developer working in the "{{narrativeStyle}}" style.

Style guidance:
{{plannerGuidance}}

Below is source material the user supplied. Treat it as the factual ground
truth for everything that follows. Your job is to find the story already in it
and condense that into a synopsis for a short narrated video of about
{{targetSceneCount}} scenes.

Source material:
{{context}}

The synopsis must:
- name the central figure and what they want
- state what stands in their way
- carry a specific, concrete hook in the first sentence
- end on the turn or reversal the material is built around
- introduce no people, events, dates, causes or outcomes the material does not
  state or reasonably imply
- stay narrower and more incomplete rather than inventing to fill a gap, if the
  material does not carry enough for the full length

This is prompt adherence, not fact-checking: you have no way to verify the
material itself, only to avoid adding to it.

Write 120-180 words of flowing prose. No headings, no bullet points, no
preamble, no closing commentary. Output only the synopsis.`,
  },
  {
    key: "synopsis.refine",
    section: "Synopsis",
    label: "Refine synopsis",
    description: "Rewrites the current synopsis under a user's direction.",
    variables: pick("synopsis", "direction", "narrativeStyle", "plannerGuidance", "groundingInstruction"),
    template: `You are revising a synopsis for a short narrated video in the
"{{narrativeStyle}}" style.

Style guidance:
{{plannerGuidance}}
{{groundingInstruction}}

Current synopsis:
{{synopsis}}

The writer has asked for this change:
{{direction}}

Apply that change. Keep everything the direction does not touch. Do not
restructure or re-premise the story beyond what was asked.

Write 120-180 words of flowing prose. Output only the revised synopsis.`,
  },
  {
    key: "story.write",
    section: "Story",
    label: "Write story",
    description: "Elaborates the synopsis into the full narration text.",
    variables: pick(
      "synopsis",
      "narrativeStyle",
      "writingGuidance",
      "deliveryCues",
      "targetSceneCount",
      "targetWordCount",
      "groundingInstruction",
    ),
    template: `You are writing the narration for a short video in the
"{{narrativeStyle}}" style.

Style guidance:
{{writingGuidance}}
{{groundingInstruction}}

It will be read aloud by a single narrator. Delivery:
{{deliveryCues}}

Synopsis:
{{synopsis}}

Write the complete narration. Requirements:
- about {{targetWordCount}} words, and it must work as continuous spoken text
- structured so it breaks naturally into roughly {{targetSceneCount}} beats
- open on a concrete image or fact, never on a throat-clearing generality
- one narrator throughout; no dialogue tags, no character voices, no "meanwhile"
- write numbers, dates and times as words, the way they are spoken
- no headings, no scene labels, no stage directions, no bullet points

Output only the narration text.`,
  },
  {
    key: "story.refine",
    section: "Story",
    label: "Refine story",
    description: "Rewrites the current narration under a user's direction.",
    variables: pick(
      "story",
      "direction",
      "narrativeStyle",
      "writingGuidance",
      "deliveryCues",
      "targetWordCount",
      "groundingInstruction",
    ),
    template: `You are revising the narration for a short video in the
"{{narrativeStyle}}" style.

Style guidance:
{{writingGuidance}}
{{groundingInstruction}}

It will be read aloud by a single narrator. Delivery:
{{deliveryCues}}

Current narration:
{{story}}

The writer has asked for this change:
{{direction}}

Apply that change. Keep everything the direction does not touch — this is a
revision, not a fresh draft. Hold to about {{targetWordCount}} words, keep it
continuous spoken text with one narrator, write numbers/dates/times as words,
and use no headings, scene labels, stage directions or bullet points.

Output only the revised narration.`,
  },
  {
    key: "story.evaluate",
    section: "Story",
    label: "Evaluate story",
    description: "Scores the story against the narrative style's own checklist.",
    variables: pick("story", "narrativeStyle", "checklist", "contextBlock"),
    template: `You are a story editor judging a short video narration written in the
"{{narrativeStyle}}" style.

Judge it against this checklist and nothing else. A quality this checklist does
not mention is not a flaw here.

{{checklist}}

Narration:
{{story}}
{{contextBlock}}

Respond with a single JSON object, no prose around it:

{
  "verdict": "pass" | "revise",
  "dimensions": {
    "<checklist key>": { "score": <1-5>, "comment": "<one sentence>" }
  },
  "issues": [
    { "severity": "low" | "medium" | "high", "note": "<what is wrong and where>" }
  ]
}

Rules:
- include every checklist key in "dimensions", using the exact keys given
- "revise" if any dimension scores 2 or below, otherwise "pass"
- leave "issues" empty on a pass
- be specific: quote the phrase you mean rather than describing it in general terms`,
  },
  {
    key: "story.revise",
    section: "Story",
    label: "Revise story",
    description: "Rewrites the story to address the evaluator's issues.",
    variables: pick(
      "story",
      "narrativeStyle",
      "writingGuidance",
      "issues",
      "targetWordCount",
      "groundingInstruction",
    ),
    template: `You are revising the narration for a short video in the
"{{narrativeStyle}}" style.

Style guidance:
{{writingGuidance}}
{{groundingInstruction}}

Current narration:
{{story}}

An editor raised these issues:
{{issues}}

Rewrite the narration so every issue is addressed. Keep what is already
working — this is a revision, not a fresh draft. Hold to about
{{targetWordCount}} words, keep it continuous spoken text with one narrator,
and keep numbers and times written as words.

Output only the revised narration.`,
  },
  {
    key: "elements.characters",
    section: "Elements",
    label: "Extract characters",
    description: "Finds the cast and fixes each one's canonical look.",
    variables: pick("story", "sceneGuidance", "groundingInstruction"),
    template: `Identify the people who appear in this narration.

Narration:
{{story}}

The world this story takes place in:
{{sceneGuidance}}
{{groundingInstruction}}

For each person who is actually depicted — not merely mentioned in passing —
give a name and a fixed visual description.

The "appearance" field is the important one. It generates this person's
reference portrait, and that portrait is then used to keep their face the same
in every scene they appear in. Anything it leaves unsaid gets invented, and
whatever is invented is what the audience sees for the rest of the video.

It must be short, concrete and purely visual. No personality, no backstory, no
camera or lighting language — nothing that could be drawn differently from one
reading to the next.

**Start it with the person's apparent gender and age**, then build, hair, and
clothing. Write "a woman in her late fifties, slim, short curly grey hair,
conservative navy suit" — never "Late 50s, slim build, short curly grey hair,
business suit", which does not say who is being drawn and will be guessed.

Respond with a single JSON object, no prose around it:

{
  "characters": [
    {
      "name": "<name or role, e.g. 'the plumber'>",
      "description": "<who they are in the story, one or two sentences>",
      "appearance": "<8-20 words, starting with apparent gender and age, purely visual>"
    }
  ]
}

At most four characters. If nobody is depicted, return an empty array.`,
  },
  {
    key: "elements.beats",
    section: "Elements",
    label: "Group narration into scenes",
    description: "Assigns each numbered sentence to a scene. Returns indices only.",
    variables: pick("sentences", "sentenceCount", "targetSceneCount"),
    template: `Group this narration into about {{targetSceneCount}} scenes for a video.

Each sentence is numbered. Sentences {{sentenceCount}} in total, numbered 0 upward.

{{sentences}}

Rules:
- scenes must be contiguous runs of sentences, in order
- every sentence must belong to exactly one scene — no gaps, no overlaps
- the first scene starts at sentence 0; the last scene ends at the final sentence
- break where the setting, subject or moment changes
- a scene is normally two to four sentences

Respond with a single JSON object, no prose around it:

{
  "scenes": [
    { "startSentence": 0, "endSentence": 2, "description": "<what this scene shows, one line>" }
  ]
}`,
  },
  {
    key: "elements.scene",
    section: "Elements",
    label: "Visualise a scene",
    description: "Turns one scene's narration into a storyboard and an image prompt.",
    variables: pick(
      "sceneText",
      "sceneDescription",
      "characters",
      "sceneGuidance",
      "imageStyleGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Design a single still image for one scene of a narrated video.

What the narrator says over this scene:
{{sceneText}}

What the scene shows:
{{sceneDescription}}

Cast (use these appearance descriptions verbatim if the character appears):
{{characters}}

The world this story takes place in:
{{sceneGuidance}}

How the finished image is rendered — the prompt you write must agree with this,
not argue with it:
{{imageStyleGuidance}}
{{groundingInstruction}}
{{direction}}

Respond with a single JSON object, no prose around it:

{
  "storyboard": "<what the viewer sees: subject, action, setting, camera framing>",
  "imagePrompt": "<the generation prompt: comma-separated visual phrases. State only what IS in the frame — never copy a negation like 'no X', 'without X' or 'not X' out of the narration above, even if the narration itself uses one>",
  "characters": ["<names from the cast who appear, or empty>"]
}

Rules for "imagePrompt":
- describe only what is visible in one frozen moment
- no narrative, no cause and effect, no words like "after" or "then"
- **never write a person's name.** Describe them by their appearance
  description instead, pasted in verbatim. The image generator renders names
  as literal text painted into the picture — a bag labelled "HAL GRIFFIN"
- **state only what IS in the frame.** Never write "no X", "without X" or
  "not X": there is no negation here, so "no fantasy elements" asks for
  fantasy elements
- keep the subject centred with vertical headroom, so it reads well once
  cropped to a tall frame. **Never write the aspect ratio, or the words
  "9:16", "vertical composition", "portrait orientation" or "tall frame"
  themselves** — the frame shape comes from the image generator's output
  size, not from words in the prompt, so naming it is not describing the
  image, it is restating this rule

Put the names of the characters who appear in the "characters" array. That is
what the array is for — the prompt itself describes them without naming them.`,
  },
  {
    key: "character.portrait",
    section: "Elements",
    label: "Character portrait prompt",
    description: "Builds the reference portrait prompt for one character.",
    // `characterName` is deliberately absent. The image generator paints a
    // name it is given as literal text into the picture, so advertising it in
    // the editor is an invitation to produce a portrait with a caption burned
    // across it — the same failure `elements.scene` warns about at length.
    // No art-direction variable here, and that is the fix for BUG-009 rather
    // than an omission. This template's output goes straight to the diffusion
    // model with no LLM in between, so it must stay comma-separated phrases —
    // `renderGuidance` is prose written for the model that composes a scene
    // prompt, and pasting it here would put sentences into a diffusion prompt.
    //
    // The rendering register still reaches this portrait: `runCharacterImages`
    // wraps it in the image style's own `promptPrefix`/`promptSuffix`, the
    // same wrapper every scene image gets. Once the *scene* register also
    // comes from the image style rather than the narrative style, portrait and
    // scene are rendered alike by construction. The story's settings and props
    // are correctly absent — this is a face against a plain background.
    //
    // Framing comes before `{{characterDescription}}` rather than after
    // (BUG-26). Earlier phrases in a comma-separated diffusion prompt carry
    // more weight, and `appearanceTag` routinely ends in a clothing clause
    // ("...blue shirt, grey slacks") — with framing trailing that, the
    // clothing was winning and the model was framing wide enough to show it.
    // Leading with a stronger, doubled framing instruction and closing with
    // the original one keeps the crop instruction weighted at both ends.
    variables: pick("characterDescription"),
    template: `tightly cropped, centred head-and-shoulders portrait, face fills
most of the frame, {{characterDescription}}, neutral expression, facing
camera, plain uncluttered background, evenly lit, full face clearly visible
and unobstructed`,
  },
  {
    key: "concept_art.location",
    section: "Preproduction",
    label: "Location concept art prompt",
    description: "Builds the concept-art prompt for one location (M7 PR9, stage 16).",
    // Same discipline as `character.portrait` above: this goes straight to
    // the diffusion model with no LLM in between, so it stays comma-separated
    // phrases, never prose. `{{subjectDescription}}` and
    // `{{productionDesignGuidance}}` are both CONTENT — what is physically in
    // the world (materials, construction, what's actually there) — never the
    // rendering register. The rendering register is Image Style's own
    // `promptPrefix`/`promptSuffix`, applied by `runConceptArt` around this
    // template's output, the same wrapper every other image-generation call
    // in this codebase gets (ADR 0002; see `runConceptArt`'s own doc comment
    // in dev.ts for why getting this split backwards here specifically is
    // costly).
    variables: pick("subjectDescription", "productionDesignGuidance"),
    template: `wide establishing shot of a real location, no people, {{subjectDescription}},
{{productionDesignGuidance}}, natural environmental detail, believable scale`,
  },
  {
    key: "concept_art.prop",
    section: "Preproduction",
    label: "Prop concept art prompt",
    description: "Builds the concept-art prompt for one prop (M7 PR9, stage 16).",
    // Same register discipline as `concept_art.location` above.
    variables: pick("subjectDescription", "productionDesignGuidance"),
    template: `product-style concept photograph of a single object, no people, no hands,
{{subjectDescription}}, {{productionDesignGuidance}}, plain uncluttered background, evenly lit,
object fills most of the frame`,
  },
  {
    key: "storyboard.panel",
    section: "Preproduction",
    label: "Storyboard panel prompt",
    description: "Builds the image prompt for one storyboard panel (M7 PR10, stage 17).",
    // Same discipline as `concept_art.location`/`concept_art.prop` above: no
    // LLM between this and the diffusion model, so comma-separated phrases,
    // never prose. `{{shotDescriptor}}` (the panel's own shotType/cameraAngle/
    // cameraMovement/lens, folded) and `{{subjectDescription}}` (the beat's
    // visual content) and `{{productionDesignGuidance}}` are all CONTENT —
    // what the frame depicts and how it's staged, never the rendering
    // register. Image Style's promptPrefix/promptSuffix wrap this template's
    // output the same way they wrap every other image-generation call in
    // this codebase (ADR 0002).
    variables: pick("shotDescriptor", "subjectDescription", "productionDesignGuidance"),
    template: `storyboard frame, cinematic composition, {{shotDescriptor}}, {{subjectDescription}},
{{productionDesignGuidance}}, film production concept art, believable scale`,
  },
  /* ------------------------------------------------------- Development (M7) */
  // Each of these five is deliberately scoped to one stage's own output plus
  // what immediately precedes it, not the whole chain's history — finding
  // F10 measured the writer model's context preset at a fixed 4096 tokens, so
  // a mega-prompt carrying concept+logline+cast+world in full would silently
  // truncate the same way one whole-story `elements` call did.
  {
    key: "dev.concept",
    section: "Development",
    label: "Generate concept",
    description: "Turns the user's one-line idea (or source material) into a one-paragraph concept.",
    variables: pick("idea", "genreGuidance", "toneGuidance", "direction", "groundingInstruction"),
    template: `You are developing a concept for a film or series in this direction:

Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{groundingInstruction}}
{{direction}}

Starting point:
{{idea}}

Write a one-paragraph concept (80-120 words) that:
- names the central figure and their situation
- states the premise's central tension or question
- is specific enough to pitch, not a genre description

No headings, no bullet points, no preamble. Output only the concept.`,
  },
  {
    key: "dev.logline",
    section: "Development",
    label: "Generate logline",
    description: "Compresses the approved concept into a single-sentence logline.",
    variables: pick("concept", "genreGuidance", "toneGuidance", "direction"),
    template: `You are writing a logline for this concept:

{{concept}}

Style guidance:
Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{direction}}

Write ONE sentence (25-40 words) that names the protagonist, their goal, the
obstacle, and what is at stake. No title, no genre label, no commentary.
Output only the logline.`,
  },
  {
    key: "dev.characters",
    section: "Development",
    label: "Extract characters and arcs",
    description: "Invents the principal cast from the concept and logline, each with an arc.",
    variables: pick("concept", "logline", "genreGuidance", "toneGuidance", "direction", "groundingInstruction"),
    template: `Invent the principal cast for this project.

Concept:
{{concept}}

Logline:
{{logline}}

Style guidance:
Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{groundingInstruction}}
{{direction}}

For each principal character, give:
- a name
- "description": who they are and what they want, one or two sentences
- "arc": how they change from the start of the story to the end, one or two
  sentences — not what happens to them, but how it changes them

Respond with a single JSON object, no prose around it:

{
  "characters": [
    { "name": "<name>", "description": "<who they are>", "arc": "<how they change>" }
  ]
}

At most five characters. Every character must have all three fields.`,
  },
  {
    key: "dev.world_building",
    section: "Development",
    label: "Build the world",
    description:
      "Writes the project's rules/tone/theme prose plus its locations and props, from the " +
      "concept, logline and cast so far.",
    variables: pick(
      "concept",
      "logline",
      "castSummary",
      "genreGuidance",
      "toneGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Build the world this project takes place in.

Concept:
{{concept}}

Logline:
{{logline}}

Cast so far:
{{castSummary}}

Style guidance:
Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{groundingInstruction}}
{{direction}}

Respond with a single JSON object, no prose around it:

{
  "rules": "<the world's rules, tone and themes, in prose — NOT locations or props, 80-150 words>",
  "locations": [
    { "name": "<location>", "description": "<what it looks and feels like, one or two sentences>" }
  ],
  "props": [
    { "name": "<prop>", "description": "<what it looks like and why it matters, one or two sentences>" }
  ]
}

"rules" is prose about the world's internal logic, mood and themes — not a
list of places or objects; those belong in "locations"/"props" instead. Up to
six locations and six props, only ones that actually matter to this story.`,
  },
  {
    key: "dev.story_structure",
    section: "Development",
    label: "Write story structure",
    description: "Lays out the project's structure as a sequence of numbered story beats.",
    variables: pick(
      "concept",
      "logline",
      "castSummary",
      "worldSummary",
      "genreGuidance",
      "pacingGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Lay out the story structure for this project.

Concept:
{{concept}}

Logline:
{{logline}}

Cast:
{{castSummary}}

World:
{{worldSummary}}

Style guidance:
Genre: {{genreGuidance}}
Pacing: {{pacingGuidance}}
{{groundingInstruction}}
{{direction}}

Write the structure as 6-10 numbered beats, one line each, in the form
"<n>. <what happens, and whose turn it is>". Cover setup through resolution;
each beat must follow causally from the one before it. No headings, no
commentary before or after the numbered list. Output only the numbered beats.`,
  },
  {
    key: "dev.beat_sheet",
    section: "Development",
    label: "Generate beat sheet",
    description: "Expands the approved story structure into a detailed, scene-aware beat sheet.",
    variables: pick(
      "concept",
      "storyStructure",
      "castSummary",
      "genreGuidance",
      "pacingGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Expand the story structure below into a detailed beat sheet for this project.

Concept:
{{concept}}

Story structure:
{{storyStructure}}

Cast:
{{castSummary}}

Style guidance:
Genre: {{genreGuidance}}
Pacing: {{pacingGuidance}}
{{groundingInstruction}}
{{direction}}

Write the beat sheet as numbered beats, one line each, in the form
"<n>. <what happens>". Expand each structure beat into two or three finer
beats that name the specific scene action and turn, in causal order from
setup through resolution. No headings, no commentary before or after the
numbered list. Output only the numbered beats.`,
  },
  {
    key: "dev.treatment",
    section: "Development",
    label: "Generate treatment",
    description: "Writes a prose treatment from the approved beat sheet.",
    variables: pick(
      "concept",
      "beatSheet",
      "castSummary",
      "genreGuidance",
      "toneGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Write a prose treatment for this project, from the beat sheet below.

Concept:
{{concept}}

Beat sheet:
{{beatSheet}}

Cast:
{{castSummary}}

Style guidance:
Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{groundingInstruction}}
{{direction}}

Write 400-700 words of flowing prose, present tense, covering the whole
story from setup through resolution in scene order. This is a treatment for
a reader to judge the story by, not a script — no dialogue, no scene
headings, no shot list. No preamble, no commentary before or after the
prose. Output only the treatment.`,
  },
  {
    key: "dev.screenplay",
    section: "Development",
    label: "Generate screenplay",
    description: "Writes a Fountain-syntax screenplay from the approved treatment.",
    variables: pick(
      "concept",
      "treatment",
      "castSummary",
      "genreGuidance",
      "toneGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `Write a full screenplay for this project, from the treatment below, in
valid Fountain syntax and nothing else.

Concept:
{{concept}}

Treatment:
{{treatment}}

Cast:
{{castSummary}}

Style guidance:
Genre: {{genreGuidance}}
Tone: {{toneGuidance}}
{{groundingInstruction}}
{{direction}}

Output strict Fountain syntax only — this is parsed by a Fountain parser, not
read as prose. Follow these rules exactly:
- Scene headings (sluglines) on their own line, in caps, starting with INT.
  or EXT., e.g. "INT. REYNA'S SHOP - DAY".
- Action lines in plain sentence case, left-aligned, no markdown.
- Character cues on their own line, in caps, immediately before their
  dialogue, e.g. "REYNA".
- Dialogue on the line(s) directly under its character cue.
- Parentheticals, when needed, on their own line between a character cue and
  its dialogue, in parentheses, e.g. "(quietly)".
- A blank line between every element (scene heading, action, character cue,
  dialogue, and the next scene heading).
- Cover the whole story from setup through resolution, in scene order,
  dramatizing the treatment's beats as scenes with dialogue rather than
  summarizing them.

No title page, no prose commentary, no markdown formatting, no code fences,
nothing before the first scene heading or after the last line of the last
scene. Output only the screenplay itself.`,
  },
  {
    key: "dev.screenplay_evaluate",
    section: "Development",
    label: "Evaluate screenplay",
    description: "Scores the screenplay against a Fountain-specific checklist, ahead of the revision loop.",
    variables: pick("screenplay", "checklist"),
    template: `You are a script editor judging a screenplay written in valid Fountain
syntax.

Judge it against this checklist and nothing else. A quality this checklist
does not mention is not a flaw here.

{{checklist}}

Screenplay:
{{screenplay}}

Respond with a single JSON object, no prose around it:

{
  "verdict": "pass" | "revise",
  "dimensions": {
    "<checklist key>": { "score": <1-5>, "comment": "<one sentence>" }
  },
  "issues": [
    { "severity": "low" | "medium" | "high", "note": "<what is wrong and where>" }
  ]
}

Rules:
- include every checklist key in "dimensions", using the exact keys given
- "revise" if any dimension scores 2 or below, otherwise "pass"
- leave "issues" empty on a pass
- be specific: quote the scene heading or character cue you mean rather than
  describing it in general terms`,
  },
  {
    key: "dev.screenplay_revise",
    section: "Development",
    label: "Revise screenplay",
    description: "Rewrites the screenplay in Fountain syntax to address the evaluator's issues.",
    variables: pick("screenplay", "issues"),
    template: `You are revising a screenplay written in valid Fountain syntax.

Current screenplay:
{{screenplay}}

An editor raised these issues:
{{issues}}

Rewrite the screenplay so every issue is addressed. Keep what is already
working — this is a revision, not a fresh draft. Preserve the scene order and
cast.

Output strict Fountain syntax only, following the same formatting rules as the
original: scene headings (sluglines) in caps starting with INT. or EXT.,
action lines in plain sentence case, character cues in caps immediately
before their dialogue, parentheticals on their own line between a cue and its
dialogue when needed, and a blank line between every element.

No title page, no prose commentary, no markdown formatting, no code fences,
nothing before the first scene heading or after the last line of the last
scene. Output only the revised screenplay.`,
  },
  {
    key: "dev.script_breakdown",
    section: "Preproduction",
    label: "Generate script breakdown",
    description:
      "Breaks the approved story bible down into a coarse, scene-by-scene production breakdown.",
    variables: pick("storyBible", "direction", "groundingInstruction"),
    template: `You are an assistant director preparing a script breakdown from the story
bible below. A script breakdown is a physical-production document, not a
piece of writing to judge for style — its only job is to tell the production
what each scene needs to shoot.

Story bible:
{{storyBible}}
{{groundingInstruction}}
{{direction}}

For every scene the screenplay contains, output one entry in this exact
form, in scene order, with a blank line between entries:

SCENE <n> — INT./EXT. <LOCATION> — DAY/NIGHT
Cast: <characters present in this scene, comma-separated, or "none">
Key props: <the specific props this scene needs, comma-separated, or "none">
Notes: <one line on anything else physical production needs to know — a
stunt, an effect, a crowd, a vehicle, a special location requirement>

Use INT. or EXT. and DAY or NIGHT exactly as shown, derived from the
screenplay's own scene headings. Cover every scene the screenplay contains,
in order, and invent nothing the story bible does not support. No preamble,
no commentary before or after the list. Output only the scene entries.`,
  },
  {
    key: "dev.scene_breakdown",
    section: "Preproduction",
    label: "Generate scene breakdown",
    description:
      "Elaborates the approved script breakdown into a finer-grained, per-scene production document.",
    variables: pick("scriptBreakdown", "castSummary", "worldSummary", "direction", "groundingInstruction"),
    template: `You are an assistant director elaborating a script breakdown into a
finer-grained scene breakdown. The script breakdown named what each scene
needs at the scene level; this document goes one level deeper, to what a
specific take needs.

Script breakdown:
{{scriptBreakdown}}

Cast:
{{castSummary}}

World (locations and props):
{{worldSummary}}
{{groundingInstruction}}
{{direction}}

For every scene in the script breakdown, output one entry in this exact
form, in the same scene order, with a blank line between entries:

SCENE <n>
Props (specific instances and who carries/uses each): <list, or "none">
Blocking (entrances, exits, key positions/movement): <one or two lines>
Continuity (anything that must match the scene before or after it): <one
line, or "none">
Special requirements (stunts, effects, vehicles, crowd, animals, weather):
<one line, or "none">

Cover every scene number the script breakdown lists, in order, and invent
nothing the script breakdown, cast or world do not support. No preamble, no
commentary before or after the list. Output only the scene entries.`,
  },
  {
    key: "dev.continuity",
    section: "Preproduction",
    label: "Extract continuity facts",
    description:
      "Extracts continuity facts (a character's scar, where a prop was left, a location's " +
      "established geography) from the cast/world summaries and the scene breakdown, flagging " +
      "any that contradict a fact already on record from an earlier pass.",
    // Cast/world summaries, not the full story bible + both breakdowns: the
    // bible alone runs ~4k tokens, which blew finding F10's 4096-token cap in
    // real use (measured, not a paper risk). The summaries are the same
    // entity-focused data `scene_breakdown`'s own prompt already condenses
    // to, and `sceneBreakdown` alone (the finer of the two breakdowns)
    // already carries forward what `scriptBreakdown` established.
    variables: pick("castSummary", "worldSummary", "sceneBreakdown", "existingFacts", "direction"),
    template: `You are a continuity supervisor reviewing this project's cast, world and
scene breakdown for facts that later stages must not contradict: what a
character looks like or carries, where a prop was left, how a location's
geography works, and anything else a later scene could get wrong if it
forgot this one.

Cast:
{{castSummary}}

World:
{{worldSummary}}

Scene breakdown:
{{sceneBreakdown}}

Facts already on record from an earlier pass, if any:
{{existingFacts}}
{{direction}}

Extract every continuity fact worth tracking as a JSON object of this exact
shape:

{"facts": [{"subjectType": "character" | "location" | "prop", "subjectName":
"<the subject's name, exactly as it appears in the material above>",
"sceneId": "<the scene number this fact is anchored to, if it is specific to
one scene, otherwise null>", "fact": "<the continuity detail itself, one
plain sentence>", "conflict": true | false}]}

"subjectName" must name a character, location or prop that actually appears
in the material above — invent nothing. Set "conflict" to true only when
this fact directly contradicts either another fact you are extracting in
this same pass or one of the facts already on record above for the same
subject (a genuine contradiction — a different detail about the same
subject that cannot both be true — not merely a fact about a different
aspect of it). Leave "conflict" false otherwise; do not resolve a
contradiction yourself by picking one side or blending the two — flagging it
is your whole job here, not correcting it. Output only the JSON object, no
commentary before or after it.`,
  },
  {
    key: "dev.storyboards",
    section: "Preproduction",
    label: "Extract storyboard beats",
    description:
      "Splits the approved scene breakdown into one visually distinct beat per storyboard panel, " +
      "each with a shot-list-worthy visual description and suggested shotType/cameraAngle/" +
      "cameraMovement/lens.",
    // Cast/world summaries, not the story bible or script breakdown a second
    // time — same 4096-token-cap discipline (finding F10) `dev.continuity`
    // already applies, and the scene breakdown alone already carries forward
    // what those two established.
    variables: pick("sceneBreakdown", "castSummary", "worldSummary", "direction", "groundingInstruction"),
    template: `You are a storyboard artist breaking the scene breakdown below into
individual panels. A scene can need more than one panel if it contains more
than one visually distinct beat (an entrance, then a confrontation, then an
exit are three panels, not one) — read for where the image would actually
have to change, not just where a SCENE header falls.

Scene breakdown:
{{sceneBreakdown}}

Cast:
{{castSummary}}

World (locations and props):
{{worldSummary}}
{{groundingInstruction}}
{{direction}}

Output a JSON object of this exact shape:

{"beats": [{"sceneId": "<the scene number this beat belongs to, exactly as
it appears in the scene breakdown above, e.g. \\"1\\">", "description": "<what
this panel shows — the specific action, staging and any location/prop/
character visibly in frame, one or two sentences, concrete enough to
generate an image from>", "shotType": "wide" | "medium" | "close-up" |
"extreme-close-up", "cameraAngle": "eye-level" | "high" | "low" | "dutch",
"cameraMovement": "static" | "pan" | "tilt" | "dolly" | "handheld", "lens":
"wide" | "standard" | "telephoto"}]}

List beats in the same scene order the scene breakdown uses. Invent nothing
the scene breakdown, cast or world do not support — every location, prop or
character named in "description" must actually appear in the material
above. Choose shotType/cameraAngle/cameraMovement/lens for what best serves
the beat (a confrontation reads differently in a wide static shot than a
handheld close-up), not the same four values for every panel. Output only
the JSON object, no commentary before or after it.`,
  },
  {
    key: "dev.shot_list",
    section: "Preproduction",
    label: "Refine shot list item",
    description:
      "Splits one approved storyboard panel into the keyframe/motion two-register split M8's own " +
      "shots table needs, plus a duration estimate (M7 PR11, stage 18).",
    // Only this one panel's own prompt plus its shot descriptor — not the
    // scene breakdown or world/cast summaries a second time. This stage
    // refines a single already-approved panel's own content, one call per
    // panel, the same narrow-input discipline `dev.continuity` and
    // `dev.storyboards` already apply for the same reason (finding F10).
    variables: pick("storyboardPanelPrompt", "shotDescriptor", "direction"),
    template: `You are a cinematographer turning one approved storyboard panel into a
shot-list entry for a previs animatic.

Storyboard panel's own image prompt (included for reference only — ignore
any rendering/technical language already baked into it: film stock, grade,
lens or camera jargon. Read it only for what is staged in the frame, not how
it should be rendered):
{{storyboardPanelPrompt}}

Shot: {{shotDescriptor}}
{{direction}}

Split this into two different registers — collapsing them into one is a
known failure mode, so keep them genuinely distinct:
- "keyframePrompt": what a single still frame of this shot looks like — the
  staging, the subject, the lighting, what is physically in view. Content
  only, e.g. "Her face lit by a guttering lantern."
- "motionPrompt": what happens over the course of the shot — camera
  movement, subject movement, anything that changes between the first and
  last frame. Never restate the keyframe's own content; describe change,
  not composition, e.g. "Slow push in as the flame dies."

Also estimate "durationHintMs": a plausible shot length in milliseconds for
what this shot needs to do (typically 2000-6000; longer for a shot doing
more dramatic work, shorter for a quick insert).

Output only a JSON object of this exact shape: {"keyframePrompt": "...",
"motionPrompt": "...", "durationHintMs": <integer>}. No commentary before or
after it.`,
  },
  {
    key: "dev.production_design",
    section: "Preproduction",
    label: "Generate production design",
    description:
      "Turns the approved visual bible and the production design style's guidance into a production-" +
      "design document: what needs building vs. finding, key texture/material choices, and a lighting " +
      "approach per location type — the brief a production designer would hand an art department.",
    // The visual bible, not the raw locations/props/continuity facts a
    // second time — it is already Preproduction's own condensed capstone for
    // this register (see `runVisualBible`'s doc comment, dev.ts, for the
    // sizing reasoning against finding F10's cap).
    variables: pick(
      "visualBible",
      "visualLanguageGuidance",
      "paletteGuidance",
      "textureGuidance",
      "direction",
      "groundingInstruction",
    ),
    template: `You are a production designer preparing a brief for the art department, working from the visual bible below and this project's production design style.

Production design style:
Visual language: {{visualLanguageGuidance}}
Palette: {{paletteGuidance}}
Texture: {{textureGuidance}}

Visual bible:
{{visualBible}}
{{groundingInstruction}}
{{direction}}

Write a production-design document that translates the style's aesthetic
intent into concrete production decisions. For each location and prop the
visual bible names, cover:
- what needs to be built versus what can be found/sourced as-is
- key texture and material choices, consistent with the style's texture
  guidance
- a lighting approach appropriate to that location type, consistent with the
  style's palette guidance

Ground every decision in the visual bible's own content — invent no new
locations, props or continuity facts beyond what it names. Write flowing
prose organized by location/prop, not a rigid form. No preamble, no closing
commentary. Output only the production-design document.`,
  },
];
