import type { StyleProfile } from "../types";
import {
  PHRASE_BLOCKLIST,
  VOCAB_BLOCKLIST,
} from "../libraries/ai-tells";
import { COMPLIANCE_PHRASES } from "../libraries/compliance-phrases";
import { HEADERLESS_TAG_SET_ID, TAG_SETS } from "../libraries/tag-sets";
import type { FixApplied, Violation } from "./types";
import {
  countTextWords,
  forEachTextNode,
  htmlToPlainText,
  loadFragment,
  rootNode,
} from "../html-utils";

export interface Layer1Output {
  content: string;
  violations: Violation[];
  fixesApplied: FixApplied[];
  /** True when a violation is unrecoverable and the post should be regenerated. */
  terminal: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Visible text of a body. Parser-backed: entity decoding is the parser's job
 * (it handles every named and numeric reference, not the seven this used to
 * hand-roll) and a ">" inside an attribute value can no longer terminate a
 * "tag" early. Element boundaries still contribute a space, so the word count
 * is unchanged for well-formed HTML.
 */
function stripHtmlToPlainText(html: string): string {
  return htmlToPlainText(html);
}

function countWords(plainText: string): number {
  return countTextWords(plainText);
}

function paragraphsFromHtml(html: string): string[] {
  // Split on </p>, </li>, </h2/h3/h4>, and double-newlines.
  // We treat each top-level block as a paragraph for uniformity checking.
  const blocks = html
    .split(/<\/(?:p|li|h[1-6]|blockquote)>/i)
    .map((s) => stripHtmlToPlainText(s))
    .filter((s) => s.length > 0);
  return blocks;
}

// ── 1A: Vocabulary blocklist ───────────────────────────────────────────────

function checkVocab(plainText: string): Violation[] {
  const violations: Violation[] = [];
  for (const re of VOCAB_BLOCKLIST) {
    const matches = plainText.match(re);
    if (matches && matches.length > 0) {
      violations.push({
        kind: "vocab_violation",
        severity: "medium",
        layer: "1A",
        detail: `Vocabulary blocklist hit: "${matches[0]}"`,
        match: matches[0],
        matches: matches.slice(0, 5),
      });
    }
  }
  return violations;
}

// ── 1B: Phrase blocklist ───────────────────────────────────────────────────

function checkPhrases(plainText: string): Violation[] {
  const violations: Violation[] = [];
  for (const re of PHRASE_BLOCKLIST) {
    const matches = plainText.match(re);
    if (matches && matches.length > 0) {
      violations.push({
        kind: "phrase_violation",
        severity: "high",
        layer: "1B",
        detail: `Phrase blocklist hit: "${matches[0]}"`,
        match: matches[0],
        matches: matches.slice(0, 5),
      });
    }
  }
  return violations;
}

// ── 1C: Punctuation auto-fix ───────────────────────────────────────────────

function applyPunctuationFixes(
  content: string,
  hasEmDashFreeQuirk: boolean,
): { content: string; fixes: FixApplied[]; violations: Violation[] } {
  const fixes: FixApplied[] = [];
  const violations: Violation[] = [];

  // Cheap guard: no typographic character anywhere and no quirk check to run
  // → hand back the exact same string. A clean article never pays for a
  // parse/serialize round-trip.
  if (!/[—–‘’“”…]/.test(content) && !hasEmDashFreeQuirk) {
    return { content, fixes, violations };
  }

  const saw = {
    emDash: false,
    enDash: false,
    smartQuote: false,
    ellipsis: false,
  };

  /**
   * One text run in, one text run out. Two rules that the old whole-string
   * replace got wrong:
   *
   *  - the em dash CONSUMES its surrounding whitespace, because the dash is
   *    the separator. Replacing only the character left the spaces behind and
   *    stamped " ,  " into every published post; the en-dash rule below has
   *    always done this correctly.
   *  - the COMMA is the only punctuation this pass tints. French typography
   *    legitimately puts a space before ; : ! ? and this network publishes
   *    French (FRENCH_ONLY_NICHE_KEYS / MIXED_LANGUAGE_NICHE_KEYS), so
   *    widening the tidy-up would corrupt every French post we ship.
   */
  const rewrite = (before: string, isFirstInBlock: boolean): string => {
    let after = before;
    if (after.includes("—")) {
      after = after.replace(/\s*—\s*/g, ", ").replace(/,\s*,/g, ",");
      // An em dash that OPENED the block would leave a leading comma.
      if (isFirstInBlock && /^\s*—/.test(before)) {
        after = after.replace(/^,\s*/, "");
      }
      saw.emDash = true;
    }
    if (/\s–\s/.test(after)) {
      // SPACED en dash only. "1990–1995" is a range, not a pause.
      after = after.replace(/\s–\s/g, ", ");
      saw.enDash = true;
    }
    if (/[‘’]/.test(after)) {
      after = after.replace(/[‘’]/g, "'");
      saw.smartQuote = true;
    }
    if (/[“”]/.test(after)) {
      after = after.replace(/[“”]/g, '"');
      saw.smartQuote = true;
    }
    if (after.includes("…")) {
      after = after.replace(/…/g, "...");
      saw.ellipsis = true;
    }
    return after;
  };

  let fixed: string;
  if (content.includes("<")) {
    // A body: rewrite TEXT NODES only, so an attribute value, a <code> block
    // and the markup itself are all out of reach, then serialize once.
    const $ = loadFragment(content);
    let changed = false;
    forEachTextNode(rootNode($), (node, ctx) => {
      const before = node.data ?? "";
      const after = rewrite(before, ctx.isFirstInParent);
      if (after !== before) {
        node.data = after;
        changed = true;
      }
    });
    fixed = changed ? $.html() : content;
  } else {
    // Plain text — the title / meta description path, or a tag-free body.
    // There is no markup to protect, and a parser round-trip would escape "&"
    // as "&amp;" on the way out, which belongs in a body and not in a <title>.
    fixed = rewrite(content, true);
  }

  if (saw.emDash) fixes.push("em_dash_replaced");
  if (saw.enDash) fixes.push("en_dash_replaced");
  if (saw.smartQuote) fixes.push("smart_quotes_replaced");
  if (saw.ellipsis) fixes.push("ellipsis_replaced");

  // If the blog has the em-dash-free quirk, also flag hyphen-as-pause patterns
  // (no auto-fix — too ambiguous, must be rewritten). Runs on the VISIBLE
  // TEXT: the old version scanned raw HTML, so a hyphen inside an href or a
  // rel attribute could raise the violation.
  if (hasEmDashFreeQuirk) {
    const visible = content.includes("<") ? htmlToPlainText(fixed) : fixed;
    const hyphenPause = visible.match(/(\s)-\s/g);
    if (hyphenPause && hyphenPause.length > 0) {
      violations.push({
        kind: "vocab_violation",
        severity: "medium",
        layer: "1C",
        detail: "Hyphen used as pause — voice has em-dash-free quirk",
        matches: hyphenPause.slice(0, 5),
      });
    }
  }

  return { content: fixed, fixes, violations };
}

// ── 1D: Tag whitelist ──────────────────────────────────────────────────────

/** Removed along with everything inside them. */
const ALWAYS_STRIP = new Set(["img", "figure", "picture", "figcaption", "source"]);
/**
 * Removed but replaced by a SPACE. A <br> sits between two runs of prose;
 * deleting it outright welded them into one word — "line one<br>line two"
 * published as "line oneline two".
 */
const REPLACE_WITH_SPACE = new Set(["br"]);
/** Pure separators carrying no text of their own — safe to delete. */
const DROP_SEPARATOR = new Set(["hr"]);
const ALWAYS_UNWRAP = new Set(["div", "span", "section", "article", "header", "footer", "main", "aside", "nav"]);
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/**
 * Nearest heading level this tag set actually allows. Ties resolve DOWNWARD
 * (to the deeper, smaller heading) so an <h4> subsection can never be promoted
 * past the <h3> it sits under. Returns null when the set allows no headings at
 * all (tag sets 1 and 6).
 */
function nearestAllowedHeading(level: number, allowed: Set<string>): number | null {
  const levels = [1, 2, 3, 4, 5, 6].filter((n) => allowed.has(`h${n}`));
  if (levels.length === 0) return null;
  let best = levels[0];
  for (const cand of levels) {
    const d = Math.abs(cand - level);
    const bestD = Math.abs(best - level);
    if (d < bestD || (d === bestD && cand > best)) best = cand;
  }
  return best;
}

function applyTagWhitelist(
  content: string,
  profile: StyleProfile,
): { content: string; fixes: FixApplied[]; violations: Violation[]; terminal: boolean } {
  const allowed = new Set(TAG_SETS[profile.tagSetId].allowedTags);
  const fixes: FixApplied[] = [];
  const violations: Violation[] = [];

  const $ = loadFragment(content);

  // ── Strip media and separators ──
  let stripped = false;
  for (const tag of ALWAYS_STRIP) {
    const nodes = $(tag);
    if (nodes.length > 0) {
      nodes.remove();
      stripped = true;
    }
  }
  for (const tag of DROP_SEPARATOR) {
    const nodes = $(tag);
    if (nodes.length > 0) {
      nodes.remove();
      stripped = true;
    }
  }
  for (const tag of REPLACE_WITH_SPACE) {
    const nodes = $(tag);
    if (nodes.length > 0) {
      nodes.replaceWith(" ");
      stripped = true;
    }
  }
  if (stripped) fixes.push("tag_stripped");

  // ── Unwrap structural wrappers ──
  // Repeat until none remain. Unwrapping the outer <div> lifts an inner <div>
  // up a level; the old single non-greedy regex pass never came back for it,
  // and on crossed tags it silently reordered content.
  const unwrapSelector = [...ALWAYS_UNWRAP].join(", ");
  let restructured = false;
  for (let pass = 0; pass < 20; pass++) {
    const wrappers = $(unwrapSelector);
    if (wrappers.length === 0) break;
    wrappers.each((_, el) => {
      const $el = $(el);
      $el.replaceWith($el.contents());
    });
    restructured = true;
  }

  // Tag set 6 is special — no headings allowed. If any appear, terminal.
  if (profile.tagSetId === HEADERLESS_TAG_SET_ID) {
    for (const h of HEADING_TAGS) {
      if ($(h).length > 0) {
        violations.push({
          kind: "structural_mismatch_headerless",
          severity: "critical",
          layer: "1D",
          detail: `Tag set 6 (headerless) but <${h}> present — full regenerate required`,
          loc: `tag_${h}`,
        });
        if (restructured) fixes.push("tag_unwrapped");
        // Serialize the tree we have already worked on — scrubber/index.ts
        // keeps this content even on the terminal path, so returning the
        // un-serialized input would drop the strip/unwrap work.
        return { content: $.html(), fixes, violations, terminal: true };
      }
    }
  }

  // For non-headerless: remap disallowed headings to the NEAREST allowed
  // level, preserving attributes and relative depth. The old code took the
  // FIRST allowed level, which flattened h4/h5/h6 all the way to h2 and
  // inverted the document outline.
  $(HEADING_TAGS.join(", ")).each((_, el) => {
    const $el = $(el);
    const tag = String($el.prop("tagName") || "").toLowerCase();
    if (!tag || allowed.has(tag)) return;
    const level = Number(tag.slice(1));
    if (!Number.isFinite(level)) return;
    const target = nearestAllowedHeading(level, allowed);
    if (target === null) {
      // No heading level survives this tag set — keep the words as a bold
      // lead-in rather than dropping the section label entirely.
      const p = $("<p></p>");
      const strong = $("<strong></strong>");
      strong.append($el.contents());
      p.append(strong);
      $el.replaceWith(p);
    } else {
      const replacement = $(`<h${target}></h${target}>`);
      for (const [k, v] of Object.entries($el.attr() ?? {})) {
        replacement.attr(k, v);
      }
      replacement.append($el.contents());
      $el.replaceWith(replacement);
    }
    restructured = true;
  });
  if (restructured && !fixes.includes("tag_unwrapped")) fixes.push("tag_unwrapped");

  // Detect any remaining tag that is not on the whitelist. Nothing is exempt
  // any more: strip/unwrap now run on a real tree, so a <div> surviving to
  // this point is a genuine bug and must be reported, not waved through the
  // way the old ALWAYS_UNWRAP exemption did. This is also what gives the
  // 20-pass unwrap loop a safe failure mode — if it ever gave up, the leftover
  // raises a schema_violation instead of passing silently.
  const remainingTags = new Set<string>();
  $("*").each((_, el) => {
    const t = String($(el).prop("tagName") || "").toLowerCase();
    if (t) remainingTags.add(t);
  });
  for (const t of remainingTags) {
    if (!allowed.has(t)) {
      violations.push({
        kind: "schema_violation",
        severity: "high",
        layer: "1D",
        detail: `Tag <${t}> not in whitelist`,
        loc: `tag_${t}`,
      });
    }
  }

  return { content: $.html(), fixes, violations, terminal: false };
}

// ── 1F: Word count ─────────────────────────────────────────────────────────

function checkWordCount(plainText: string, profile: StyleProfile): Violation[] {
  const wc = countWords(plainText);
  const violations: Violation[] = [];

  if (wc < profile.wordBandMin) {
    violations.push({
      kind: "word_count_under",
      severity: "high",
      layer: "1F",
      detail: `Word count ${wc} is below minimum ${profile.wordBandMin}`,
      loc: `wc_${wc}`,
    });
  } else if (wc > profile.wordBandMax * 1.1) {
    violations.push({
      kind: "word_count_over",
      severity: "high",
      layer: "1F",
      detail: `Word count ${wc} exceeds maximum ${profile.wordBandMax} (>110%)`,
      loc: `wc_${wc}`,
    });
  } else if (wc > profile.wordBandMax) {
    // Within soft-trim zone
    violations.push({
      kind: "word_count_over",
      severity: "low",
      layer: "1F",
      detail: `Word count ${wc} slightly over ${profile.wordBandMax}`,
      loc: `wc_${wc}`,
    });
  }
  return violations;
}

// ── 1G: Compliance phrase ──────────────────────────────────────────────────

function checkCompliancePlacement(
  content: string,
  plainText: string,
  profile: StyleProfile,
): { violations: Violation[]; fixes: FixApplied[]; content: string } {
  const violations: Violation[] = [];
  const fixes: FixApplied[] = [];
  let nextContent = content;

  const assignedPhrases = profile.compliancePhraseIds
    .map((id) => COMPLIANCE_PHRASES[id]?.text)
    .filter((t): t is string => Boolean(t));

  if (assignedPhrases.length === 0) {
    return { violations, fixes, content: nextContent };
  }

  // Helper: does the haystack contain any assigned phrase verbatim?
  const containsAny = (haystack: string): string | null => {
    for (const phrase of assignedPhrases) {
      if (haystack.includes(phrase)) return phrase;
    }
    return null;
  };

  const placement = profile.compliancePlacement;

  if (placement === "ABOUT_ONLY") {
    // Phrase must NOT appear in body content. Drift = phrase present.
    if (containsAny(plainText)) {
      violations.push({
        kind: "compliance_drift",
        severity: "medium",
        layer: "1G",
        detail: "Compliance phrase appears in body but placement is ABOUT_ONLY",
      });
    }
    return { violations, fixes, content: nextContent };
  }

  const firstWindow = plainText.slice(0, 250);
  const lastWindow = plainText.slice(-250);
  const total = plainText.length;
  const middleSlice = plainText.slice(
    Math.floor(total * 0.2),
    Math.floor(total * 0.8),
  );

  const hasTop = containsAny(firstWindow);
  const hasBottom = containsAny(lastWindow);
  const hasMiddle = containsAny(middleSlice);
  const hasAnywhere = containsAny(plainText);

  // Drift check: phrase present that's not in the assigned set
  // Only triggers if the article references compliance-style language at all.
  // Simple heuristic: check for typical disclaimer phrases.
  const looksLikeCompliance = /\b(not\s+medical\s+advice|research\s+(only|purposes)|consult.*physician|not\s+intended\s+as\s+guidance)\b/i.test(
    plainText,
  );
  if (looksLikeCompliance && !hasAnywhere) {
    violations.push({
      kind: "compliance_drift",
      severity: "high",
      layer: "1G",
      detail:
        "Compliance-style language detected but none of the assigned phrases appear verbatim",
    });
  }

  // The simplest auto-fix: append an assigned phrase to bottom of HTML. We do
  // this only for TOP / BOTTOM / TOP_AND_BOTTOM since INLINE / ROTATING need
  // semantic integration.
  const phraseToInject = assignedPhrases[0];
  const wrapPhrase = `<p><em>${phraseToInject}</em></p>`;

  if (placement === "TOP" || placement === "TOP_AND_BOTTOM") {
    if (!hasTop) {
      violations.push({
        kind: "compliance_missing",
        severity: "low",
        layer: "1G",
        detail: `Compliance phrase missing at TOP — auto-inserted`,
      });
      nextContent = wrapPhrase + "\n" + nextContent;
      fixes.push("compliance_inserted_top");
    }
  }

  if (placement === "BOTTOM" || placement === "TOP_AND_BOTTOM") {
    if (!hasBottom) {
      violations.push({
        kind: "compliance_missing",
        severity: "low",
        layer: "1G",
        detail: `Compliance phrase missing at BOTTOM — auto-inserted`,
      });
      nextContent = nextContent + "\n" + wrapPhrase;
      fixes.push("compliance_inserted_bottom");
    }
  }

  if (placement === "INLINE") {
    if (!hasMiddle) {
      violations.push({
        kind: "compliance_missing",
        severity: "medium",
        layer: "1G",
        detail: "Compliance phrase missing INLINE — semantic rewrite needed",
      });
    }
  }

  if (placement === "ROTATING") {
    if (!hasTop && !hasMiddle && !hasBottom) {
      violations.push({
        kind: "compliance_missing",
        severity: "medium",
        layer: "1G",
        detail: "No assigned compliance phrase appears anywhere in the article",
      });
    }
  }

  return { violations, fixes, content: nextContent };
}

// ── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Run all of Layer 1 deterministically. Returns the auto-fixed content plus
 * the violations + fixes report. `terminal` means downstream layers should
 * be skipped and the post regenerated.
 *
 * Execution order:
 *   1C punctuation → 1D tag whitelist → 1A vocab → 1B phrases → 1F word count → 1G compliance
 *
 * Word count runs AFTER tag stripping so it measures actual prose, not
 * inflated by phantom-tag whitespace.
 */
export function runLayer1(
  content: string,
  profile: StyleProfile,
): Layer1Output {
  const violations: Violation[] = [];
  const fixes: FixApplied[] = [];
  let working = content;

  const hasEmDashFreeQuirk = profile.quirks.includes(3);

  // 1C — punctuation auto-fix
  {
    const r = applyPunctuationFixes(working, hasEmDashFreeQuirk);
    working = r.content;
    fixes.push(...r.fixes);
    violations.push(...r.violations);
  }

  // 1D — tag whitelist
  {
    const r = applyTagWhitelist(working, profile);
    working = r.content;
    fixes.push(...r.fixes);
    violations.push(...r.violations);
    if (r.terminal) {
      return { content: working, violations, fixesApplied: fixes, terminal: true };
    }
  }

  const plain = stripHtmlToPlainText(working);

  // 1A vocab
  violations.push(...checkVocab(plain));

  // 1B phrase
  violations.push(...checkPhrases(plain));

  // 1F word count
  violations.push(...checkWordCount(plain, profile));

  // 1G compliance
  {
    const r = checkCompliancePlacement(working, plain, profile);
    working = r.content;
    fixes.push(...r.fixes);
    violations.push(...r.violations);
  }

  return { content: working, violations, fixesApplied: fixes, terminal: false };
}

// Re-export helpers used by Layer 2
// ── Short-text Layer 1 (titles, meta, excerpt) ─────────────────────────────

export type ShortFieldKey =
  | "title"
  | "metaTitle"
  | "metaDescription"
  | "excerpt";

export interface ShortTextOutput {
  text: string;
  violations: Violation[];
  fixesApplied: FixApplied[];
}

/**
 * Layer 1 for the SHORT fields that ship alongside the body — the article
 * title, the SEO meta title/description, and the excerpt.
 *
 * Runs only the checks that are meaningful without a document around them:
 *
 *   1C  punctuation auto-fix (em dash, en dash, smart quotes, ellipsis)
 *   1A  vocabulary blocklist
 *   1B  phrase blocklist
 *
 * Deliberately NOT run here: 1D tag whitelist (short fields carry no markup
 * we control), 1F word count (bands describe articles), 1G compliance
 * placement (placement is defined relative to the body).
 *
 * Severities are left exactly as the body checks assign them so the profile's
 * strictness thresholds keep their calibration; the field name is recorded in
 * `loc` and prefixed onto `detail` so a report row is traceable to its field.
 */
export function runLayer1ShortText(
  raw: string,
  field: ShortFieldKey,
  profile: StyleProfile,
): ShortTextOutput {
  const hasEmDashFreeQuirk = profile.quirks.includes(3);

  // Punctuation is the high-value fix here: an em dash in a <title> is the
  // single most visible AI tell we ship, and it lands directly in the SERP.
  const punct = applyPunctuationFixes(raw, hasEmDashFreeQuirk);

  // Match against decoded plain text so an entity-escaped title still trips
  // the blocklists; the RETURNED string keeps its original entities.
  const plain = stripHtmlToPlainText(punct.content);

  const found: Violation[] = [
    ...punct.violations,
    ...checkVocab(plain),
    ...checkPhrases(plain),
  ];

  const violations = found.map((v) => ({
    ...v,
    detail: `[${field}] ${v.detail}`,
    loc: field,
  }));

  return { text: punct.content, violations, fixesApplied: punct.fixes };
}

export { paragraphsFromHtml, stripHtmlToPlainText, countWords };
