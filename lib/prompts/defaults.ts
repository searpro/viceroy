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
- vertical 9:16 composition, subject placed for a tall frame

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
    variables: pick("characterDescription"),
    template: `{{characterDescription}}, centred head-and-shoulders portrait,
neutral expression, facing camera, plain uncluttered background, evenly lit,
full face clearly visible and unobstructed`,
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
];
