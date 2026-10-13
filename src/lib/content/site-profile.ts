/**
 * Per-site facts the model is allowed to use, and nothing else.
 *
 * A profile is not a prompt costume. It is a list of sentences an operator
 * typed. The local-page gate below is the definition of "properly" from
 * docs/uniqueness-definition.md, reduced to something a test can fail:
 *
 *   - at least 3 signature facts (layer 1 — never shared, never invented)
 *   - at least 1 place note or neighborhood (layer 2)
 *   - a story, if attached, must already have passed the reuse cap
 *
 * A blog with no profile is not blocked. Callers only invoke the gate when
 * they are about to write a LOCAL page. City-free posts do not need it.
 */

export const MIN_SIGNATURE_FACTS = 3;
export const MAX_SIGNATURE_FACTS = 12;
export const MAX_FACT_CHARS = 280;

export interface SiteProfileInput {
  neighborhood?: string | null;
  signatureFacts?: string[] | null;
  doesNot?: string[] | null;
  placeNote?: string | null;
}

export interface ReadySiteProfile {
  neighborhood: string | null;
  signatureFacts: string[];
  doesNot: string[];
  placeNote: string | null;
}

export type ProfileGate =
  | { ok: true; profile: ReadySiteProfile }
  | { ok: false; reason: string };

function cleanLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Drop blanks, trim, cap length, dedupe case-insensitively. */
export function cleanFactList(raw: string[] | null | undefined, max = MAX_SIGNATURE_FACTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    const line = cleanLine(item).slice(0, MAX_FACT_CHARS);
    if (line.length < 8) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

export function parseFactText(text: string): string[] {
  return cleanFactList(text.split(/\r?\n/));
}

/**
 * Local pages require real facts. This does not invent a neighborhood from
 * the city string, and it does not treat a brand name as a fact.
 */
export function gateLocalProfile(input: SiteProfileInput | null | undefined): ProfileGate {
  if (!input) {
    return {
      ok: false,
      reason: "No site profile. A local page needs operator-entered facts; the city string is not enough.",
    };
  }
  const signatureFacts = cleanFactList(input.signatureFacts);
  const doesNot = cleanFactList(input.doesNot, 8);
  const neighborhood = cleanLine(input.neighborhood ?? "") || null;
  const placeNote = cleanLine(input.placeNote ?? "") || null;

  if (signatureFacts.length < MIN_SIGNATURE_FACTS) {
    return {
      ok: false,
      reason: `Site profile has ${signatureFacts.length} usable facts; a local page needs ${MIN_SIGNATURE_FACTS}. Empty fields are not filled in by the model.`,
    };
  }
  if (!neighborhood && !placeNote) {
    return {
      ok: false,
      reason: "Site profile has no neighborhood and no place note. A city name shared by hundreds of sites is not a place fact.",
    };
  }
  return { ok: true, profile: { neighborhood, signatureFacts, doesNot, placeNote } };
}

/**
 * The only local-context block the article prompt may receive.
 * Every sentence is an operator fact. The instruction forbids adding more.
 */
export function renderProfileDirective(profile: ReadySiteProfile): string {
  const facts = profile.signatureFacts.map((f) => `- ${f}`).join("\n");
  const refuses = profile.doesNot.length
    ? `\nThis business does NOT do the following. Do not imply that it does:\n${profile.doesNot.map((f) => `- ${f}`).join("\n")}`
    : "";
  const place = [
    profile.neighborhood ? `Neighborhood (operator-confirmed): ${profile.neighborhood}.` : "",
    profile.placeNote ? `Place note (operator-confirmed, cite it, do not extend it): ${profile.placeNote}` : "",
  ].filter(Boolean).join("\n");

  return `

SITE FACTS (operator-entered — these are the only local facts you may state):
${facts}
${place}${refuses}

Do not add a street, a landmark, a review, a "locals say", or a weekly event that is not in the list above. If a detail is missing, omit it. Do not write around the gap.`;
}
