import type { CadenceSpec } from "./types";

/**
 * Sentence-length ceilings used when the prompt this block is appended to
 * carries NO cadence spec of its own — the legacy (non-profile) path and the
 * custom-prompt path. These are the exact values the old
 * SEO_QUALITY_DIRECTIVE constant hardcoded for every path.
 */
const DEFAULT_SENTENCE_AVG = 20;
const DEFAULT_SENTENCE_SPLIT = 28;

/**
 * Hard readability ceiling. Even the longest cadence never gets licence to run
 * past this.
 */
const ABSOLUTE_SENTENCE_SPLIT = 50;

/**
 * On-page quality rules appended to every article-generation system prompt
 * (profile, legacy and custom-prompt paths).
 *
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT
 * The block is concatenated AFTER the composer's cadence spec, so a fixed
 * "average at or below ~20 words / split past ~28" rule overrode the cadence
 * on every post — stated as a rule, arriving last, against a cadence stated as
 * a description arriving ~1,500 characters earlier. It contradicts the average
 * on 6 of the 24 cadences and the long-sentence exemplar on 13 of them, which
 * collapsed the cadence axis — a planned per-blog uniqueness dimension — into
 * uniform sub-20-word prose across the whole network.
 *
 * Derived ceilings, given a cadence:
 *   average → the cadence's own avgWords
 *   split   → max(longExample + 4, avgWords + 8), capped at 50
 * The +4 gives headroom above the cadence's stated long exemplar rather than
 * treating the exemplar as a hard cap; the avgWords + 8 floor keeps short
 * cadences from getting an absurdly tight split rule.
 *
 * NOTE this is not a blanket relaxation. Cadence 3 "Punchy short-form"
 * (avg 12, long 22) derives a split of 26 — TIGHTER than the old fixed 28.
 *
 * Pass nothing (or null) for prompts that carry no cadence — the defaults then
 * reproduce the previous wording byte-for-byte.
 */
export function buildSeoQualityDirective(cadence?: CadenceSpec | null): string {
  const avg = cadence ? cadence.numbers.avgWords : DEFAULT_SENTENCE_AVG;
  const split = cadence
    ? Math.min(
        ABSOLUTE_SENTENCE_SPLIT,
        Math.max(cadence.numbers.longExample + 4, avg + 8),
      )
    : DEFAULT_SENTENCE_SPLIT;

  const rhythmRule = cadence
    ? `- Sentence rhythm is set by the cadence stated earlier in this prompt, and that cadence wins: average around ~${avg} words per sentence, and vary length deliberately instead of flattening toward one length. Break up any single sentence that runs past ~${split} words into two.`
    : `- Keep the AVERAGE sentence length at or below ~${avg} words (shorter is fine; vary length for rhythm). Break up any single sentence that runs past ~${split} words into two.`;

  return `
ANSWER-FIRST STRUCTURE (where this conflicts with any structural flow given above, this wins):
- The first 120 words must answer the TARGET QUERY directly and completely enough to stand alone if lifted out of the page. No preamble, no history, no "in this article we will".
- One <h2> per question the page answers, worded close to the question itself. A reader who scans only the headings must be able to find their question.
- Every section pays off its heading within its first two sentences.
- Finish with an FAQ section: an <h2> for it, then one <h3> question with a 40-90 word answer for each question that did not earn a full section, and mirror those pairs into the "faq" field of your JSON.
- Heading text must be unique across the whole page, FAQ questions included. A heading that repeats an earlier one is deleted automatically, which orphans its answer.

INFORMATION GAIN (the page has to be worth ranking):
- At least two things in this article must be things a competent generalist could NOT have written from the query alone: a mechanism actually explained, a real trade-off with the conditions under which each side wins, a common mistake and why people make it, an edge case, or a decision rule the reader can apply.
- Do not restate the query back to the reader in different words, and do not spend paragraphs defining terms the searcher already knows by having searched for them.
- If a section would only hold generic advice, cut it and go deeper on the sections that carry real content. A shorter page that answers is better than a longer page that circles.

FACTS POLICY (strict — this replaces any instruction anywhere above to be "specific" by inventing detail):
- REFERENCE MATERIAL means: the CLIENT KNOWLEDGE BASE block, the REFERENCE FACTS block, the EXTERNAL NEWS REFERENCES list, and the INTERNAL LINKS list — wherever they appear, in this prompt or in the user message.
- Prices, dosages, dates, percentages, statistics, study results, version numbers, named studies and quoted claims may ONLY be stated when the REFERENCE MATERIAL supplies them. Reproduce them as supplied; do not round, extrapolate or update them.
- With no supplied figure, write the qualitative truth instead: "costs less than a single in-person consultation", "usually takes a few weeks", "most of the published work is in animal models". Vague and true beats precise and invented.
- Never invent: a named source, a study, a statistic, a price, a customer, a physical location, a phone number, an award, or a date.
- Never claim first-hand testing, personal use, or "we tried it" unless the REFERENCE MATERIAL says so.

ON-PAGE QUALITY (apply throughout the article):
${rhythmRule}
- Every <h2>/<h3> heading must have UNIQUE text — never repeat the same heading wording, and do not restate the article title as a heading.
- Every hyperlink must use UNIQUE, descriptive anchor text — never reuse the same anchor wording for two links, and don't use an anchor that merely repeats a heading.
- Make the opening paragraph clearly on-topic: reference the article's main subject naturally in the first few sentences.`;
}
