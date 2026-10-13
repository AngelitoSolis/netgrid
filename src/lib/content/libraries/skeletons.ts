import type { Skeleton, SkeletonId, ArchetypeId, CadenceId, SchemaId, SubNicheId } from "../types";

/**
 * 12 skeleton prompts. Each is a template with {placeholders} and [BLOCK_*]
 * markers that the composer substitutes at render time.
 *
 * The composer:
 *   1. Picks a skeleton based on the blog's locked skeletonId
 *   2. Picks one template per post from the blog's structural pool
 *   3. Renders all placeholders against the blog's StyleProfile + topic
 *   4. Inlines BLOCK_* contents from the shared blocks library
 *   5. Sends the resulting system prompt to Claude
 *
 * Affinity drives the assignment algorithm's Phase 3 — picks a skeleton
 * whose archetypes / cadences / sub-niches / schemas align with the voice
 * already drawn in Phase 2.
 */

export const SKELETONS: Record<SkeletonId, Skeleton> = {
  1: {
    id: 1,
    name: "Bulleted Constraint Spec",
    distinctiveFeature:
      "Treats the prompt as an engineering specification. Tight, listy, 'must' and 'do not' language.",
    body: `TASK: Write an article on the topic below.

TOPIC: {topic}
SUB-NICHE: {sub_niche}
PRIMARY COMPOUNDS (focus on these): {primary_compounds}
SECONDARY COMPOUNDS (mention if relevant): {secondary_compounds}

WRITER PROFILE:
- Persona: {voice.persona}
- Register: {voice.register_signature}

STYLE CONSTRAINTS:
- Cadence: {cadence.spec}
- Apply these stylistic tics throughout: {quirks_rendered}
- {citation.style_description}

STRUCTURAL FLOW (follow this shape):
{template.flow}

WORD COUNT:
- Minimum: {word_band_min}
- Maximum: {word_band_max}
- Target: ~{word_band_target}

[BLOCK_AI_TELLS]

[BLOCK_COMPLIANCE]

[BLOCK_CITATIONS]

[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "CITATIONS", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [5, 6, 11] as ArchetypeId[],
      avoidArchetypes: [2, 3] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  2: {
    id: 2,
    name: "Persona-First Roleplay",
    distinctiveFeature:
      "Opens with deep persona narrative, then weaves constraints into the persona's perspective.",
    body: `You are {voice.persona}.

You write the way someone with this background actually writes: {voice.register_signature}.

Your sentences average {cadence.numbers.avgWords} words. You have these specific habits in
your prose: {quirks_rendered}. When you reference research, you do it like this:
{citation.example}.

Today you're writing about {topic}. You'll be focusing on {primary_compounds},
with {secondary_compounds} mentioned where contextually relevant. Your
audience is people interested in {sub_niche}.

Here's how you'd structure this piece: {template.flow}

Write between {word_band_min} and {word_band_max} words. Don't pad. Trim
ruthlessly if you're going long.

[BLOCK_AI_TELLS]

[BLOCK_COMPLIANCE]

[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [1, 7, 8, 9, 10] as ArchetypeId[],
      avoidArchetypes: [12] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  3: {
    id: 3,
    name: "Plan-Then-Write",
    distinctiveFeature:
      "Forces an internal outline before writing. Produces more structurally consistent output. Most reliable for long-form.",
    body: `You'll write an article about {topic}.

Voice: {voice.persona}. Register: {voice.register_signature}.
Cadence: {cadence.spec}.
Stylistic habits: {quirks_rendered}.

STEP 1: Internally plan the article. Don't output the plan. Just consider:
- What's the strongest opening that fits this voice?
- What are the 3-5 sections?
- Where do citations land?
- What's the closing?

STEP 2: Write the article. Length: {word_band_min}–{word_band_max} words.

Structural flow guide: {template.flow}
Compounds to focus on: {primary_compounds}
Secondary compounds (mention if relevant): {secondary_compounds}
Citation style: {citation.style_description}, like this: {citation.example}

[BLOCK_AI_TELLS]

[BLOCK_COMPLIANCE]

[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [1, 4, 7, 10] as ArchetypeId[],
      avoidArchetypes: [2, 3] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },

  4: {
    id: 4,
    name: "Minimalist Single-Shot",
    distinctiveFeature:
      "Very short skeleton. Trusts voice + cadence specs to carry the work.",
    body: `{voice.persona}

Write {word_band_min}–{word_band_max} words on {topic} for the {sub_niche}
sub-niche. Focus on {primary_compounds}; {secondary_compounds} if relevant.

Your prose runs at {cadence.spec}. You {quirks_rendered}. Citations in this style:
{citation.example}.

[BLOCK_AI_TELLS]

[BLOCK_COMPLIANCE_BRIEF]

[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE_BRIEF", "OUTPUT_FORMAT"],
    affinity: {
      voiceIds: [13, 20, 21, 22],
      avoidArchetypes: [11] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  5: {
    id: 5,
    name: "Negative-Instruction-Heavy",
    distinctiveFeature:
      "Front-loads prohibitions. The 'what not to do' comes before the 'what to do'.",
    body: `You're writing an article. Before I tell you what to write, here's what
this article must NOT contain.

[BLOCK_AI_TELLS]

Beyond AI tells, do not:
- Use perfect 3-4 sentence paragraphs throughout
- Apply parallel structure to every list
- Open with "In today's..." or any time-anchored cliché
- Close with "In conclusion" or a recap of the article
- Make implied medical-use or therapeutic claims
- Cite studies you cannot verify exist

Now: write the article.

Voice: {voice.persona}, with {voice.register_signature}.
Cadence: {cadence.spec}.
Habits: {quirks_rendered}.
Topic: {topic}.
Compounds (primary): {primary_compounds}.
Compounds (secondary): {secondary_compounds}.
Sub-niche: {sub_niche}.
Structural flow: {template.flow}.
Length: {word_band_min}-{word_band_max} words.
Citation style: {citation.style_description}, like {citation.example}.

[BLOCK_COMPLIANCE]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      strictness: ["strict"],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },

  6: {
    id: 6,
    name: "Constraint-Stack With Examples",
    distinctiveFeature:
      "Includes 1-2 short style examples (a paragraph in the voice) inside the prompt.",
    body: `You're {voice.persona}. Here's an example of how you write:

---
{voice.example_paragraph_1}
---
{voice.example_paragraph_2}
---

Match that register, that vocabulary, that rhythm.

Today you're writing about {topic}. Length: {word_band_min}-{word_band_max} words.
Focus: {primary_compounds}. Sub-niche context: {sub_niche}.
Your habits this article: {quirks_rendered}.
Structural flow: {template.flow}.
Citations like: {citation.example}.

[BLOCK_AI_TELLS]
[BLOCK_COMPLIANCE]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      voiceIds: [13, 20, 21, 32, 47],
    },
    requiresVoiceExamples: true,
    tokenCostTier: "high",
  },

  7: {
    id: 7,
    name: "Editorial-Brief Format",
    distinctiveFeature:
      "Frames the prompt as a magazine assignment briefing.",
    body: `ASSIGNMENT BRIEF

Writer: {voice.persona}
Section: {sub_niche}
Word count: {word_band_min}-{word_band_max}

Topic for this piece: {topic}
Compounds to anchor on: {primary_compounds}
Mention if relevant: {secondary_compounds}

Angle the editor is asking for: {template.flow}

The writer's house style:
- Register: {voice.register_signature}
- Cadence: {cadence.spec}
- Habits: {quirks_rendered}
- Citations: {citation.style_description}, e.g. {citation.example}

House rules from the editor:
- Compliance line: include one of {compliance.phrases_rendered} at {compliance.placement}
- No AI-cliché vocabulary (see attached blocklist)
- No medical-use claims; research/observer frame only

[BLOCK_AI_TELLS]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [1, 12] as ArchetypeId[],
      schemaIds: [2] as SchemaId[],
      avoidArchetypes: [2] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  8: {
    id: 8,
    name: "Question-Driven",
    distinctiveFeature:
      "Frames the article as the answer to a specific research question.",
    body: `This article will answer one question: {question_about_topic}

(Topic: {topic}. Sub-niche: {sub_niche}. Primary compounds: {primary_compounds}.)

Approach the question as: {voice.persona}, with {voice.register_signature}.
Don't bury the answer; structure the article around progressively building
the answer. Use {citation.style_description} for sources, like {citation.example}.

Habits in your prose: {quirks_rendered}. Cadence: {cadence.spec}.
Length: {word_band_min}-{word_band_max} words.
Structural shape: {template.flow}.

[BLOCK_AI_TELLS]
[BLOCK_COMPLIANCE]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [1, 4] as ArchetypeId[],
      avoidArchetypes: [3, 12] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  9: {
    id: 9,
    name: "Outline-Given",
    distinctiveFeature:
      "Provides the structural template's flow as an explicit outline with section headings pre-specified.",
    body: `Write the following article. Voice: {voice.persona}, with cadence
{cadence.spec}. Apply: {quirks_rendered}. Citations: {citation.style_description},
e.g. {citation.example}. Length: {word_band_min}-{word_band_max} words.

OUTLINE TO FOLLOW:

{template.flow_as_outline}

Topic: {topic}
Compounds: primary {primary_compounds}; secondary {secondary_compounds}

[BLOCK_AI_TELLS]
[BLOCK_COMPLIANCE]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {}, // all
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },

  10: {
    id: 10,
    name: "Voice-and-Rhythm-Emphasis",
    distinctiveFeature:
      "Front-loads cadence with concrete numerical targets and rhythm examples.",
    body: `The most important thing about this article is its rhythm.

Sentences average {cadence.numbers.avgWords} words.
Standard deviation around {cadence.numbers.stdDev} — meaning some sentences
should be {cadence.numbers.shortExample} words, others
{cadence.numbers.longExample}.
Paragraphs run {cadence.numbers.avgParagraph} sentences on average.
Voice direction: {cadence.voiceDirection}.
Transition density: {cadence.transitionDensity}.

The writer is {voice.persona}. They have these habits: {quirks_rendered}.

Now write about {topic}, focusing on {primary_compounds}, mentioning
{secondary_compounds} if relevant. Length: {word_band_min}-{word_band_max} words.
Structural flow: {template.flow}. Citations: {citation.style_description}.

[BLOCK_AI_TELLS]
[BLOCK_COMPLIANCE]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "COMPLIANCE", "OUTPUT_FORMAT"],
    affinity: {
      cadenceIds: [7, 11, 13] as CadenceId[],
      avoidCadenceIds: [4, 10] as CadenceId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },

  11: {
    id: 11,
    name: "Compliance-First",
    distinctiveFeature:
      "Front-loads compliance framing. Explicitly limits scope to research framing in the opening lines.",
    body: `You will write a research-frame article about peptides. The article must
remain in research-information frame at all times. It will not:
- Recommend personal use
- Suggest dosages for human consumption
- Compare peptides to approved medications as if interchangeable
- Make therapeutic claims, implied or direct

The article WILL:
- Discuss what the research shows about peptides as research compounds
- Reference published studies and their findings
- Acknowledge limitations and unknowns
- Include compliance language: one of {compliance.phrases_rendered} at {compliance.placement}

Voice for the article: {voice.persona}, register {voice.register_signature}.
Cadence: {cadence.spec}. Habits: {quirks_rendered}.
Topic: {topic}. Compounds: {primary_compounds} (primary), {secondary_compounds} (secondary).
Sub-niche: {sub_niche}. Length: {word_band_min}-{word_band_max} words.
Structural flow: {template.flow}. Citations: {citation.style_description}, e.g. {citation.example}.

[BLOCK_AI_TELLS]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [11] as ArchetypeId[],
      subNiches: [4, 10] as SubNicheId[],
      avoidArchetypes: [2] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },

  12: {
    id: 12,
    name: "Conversational Task Brief",
    distinctiveFeature:
      "Most informal skeleton. Reads as if briefing a friend who happens to write.",
    body: `Hey, need an article from you on {topic}. Sub-niche is {sub_niche}, mainly
focused on {primary_compounds}, can mention {secondary_compounds} if
they fit naturally.

Aim for somewhere between {word_band_min} and {word_band_max} words. You write
like {voice.persona} — keep that voice. Your usual cadence ({cadence.spec})
and habits ({quirks_rendered}) — do those.

Structural shape: {template.flow}. Cite stuff using {citation.style_description}.

Keep it research-frame (not personal-use). And you know the AI-tell list
already — none of that.

Also: include one of {compliance.phrases_rendered} at {compliance.placement}.

[BLOCK_AI_TELLS]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "OUTPUT_FORMAT"],
    affinity: {
      archetypes: [2, 3, 12] as ArchetypeId[],
      cadenceIds: [3, 7, 8] as CadenceId[],
      avoidArchetypes: [6, 11] as ArchetypeId[],
    },
    requiresVoiceExamples: false,
    tokenCostTier: "low",
  },

  // S3 — Local Service Page. FORCED by the shared location claimer for
  // location_page_targets rows; deliberately NOT in SKELETON_IDS so random
  // assignment never draws it for an evergreen post (its structure only makes
  // sense with a real service × place target). The concrete values arrive via
  // the localTargetingDirective (keyword/city/profileDirective/pageStructure);
  // this body fixes the ANATOMY, using only known placeholder tokens.
  13: {
    id: 13,
    name: "Local Service Page",
    distinctiveFeature:
      "Service × place page with a fixed anatomy: [Service] in [Place] heading, who-we-are from operator facts only, the real service list, local proof points, closing FAQ block.",
    body: `Write "{topic}" — a local service page. You write like {voice.persona};
keep that voice and your usual cadence ({cadence.spec}).

This is a LOCATION page, not an evergreen article. Follow this anatomy in
order, whatever template was drawn — the structure below wins over any
template flow:

1. Open with the service + place heading exactly as given in the local target
   directive (H1 = [Service] in [Place]). No clickbait rewording of it.
2. Who we are — 60–90 words built ONLY from the operator facts in the local
   target directive. Every sentence must trace to a fact there; if a fact is
   missing, omit the sentence rather than invent one.
3. What we do here — the service list exactly as provided by the directive and
   knowledge summaries. No invented services, prices, guarantees or response
   times.
4. Local proof points — only facts present in the directive or knowledge
   summaries (real areas served, real specifics). If none exist, skip this
   section entirely; an empty claim is worse than no section.
5. Close with a short FAQ block: 3–5 questions local searchers actually ask
   about this service in this place, answered factually and briefly.

Aim for {word_band_min}–{word_band_max} words. Cite using the provided style
only when sources are actually available — never pad with invented citations.

[BLOCK_AI_TELLS]
[BLOCK_OUTPUT_FORMAT]`,
    sharedBlocks: ["AI_TELLS", "OUTPUT_FORMAT"],
    affinity: {
      // Location pages run on whatever voice the blog already locked; no
      // archetype/cadence restriction is enforced at claim time (the claimer
      // forces this skeleton, it does not re-roll the profile).
    },
    requiresVoiceExamples: false,
    tokenCostTier: "medium",
  },
};

// #13 is intentionally absent — see its entry above. It exists for the shared
// location claimer to force, not for random assignment to draw.
export const SKELETON_IDS: SkeletonId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function skeletonById(id: SkeletonId): Skeleton {
  return SKELETONS[id];
}
