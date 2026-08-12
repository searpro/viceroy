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
  { name: "sentences", description: "The narration, one numbered sentence per line" },
  { name: "sentenceCount", description: "How many numbered sentences there are" },
  { name: "sceneText", description: "The narration span belonging to this scene" },
  { name: "sceneDescription", description: "One-line summary of what this scene shows" },
  { name: "characters", description: "The cast, as name + appearance lines" },
  { name: "visualGuidance", description: "The narrative style's art direction" },
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
  { name: "direction", description: "Free-text steer supplied by the user, may be empty" },
  { name: "checklist", description: "The narrative style's evaluation checklist, pre-formatted" },
  { name: "issues", description: "Issues the evaluator raised, pre-formatted" },
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
    variables: pick("idea", "narrativeStyle", "plannerGuidance", "targetSceneCount"),
    template: `You are a story developer working in the "{{narrativeStyle}}" style.

Style guidance:
{{plannerGuidance}}

Expand this idea into a synopsis for a short narrated video of about {{targetSceneCount}} scenes:

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
    key: "synopsis.refine",
    section: "Synopsis",
    label: "Refine synopsis",
    description: "Rewrites the current synopsis under a user's direction.",
    variables: pick("synopsis", "direction", "narrativeStyle", "plannerGuidance"),
    template: `You are revising a synopsis for a short narrated video in the
"{{narrativeStyle}}" style.

Style guidance:
{{plannerGuidance}}

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
    ),
    template: `You are writing the narration for a short video in the
"{{narrativeStyle}}" style.

Style guidance:
{{writingGuidance}}

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
    key: "story.evaluate",
    section: "Story",
    label: "Evaluate story",
    description: "Scores the story against the narrative style's own checklist.",
    variables: pick("story", "narrativeStyle", "checklist"),
    template: `You are a story editor judging a short video narration written in the
"{{narrativeStyle}}" style.

Judge it against this checklist and nothing else. A quality this checklist does
not mention is not a flaw here.

{{checklist}}

Narration:
{{story}}

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
    ),
    template: `You are revising the narration for a short video in the
"{{narrativeStyle}}" style.

Style guidance:
{{writingGuidance}}

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
    variables: pick("story", "visualGuidance"),
    template: `Identify the people who appear in this narration.

Narration:
{{story}}

Art direction for this story:
{{visualGuidance}}

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
    variables: pick("sceneText", "sceneDescription", "characters", "visualGuidance", "direction"),
    template: `Design a single still image for one scene of a narrated video.

What the narrator says over this scene:
{{sceneText}}

What the scene shows:
{{sceneDescription}}

Cast (use these appearance descriptions verbatim if the character appears):
{{characters}}

Art direction:
{{visualGuidance}}

Additional direction from the writer for this redo, if any:
{{direction}}

Respond with a single JSON object, no prose around it:

{
  "storyboard": "<what the viewer sees: subject, action, setting, camera framing>",
  "imagePrompt": "<the generation prompt: comma-separated visual phrases>",
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
    variables: pick("characterName", "characterDescription", "visualGuidance"),
    template: `{{characterDescription}}, {{visualGuidance}}, centred head-and-shoulders portrait,
neutral expression, facing camera, plain uncluttered background, evenly lit,
full face clearly visible and unobstructed, no text or watermark`,
  },
];
