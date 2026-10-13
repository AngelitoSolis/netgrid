/**
 * lib/services/quality/score.ts
 *
 * The composite post quality score. ONE engine — this replaces the three
 * mutually inconsistent ones described in the T19 SOP §1.3.
 *
 * Design rules, in priority order:
 *
 *   1. A number is only produced from measurements. Where a measurement is
 *      missing, the component is DROPPED and the remaining weights are
 *      renormalised; below MIN_COVERAGE the whole score is null. Null renders
 *      as "n/a". Nothing in this file may invent a default value.
 *   2. "Unknown" and "bad" are different. An unindexed page scores 0. A page
 *      whose indexation we have not checked scores null.
 *   3. Every number is explainable. computeQualityScore returns the per-
 *      component weights, sub-scores and skip reasons alongside the total, and
 *      the caller persists that blob next to the score.
 *
 * Pure: no DB, no network, no Date.now(). Everything time-dependent is passed
 * in so the tests can be deterministic.
 */

import { PENALTY } from "@/lib/seo/scanner";

// ─── Weights ────────────────────────────────────────────────────────────────
// Rationale for each of these is in the T19 SOP §5, Step 6. Sum = 100.
export const QUALITY_WEIGHTS = {
  /** Real Search Console outcome. The only non-proxy signal we have. */
  search: 35,
  /** Cross-post near-duplication — a ranking CAUSE, not just a symptom. */
  duplication: 25,
  /** Core Web Vitals against Google's published thresholds. */
  vitals: 25,
  /** On-page tag hygiene. Deliberately small — this used to be 100%. */
  hygiene: 15,
} as const;

export type QualityComponentKey = keyof typeof QUALITY_WEIGHTS;

const TOTAL_WEIGHT = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);

/**
 * Minimum fraction of total weight that must have real data before we are
 * willing to publish a number at all.
 *
 * 0.4 is chosen so that hygiene alone (0.15) can never produce a score, and
 * neither can hygiene + one other small component. Two substantial components
 * — e.g. duplication + vitals (0.50) — do qualify.
 */
export const MIN_COVERAGE = 0.4;

/**
 * A post younger than this has not had time to be crawled, indexed and ranked,
 * so the search component is EXCLUDED (not scored zero) for it.
 * 28 days matches the Search Console reporting window used in gsc-signals.ts.
 */
export const SEARCH_MATURITY_DAYS = 28;

// ─── Duplication thresholds ─────────────────────────────────────────────────
// Calibrate on the real corpus before trusting these — SOP §4.4 has the SQL.

/** At or below this similarity, a post is treated as fully distinct. */
export const DUPLICATE_CLEAN_SIMILARITY = 0.8;

/** At or above this, the duplication component scores 0. */
export const DUPLICATE_ZERO_SIMILARITY = 0.95;

/**
 * At or above this, a critical seo_issue is raised naming the sibling post.
 * Env-overridable so the threshold can be tuned during calibration without a
 * deploy (QUALITY_DUPLICATE_FLAG).
 */
export function duplicateFlagSimilarity(): number {
  const v = Number(process.env.QUALITY_DUPLICATE_FLAG);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.92;
}

// ─── Core Web Vitals thresholds ─────────────────────────────────────────────
// Google's own good/poor boundaries. LCP and CLS are Core Web Vitals; TBT is
// the LAB proxy for INP, which lab Lighthouse does not emit (see
// pagespeed-client.ts extractVitals).
export const CWV_THRESHOLDS = {
  lcpMs: { good: 2500, poor: 4000, weight: 0.5 },
  cls: { good: 0.1, poor: 0.25, weight: 0.3 },
  tbtMs: { good: 200, poor: 600, weight: 0.2 },
} as const;

// ─── Signal shapes ──────────────────────────────────────────────────────────

export type IndexationVerdict = "indexed" | "not_indexed" | "unknown";

export type SearchSignal =
  | {
      available: true;
      impressions: number;
      clicks: number;
      position: number | null;
      /**
       * "page"      — Search Console returned rows for this exact URL.
       * "blog-zero" — the blog is synced and Google reported nothing for this
       *               URL, i.e. a genuine zero. See getSearchRollup.
       */
      source: "page" | "blog-zero";
    }
  | { available: false; reason: string };

export type DuplicationSignal =
  | {
      available: true;
      maxSimilarity: number;
      sameBlogSimilarity: number | null;
      networkSimilarity: number | null;
      nearestPostId: string;
      nearestPostTitle: string | null;
      nearestBlogId: string;
      nearestIsSameBlog: boolean;
    }
  | { available: false; reason: string };

export type VitalsSignal =
  | {
      available: true;
      lcpMs: number | null;
      /** Real CLS units (0.084), NOT the x1000 storage form. */
      cls: number | null;
      tbtMs: number | null;
      sampledUrl: string;
      sampleAgeDays: number;
    }
  | { available: false; reason: string };

export interface HygieneCounts {
  criticalIssues: number;
  warnings: number;
  notices: number;
}

export interface QualitySignals {
  indexation: IndexationVerdict;
  search: SearchSignal;
  duplication: DuplicationSignal;
  vitals: VitalsSignal;
  hygiene: HygieneCounts;
}

export interface QualityComponent {
  key: QualityComponentKey;
  /** Nominal weight out of 100. */
  weight: number;
  /** 0-100, or null when the component was skipped. */
  score: number | null;
  /** Human-readable: the measurement, or why there wasn't one. */
  detail: string;
}

export interface QualityBreakdown {
  /** 0-100, or null when we decline to publish a number. */
  score: number | null;
  /** Set whenever score is null or 0 — the one-line explanation. */
  reason: string | null;
  indexation: IndexationVerdict;
  components: QualityComponent[];
  /** Fraction of total weight that had real data (0-1). */
  coverage: number;
  /** Post age in days at scoring time; null when never published. */
  ageDays: number | null;
  /** Version this breakdown was produced by — bump when weights change. */
  version: number;
  scoredAt: string;
}

/**
 * Bump on ANY change to weights or thresholds. Stored in the breakdown so a
 * historical score can be interpreted against the rules that produced it
 * instead of the current ones.
 */
export const QUALITY_SCORE_VERSION = 1;

// ─── Sub-scorers ────────────────────────────────────────────────────────────

/**
 * Linear 100->0 ramp between a "good" and a "poor" threshold. Used for every
 * metric where lower is better. Bucketing (good/needs-improvement/poor) would
 * hide movement inside a bucket, which is exactly the failure mode of the
 * score being replaced.
 */
export function rampDown(value: number, good: number, poor: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= good) return 100;
  if (value >= poor) return 0;
  return Math.round(100 * (1 - (value - good) / (poor - good)));
}

/**
 * Search performance -> 0-100.
 *
 * Position bands rather than a continuous curve, because average position is
 * itself an aggregate and pretending it has sub-integer meaning is false
 * precision. The volume floor stops a page with three impressions at position
 * 2 from scoring like a page with three thousand.
 */
export function scoreSearch(impressions: number, position: number | null): number {
  // Zero impressions: the page is indexed and invisible. That is a real, bad
  // measurement — distinct from "no data", which never reaches this function
  // (see gsc-signals.getSearchRollup).
  if (impressions <= 0) return 0;

  let base: number;
  if (position === null) base = 40;          // impressions but no position from GSC
  else if (position <= 3) base = 100;
  else if (position <= 10) base = 85;
  else if (position <= 20) base = 65;
  else if (position <= 50) base = 40;
  else base = 20;

  // Volume floor: a handful of impressions is noise, not a ranking.
  if (impressions < 10) base = Math.min(base, 50);
  else if (impressions < 50) base = Math.min(base, 80);

  return base;
}

/**
 * Cross-post duplication -> 0-100. Inverted: high similarity is bad.
 * Thresholds are corpus-specific — calibrate before trusting (SOP §4.4).
 */
export function scoreDuplication(maxSimilarity: number): number {
  if (!Number.isFinite(maxSimilarity)) return 0;
  return rampDown(
    maxSimilarity,
    DUPLICATE_CLEAN_SIMILARITY,
    DUPLICATE_ZERO_SIMILARITY,
  );
}

/**
 * Core Web Vitals -> 0-100, or null when no individual vital was measured.
 * Sub-weights are renormalised over whichever vitals are present, for the same
 * reason the top-level weights are: a missing metric must not read as a zero.
 */
export function scoreVitals(v: {
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
}): number | null {
  const parts: Array<{ w: number; s: number }> = [];
  if (v.lcpMs !== null) {
    parts.push({
      w: CWV_THRESHOLDS.lcpMs.weight,
      s: rampDown(v.lcpMs, CWV_THRESHOLDS.lcpMs.good, CWV_THRESHOLDS.lcpMs.poor),
    });
  }
  if (v.cls !== null) {
    parts.push({
      w: CWV_THRESHOLDS.cls.weight,
      s: rampDown(v.cls, CWV_THRESHOLDS.cls.good, CWV_THRESHOLDS.cls.poor),
    });
  }
  if (v.tbtMs !== null) {
    parts.push({
      w: CWV_THRESHOLDS.tbtMs.weight,
      s: rampDown(v.tbtMs, CWV_THRESHOLDS.tbtMs.good, CWV_THRESHOLDS.tbtMs.poor),
    });
  }
  if (parts.length === 0) return null;
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  return Math.round(parts.reduce((a, p) => a + p.s * p.w, 0) / totalW);
}

/**
 * On-page tag hygiene -> 0-100, using the SAME severity weights the scanner
 * uses for its own category scores (lib/seo/scanner.ts PENALTY). Importing
 * them rather than restating them is the point: there is one deduction table
 * in this codebase now.
 */
export function scoreHygiene(h: HygieneCounts): number {
  const penalty =
    h.criticalIssues * PENALTY.critical +
    h.warnings * PENALTY.warning +
    h.notices * PENALTY.notice;
  return Math.max(0, 100 - penalty);
}

// ─── Composite ──────────────────────────────────────────────────────────────

function componentsFor(
  signals: QualitySignals,
  ageDays: number | null,
): QualityComponent[] {
  const out: QualityComponent[] = [];

  // ── Search performance ──
  const mature = ageDays !== null && ageDays >= SEARCH_MATURITY_DAYS;
  if (!mature) {
    out.push({
      key: "search",
      weight: QUALITY_WEIGHTS.search,
      score: null,
      detail:
        ageDays === null
          ? "Not published — no search history to read"
          : `Published ${ageDays}d ago; search performance is only scored from ${SEARCH_MATURITY_DAYS}d`,
    });
  } else if (!signals.search.available) {
    out.push({
      key: "search",
      weight: QUALITY_WEIGHTS.search,
      score: null,
      detail: signals.search.reason,
    });
  } else {
    const { impressions, clicks, position, source } = signals.search;
    out.push({
      key: "search",
      weight: QUALITY_WEIGHTS.search,
      score: scoreSearch(impressions, position),
      detail:
        source === "blog-zero"
          ? `No impressions in ${SEARCH_WINDOW_LABEL}: the blog is reporting to Search Console and this URL drew nothing`
          : `${impressions} impressions, ${clicks} clicks, avg position ` +
            `${position === null ? "n/a" : position.toFixed(1)} over ${SEARCH_MATURITY_DAYS}d`,
    });
  }

  // ── Duplication ──
  if (!signals.duplication.available) {
    out.push({
      key: "duplication",
      weight: QUALITY_WEIGHTS.duplication,
      score: null,
      detail: signals.duplication.reason,
    });
  } else {
    const d = signals.duplication;
    out.push({
      key: "duplication",
      weight: QUALITY_WEIGHTS.duplication,
      score: scoreDuplication(d.maxSimilarity),
      detail:
        `max cosine similarity ${d.maxSimilarity.toFixed(3)} against ` +
        `${d.nearestIsSameBlog ? "a post on the same blog" : "a post on another blog"} ` +
        `(${d.nearestPostId})`,
    });
  }

  // ── Core Web Vitals ──
  if (!signals.vitals.available) {
    out.push({
      key: "vitals",
      weight: QUALITY_WEIGHTS.vitals,
      score: null,
      detail: signals.vitals.reason,
    });
  } else {
    const v = signals.vitals;
    const s = scoreVitals(v);
    out.push({
      key: "vitals",
      weight: QUALITY_WEIGHTS.vitals,
      score: s,
      detail:
        s === null
          ? "PageSpeed sample carried no individual vitals"
          : `LCP ${v.lcpMs ?? "n/a"}ms, CLS ${v.cls ?? "n/a"}, TBT ${v.tbtMs ?? "n/a"}ms ` +
            `(sampled ${v.sampleAgeDays}d ago from ${v.sampledUrl})`,
    });
  }

  // ── Tag hygiene ── always available: the scan that calls us produced it.
  const h = signals.hygiene;
  out.push({
    key: "hygiene",
    weight: QUALITY_WEIGHTS.hygiene,
    score: scoreHygiene(h),
    detail: `${h.criticalIssues} critical, ${h.warnings} warnings, ${h.notices} notices on-page`,
  });

  return out;
}

const SEARCH_WINDOW_LABEL = `${SEARCH_MATURITY_DAYS} days`;

/**
 * Compute the composite quality score for one post.
 *
 * `ageDays` is days since publication, or null if the post was never
 * published. Passed in rather than read from a clock so this stays pure.
 */
export function computeQualityScore(
  signals: QualitySignals,
  opts: { ageDays: number | null; now?: Date },
): QualityBreakdown {
  const components = componentsFor(signals, opts.ageDays);
  const base = {
    indexation: signals.indexation,
    components,
    ageDays: opts.ageDays,
    version: QUALITY_SCORE_VERSION,
    scoredAt: (opts.now ?? new Date()).toISOString(),
  };

  // ── Gate 1: we do not know whether Google has this page. ──
  // Null, not zero. "Unchecked" is not a finding.
  if (signals.indexation === "unknown") {
    return {
      ...base,
      score: null,
      coverage: 0,
      reason:
        "Indexation unknown — Search Console has not reported on this URL yet, " +
        "so no ranking-relevant score can be computed.",
    };
  }

  // ── Gate 2: Google has this page and is not indexing it. ──
  // Everything else is moot; report 0 and keep the components for diagnosis.
  if (signals.indexation === "not_indexed") {
    return {
      ...base,
      score: 0,
      coverage: 1,
      reason:
        "Not indexed by Google. An unindexed page cannot rank, so on-page " +
        "quality does not raise this score.",
    };
  }

  // ── Weighted blend over whatever we could actually measure. ──
  const scored = components.filter(
    (c): c is QualityComponent & { score: number } => c.score !== null,
  );
  const availableWeight = scored.reduce((a, c) => a + c.weight, 0);
  const coverage = availableWeight / TOTAL_WEIGHT;

  if (coverage < MIN_COVERAGE) {
    const missing = components
      .filter((c) => c.score === null)
      .map((c) => c.key)
      .join(", ");
    return {
      ...base,
      score: null,
      coverage,
      reason:
        `Only ${Math.round(coverage * 100)}% of the scoring signal is available ` +
        `(missing: ${missing}). Below ${Math.round(MIN_COVERAGE * 100)}% we report n/a ` +
        `rather than a number derived from too little evidence.`,
    };
  }

  const score = Math.round(
    scored.reduce((a, c) => a + c.score * c.weight, 0) / availableWeight,
  );

  return {
    ...base,
    score: Math.max(0, Math.min(100, score)),
    coverage,
    reason:
      coverage < 1
        ? `Scored on ${Math.round(coverage * 100)}% of the signal; ` +
          `missing components were excluded, not counted as zero.`
        : null,
  };
}
