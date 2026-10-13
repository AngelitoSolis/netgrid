// Local keyword-targeted content — title templating + keyword filtering.
//
// Turns one of a blog's own scraped keywords (client_keywords, via
// topActiveClientKeywordsWithMeta) plus the blog's assigned city into a
// candidate post: a title, and a pass/fail decision on whether the keyword is
// even a sane candidate to pair with a city at all. See
// docs/local-keyword-content-plan.md §4.
//
// Dependency-free, mirroring location-targeting.ts — usable both server-side
// (target building) and for an admin UI preview of the matrix.

/** Which frame a keyword's title should take. See detectKeywordIntent. */
export type KeywordIntent = "transactional" | "comparison" | "informational";

/** Stable non-negative hash of a string (djb2). Deterministic — no RNG. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Title-case a raw keyword/city for display in a title. */
function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Title-cased display form of a stored term — exported for the S3 claimer,
 * which builds "[Service] in [Place]" headings from normalized terms. */
export function titleCasePhrase(s: string): string {
  return titleCase(s);
}

/** Trim/lowercase/collapse-whitespace a keyword for filtering and dedup. */
export function normalizeTargetKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Intent detection ──────────────────────────────────────────────────────

// A keyword may legitimately match more than one bucket ("best place to buy
// peptides" is both). Checked in this order — transactional and comparison
// are the two cases where an "informational" frame would be actively wrong,
// so they take priority; anything left over defaults to informational, the
// safest generic frame for a query with no clear signal.
const TRANSACTIONAL_SIGNALS = [
  "buy", "price", "pricing", "cost", "for sale", "near me", "order",
  "shop", "purchase", "cheap", "discount", "delivery", "deal", "deals",
];
const COMPARISON_SIGNALS = [
  "vs", "versus", "compare", "comparison", "alternative", "alternatives",
  "best", "top",
];

// ─── Word-boundary matching ────────────────────────────────────────────────
//
// Everything below matches WORDS, never substrings. The previous
// String.includes approach fired "order" on "sleep disorder", "cost" on
// "costume", "shop" on "workshop", "best" on "asbestos" and "top" on
// "laptop" — misclassifying an informational query as commercial, which now
// decides not just the title wording but whether a city is used at all.
//
// \b is avoided in favour of an explicit non-alphanumeric class so that
// multi-word phrases ("for sale", "near me") and digit-bearing terms
// ("bpc-157") behave the same way.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const boundaryCache = new Map<string, RegExp>();

function boundaryPattern(phrase: string): RegExp {
  let re = boundaryCache.get(phrase);
  if (!re) {
    re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?:[^a-z0-9]|$)`, "i");
    boundaryCache.set(phrase, re);
  }
  return re;
}

/** True when `phrase` occurs in `haystack` as a whole word (or whole phrase). */
export function containsWord(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return boundaryPattern(phrase).test(haystack);
}

/** Classify a keyword's search intent so the title frame actually fits it. */
export function detectKeywordIntent(keyword: string): KeywordIntent {
  const k = normalizeTargetKeyword(keyword);
  if (TRANSACTIONAL_SIGNALS.some((w) => containsWord(k, w))) return "transactional";
  if (COMPARISON_SIGNALS.some((w) => containsWord(k, w))) return "comparison";
  return "informational";
}

/**
 * Whether a target should be written as a CITY page.
 *
 * Two conditions, both required:
 *  - the keyword is transactional. "Where to buy X in Montreal" is a query
 *    people actually type; "X side effects in Montreal" is not — side effects
 *    are not geographically variable, so bolting a city onto an informational
 *    (or comparison) keyword invents demand that doesn't exist and produces a
 *    page that reads as machine-generated.
 *  - the client actually operates somewhere (clients.local_presence). A city
 *    on a blog says where the SITE is aimed; it does not say the BUSINESS is
 *    there. Off by default: a local page for a business with no local
 *    presence is exactly the doorway pattern this whole task exists to stop.
 *
 * A target that fails this is still built and still keyword-targeted — it just
 * gets a city-free title and no localTarget directive.
 */
export function shouldApplyLocalFraming(
  keyword: string,
  clientHasLocalPresence: boolean,
): boolean {
  return clientHasLocalPresence && detectKeywordIntent(keyword) === "transactional";
}

// ─── Title templates ────────────────────────────────────────────────────────
//
// {k} = keyword, {city} = the blog's assigned city. Deliberately niche-
// agnostic (no "dosage", no compound-specific wording) since a target can be
// a pizzeria as easily as a peptide site. Several templates per intent, one
// picked deterministically by hash(keyword|city) so titles vary across the
// network but stay stable across rebuilds.

const TRANSACTIONAL_TEMPLATES = [
  "Where to Buy {k} in {city}: Pricing & Availability",
  "{k} in {city} — Cost, Sourcing & What to Know",
  "Is {k} Available in {city}? A Practical Buyer's Guide",
  "{k} in {city}: Availability, Pricing & Delivery",
  "Best Places for {k} in {city}",
];

const COMPARISON_TEMPLATES = [
  "{k} in {city}: What to Compare Before You Choose",
  "{k} in {city} — Options, Pricing & What Sets Them Apart",
  "Comparing {k} in {city}: A Local Buyer's Guide",
];

const INFORMATIONAL_TEMPLATES = [
  "{k} in {city}: What Locals Should Know",
  "{k} in {city} — A Practical Guide",
  "Everything to Know About {k} in {city}",
  "{k} in {city}: What to Expect",
];

// City-free counterparts, used when shouldApplyLocalFraming says no. Same
// intent-aware framing, same deterministic rotation — just no {city} token,
// so the page promises only what the keyword actually asks for.
const NON_LOCAL_TRANSACTIONAL_TEMPLATES = [
  "{k}: Pricing, Sourcing & What to Check First",
  "{k} — A Practical Buyer's Guide",
  "How to Choose {k}: Cost, Quality & Delivery",
  "{k}: Availability, Pricing & What to Expect",
];
const NON_LOCAL_COMPARISON_TEMPLATES = [
  "{k}: What to Compare Before You Choose",
  "{k} — Options, Pricing & What Sets Them Apart",
  "Comparing {k}: A Practical Buyer's Guide",
];
const NON_LOCAL_INFORMATIONAL_TEMPLATES = [
  "{k}: What You Should Know",
  "{k} — A Practical Guide",
  "Everything to Know About {k}",
  "{k}: What to Expect",
];

function templatesFor(intent: KeywordIntent, localFraming: boolean): string[] {
  if (localFraming) {
    switch (intent) {
      case "transactional": return TRANSACTIONAL_TEMPLATES;
      case "comparison": return COMPARISON_TEMPLATES;
      case "informational": return INFORMATIONAL_TEMPLATES;
    }
  }
  switch (intent) {
    case "transactional": return NON_LOCAL_TRANSACTIONAL_TEMPLATES;
    case "comparison": return NON_LOCAL_COMPARISON_TEMPLATES;
    case "informational": return NON_LOCAL_INFORMATIONAL_TEMPLATES;
  }
}

export interface KeywordTitleOptions {
  /** Frame the title around the city. False => a city-free title. Default true. */
  localFraming?: boolean;
}

/**
 * The title for one (keyword, city) target. Intent-aware — a "buy" keyword
 * gets a transactional frame, an informational one doesn't get told to shop.
 */
export function buildKeywordTargetTitle(
  keyword: string,
  city: string,
  options: KeywordTitleOptions = {},
): string {
  const localFraming = options.localFraming !== false;
  const intent = detectKeywordIntent(keyword);
  const templates = templatesFor(intent, localFraming);
  const k = titleCase(coreTopic(normalizeTargetKeyword(keyword), intent));
  const c = titleCase(city);
  const template = templates[hash(`${keyword}|${city}`) % templates.length];
  return template.replace(/\{k\}/g, k).replace(/\{city\}/g, c);
}

// A scraped keyword is often already a full query — "where to buy peptides",
// "buy peptides" — not a bare product name the way a peptide compound is.
// "Where to Buy {k}" duplicates the word "buy" when {k} itself starts with
// "buy"/"where to buy" ("Where to Buy Buy Peptides..."). Strip ONLY that
// literal overlap, and nothing else: a qualifier like "cheap"/"online"/
// "for sale"/"price" doesn't repeat any template wording, so leaving it in
// keeps otherwise-similar keywords ("cheap peptides" vs "peptides online")
// producing DIFFERENT titles instead of collapsing them to the same string —
// over-stripping was tried and rejected for exactly that reason (verified
// against a sample of Autocomplete's near-duplicate "alphabet soup" variants,
// which routinely differ only by a trailing qualifier). The ORIGINAL keyword
// is still what's stored on the ledger row and fed to generation regardless —
// this only ever affects the displayed title.
const BUY_PREFIX_STRIP = [
  /^where\s+to\s+buy\s+/i,
  /^where\s+can\s+i\s+buy\s+/i,
  /^best\s+places?\s+to\s+buy\s+/i,
  /^buy\s+/i,
];

/** The bare topic a transactional keyword is about, for slotting into {k}. */
function coreTopic(keyword: string, intent: KeywordIntent): string {
  if (intent !== "transactional") return keyword;
  let k = keyword.trim();
  for (const re of BUY_PREFIX_STRIP) k = k.replace(re, "");
  k = k.trim();
  // Never let stripping produce an empty {k} — fall back to the original.
  return k.length > 0 ? k : keyword;
}

// ─── Filtering ──────────────────────────────────────────────────────────────

// Small and intentionally non-exhaustive — this is a coarse guard against the
// obviously-wrong candidates (a competitor marketplace, a raw domain), not a
// content-moderation list. Extend it if a bad target class shows up in
// practice.
const NAVIGATIONAL_STOPWORDS = [
  "amazon", "ebay", "walmart", "reddit", "youtube", "wikipedia",
  "craigslist", "facebook", "instagram", "tiktok", "pinterest",
];
const DOMAIN_LIKE = /\.[a-z]{2,4}\b/;

/** True when a keyword is navigational/brand-competitor noise, not a real target. */
export function isNavigationalKeyword(keyword: string): boolean {
  const k = normalizeTargetKeyword(keyword);
  return NAVIGATIONAL_STOPWORDS.some((w) => k.includes(w)) || DOMAIN_LIKE.test(k);
}

/**
 * True when a keyword already names one of the given cities — its own or any
 * other blog's. Pairing such a keyword with a city again would either repeat
 * it ("peptides montreal" on the Montreal blog -> "... in Montreal") or
 * contradict it ("peptides toronto" on the Montreal blog -> nonsensical).
 * `knownCities` MUST be scoped to the blog's own client (its own city plus its
 * sibling blogs' cities — see keyword-target-actions.clientCities). It used to
 * be every city in the network, which meant one client assigning a blog to
 * Mobile or Sale silently deleted unrelated keywords for every OTHER client.
 * There is still no external gazetteer here, by design (see
 * lib/content/brand.ts for why).
 *
 * Matching is by WORD, never substring, and ambiguous city names additionally
 * require a locative preposition before they count.
 */
// Cities whose names are also ordinary English words. Matching these as bare
// words destroys unrelated keywords — "Sale" would delete every "X for sale"
// keyword a client has, and "for sale" is itself a transactional signal, so
// that single collision removes the most commercially valuable class of
// target. For these, a match only counts when the keyword uses the word
// LOCATIVELY ("peptides in sale"), not incidentally ("peptides for sale").
const AMBIGUOUS_CITY_WORDS = new Set([
  "sale", "mobile", "nice", "reading", "bath", "hull", "bar", "hope",
  "orange", "york", "general", "independence", "industry", "commerce",
  "surprise", "normal", "boring", "sandwich", "union", "liberty",
  "enterprise", "rock", "why", "two",
]);

const LOCATIVE_PREFIXES = [
  "in", "near", "around", "from", "close to", "delivery to", "shipping to",
];

/** Lowercase, de-accent and reduce to spaced alphanumerics, for city matching. */
function normalizeForCityMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function keywordNamesAnyCity(
  keyword: string,
  knownCities: string[],
): boolean {
  const k = normalizeForCityMatch(keyword);
  if (!k) return false;
  return knownCities.some((raw) => {
    const c = normalizeForCityMatch(raw);
    // Two-letter "cities" are almost always noise; skip rather than shred.
    if (c.length < 3) return false;
    if (!containsWord(k, c)) return false;
    if (!AMBIGUOUS_CITY_WORDS.has(c)) return true;
    return LOCATIVE_PREFIXES.some((prefix) => containsWord(k, `${prefix} ${c}`));
  });
}

/** True when a keyword survives both filters and is a sane target candidate. */
export function isEligibleKeywordTarget(
  keyword: string,
  knownCities: string[],
): boolean {
  return !isNavigationalKeyword(keyword) && !keywordNamesAnyCity(keyword, knownCities);
}
