/**
 * lib/content/persona-generator.ts
 *
 * LLM-generated per-blog PERSONA (Phase 3). Instead of picking a voice from the
 * fixed 127-entry library, generate a unique voice for a blog from its niche +
 * client + optional operator seed direction. A diversity instruction keeps each
 * generated persona distinct from the others already in the same niche (the
 * anti-footprint goal, minus the rigid library math).
 *
 * The result is stored on the blog's style_profiles row; composeForPost prefers
 * it over the library voice for the {voice.*} prompt slots when present.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GeneratedPersona } from "@/lib/content/types";

export type { GeneratedPersona };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.PERSONA_MODEL || "claude-sonnet-4-6";

/**
 * Words that assert a regulated, licensed or academically-credentialed
 * identity. A generated persona containing any of these is REJECTED rather
 * than stored.
 *
 * Why: the persona string is interpolated verbatim into the system prompt as
 * "You are {voice.persona}." (libraries/skeletons.ts), and it OVERRIDES the
 * library voice permanently once written to style_profiles.generated_persona
 * (composer/compose.ts). A model-invented credential on a health, legal or
 * financial blog is a fabricated-expertise claim on a YMYL page, not a
 * stylistic flourish. Real credentials belong on a real author entity sourced
 * from a document on file — never in a prompt string. See SOP T12.
 *
 * Deliberately blunt: "researcher", "engineer" and "certified" are ordinary
 * words and this WILL produce false positives. That is the correct trade. A
 * false positive costs one extra model round-trip and at worst falls back to
 * the library voice; a false negative writes a fabricated licence into the
 * database permanently. Do not soften it to reduce retries.
 */
const CREDENTIAL_CLAIM_RE =
  /\b(?:physician|surgeon|clinician|doctor|dr\.|nurse|midwife|paramedic|pharmacist|pharmacologist|dietitian|dietician|nutritionist|therapist|physiotherapist|psychologist|psychiatrist|veterinarian|dentist|attorney|lawyer|solicitor|barrister|paralegal|accountant|actuary|architect|professor|lecturer|researcher|scientist|md|phd|pharmd|dds|dvm|rn|np|pa-c|cpa|cfa|cfp|mba|msc|bsc|licensed|licenced|board-certified|board certified|certified|accredited|chartered|registered|credentialed|residency|fellowship|practising|practicing|trained in|degree in|graduate degree|doctorate)\b/i;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in response");
  return text.slice(start, end + 1);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** First credential word found across every field we persist, or null. */
export function credentialClaimIn(p: GeneratedPersona): string | null {
  const fields = [
    p.persona,
    p.registerSignature,
    p.examplePara1,
    p.examplePara2,
    p.toneNotes ?? "",
    p.label ?? "",
  ];
  for (const f of fields) {
    const m = CREDENTIAL_CLAIM_RE.exec(f);
    if (m) return m[0];
  }
  return null;
}

export interface GeneratePersonaInput {
  /** Human-readable niche/industry label (e.g. "Roofing", "Peptides"). */
  nicheLabel: string;
  clientName?: string;
  /** Optional operator direction, e.g. "sound like a 15-year pitmaster". */
  seedInputs?: string;
  /** Persona descriptions already in use for this niche — to stay distinct. */
  existingPersonas?: string[];
}

const SYSTEM_BASE = `You invent a distinct WRITING PERSONA for a blog in a given niche — the specific voice every article on that blog is written in. The persona should feel like a real, opinionated individual with a temperament and a point of view, not a generic "expert." It writes naturally, avoids AI-tell phrasing, and stays readable for the niche.

HARD RULE — NO CREDENTIALS, NO PROFESSIONAL IDENTITY. The persona must NOT claim, imply, or hint at any qualification, licence, degree, certification, job title in a regulated profession, or institutional affiliation. Specifically forbidden: doctor, physician, clinician, nurse, pharmacist, dietitian, therapist, psychologist, veterinarian, dentist, lawyer, attorney, accountant, professor, researcher, scientist, engineer, and any abbreviation of these (MD, PhD, PharmD, RN, CPA, ...). Also forbidden: "trained in", "licensed", "certified", "board-certified", "degree in", "years of practice", "worked at [named institution]".

Build character from things that are true of any careful writer instead: what they read, what they notice, what irritates them, how they argue, what they refuse to say, the order they think in, their sense of humour. "Reads the methods section before the abstract and says so" is a persona. "Board-certified endocrinologist" is a liability.

Return ONLY valid JSON with exactly these keys:
- "label": 2-4 word handle for this voice (e.g. "Wry contrarian", "Methods-first skeptic").
- "persona": 1-2 sentences describing who is writing — temperament, reading habits, angle of attack. No credentials.
- "registerSignature": one sentence naming this voice's concrete tics — sentence rhythm, humor, what they emphasize, pet peeves.
- "examplePara1": a 2-4 sentence paragraph written IN this voice about the niche (show, don't tell).
- "examplePara2": a second, differently-angled 2-4 sentence paragraph in the same voice.
- "toneNotes": optional one sentence of extra tone guidance, or "".

No markdown, no preamble — JSON only.`;

const RETRY_SUFFIX = `

Your previous attempt was REJECTED because it contained a professional credential or qualification claim. Try again with no professional identity of any kind — build the character purely from temperament, reading habits and argumentative style.`;

/** One model round-trip; returns the parsed persona or null. */
async function attempt(
  system: string,
  user: string,
): Promise<GeneratedPersona | null> {
  let rawText: string;
  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 1,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = message.content.find((b) => b.type === "text");
    rawText = block?.type === "text" ? block.text : "";
  } catch (err) {
    console.error(
      "[persona] generation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(rawText)) as Record<string, unknown>;
  } catch (err) {
    console.error(
      "[persona] invalid JSON:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const persona = str(parsed.persona);
  const registerSignature = str(parsed.registerSignature);
  const examplePara1 = str(parsed.examplePara1);
  const examplePara2 = str(parsed.examplePara2);

  // A persona is only useful with a description + at least one example.
  if (!persona || !examplePara1) return null;

  return {
    persona,
    registerSignature: registerSignature || persona,
    examplePara1,
    examplePara2: examplePara2 || examplePara1,
    toneNotes: str(parsed.toneNotes) || undefined,
    label: str(parsed.label) || undefined,
  };
}

/**
 * Generate a distinct writing persona for a blog. Returns null on any failure
 * (caller keeps the library voice). Diversity is instruction-based: the model
 * is shown the personas already in the niche and told to differ clearly.
 *
 * A persona asserting a professional credential is rejected and retried once;
 * a second offence returns null so the blog keeps its (now credential-free)
 * library voice rather than persisting a fabricated qualification.
 */
export async function generateBlogPersona(
  input: GeneratePersonaInput,
): Promise<GeneratedPersona | null> {
  const existing = (input.existingPersonas ?? []).filter(Boolean).slice(0, 20);

  const distinctBlock = existing.length
    ? `\n\nPERSONAS ALREADY USED by other blogs in this niche — your persona MUST be clearly different from ALL of these (different background, temperament, and phrasing; do not reuse their framing):\n${existing
        .map((p, i) => `${i + 1}. ${p}`)
        .join("\n")}`
    : "";

  const seedBlock = input.seedInputs?.trim()
    ? `\n\nOPERATOR DIRECTION (honor this, but the no-credentials rule overrides it): ${input.seedInputs.trim()}`
    : "";

  const user = `Niche: ${input.nicheLabel}${
    input.clientName ? `\nClient: ${input.clientName}` : ""
  }${seedBlock}${distinctBlock}

Invent the persona now.`;

  for (let round = 0; round < 2; round++) {
    const system = round === 0 ? SYSTEM_BASE : SYSTEM_BASE + RETRY_SUFFIX;
    const persona = await attempt(system, user);
    if (!persona) return null;

    const claim = credentialClaimIn(persona);
    if (!claim) return persona;

    console.warn(
      `[persona] rejected (round ${round + 1}) — credential claim "${claim}" in: ${persona.persona.slice(0, 160)}`,
    );
  }

  console.error(
    "[persona] rejected twice for credential claims — keeping the library voice",
  );
  return null;
}
