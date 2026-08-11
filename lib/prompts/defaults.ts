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
];
