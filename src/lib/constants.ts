// SEO_WEIGHTS / SEO_CATEGORIES / SEO_SCORE_RANGES were removed in T19.
//
// The weights belonged to seo-scorer.ts (deleted — a second, unreachable
// scoring engine). The score ranges were never imported anywhere. Scoring
// weights and thresholds now live in exactly one place:
//   src/lib/services/quality/score.ts  (QUALITY_WEIGHTS, CWV_THRESHOLDS)
// and the per-issue severity deductions in:
//   src/lib/seo/scanner.ts             (PENALTY)

// Post Verification Alert Escalation
export const POST_ALERT_LEVELS = {
  warning: 1,   // 1x missed threshold
  urgent: 2,    // 2x missed threshold
  critical: 3,  // 3x missed threshold
} as const;

// Crawler Defaults
export const CRAWLER_DEFAULTS = {
  delayMs: 2000,
  maxConcurrent: 5,
  userAgent: "NetGrid-SEO-Monitor/1.0 (+https://netgrid.app)",
  maxPagesPerBlog: 50,
  requestTimeoutMs: 10000,
} as const;

// Pagination
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// Magic Link
export const MAGIC_LINK_EXPIRY_MINUTES = 15;
export const CLIENT_SESSION_DAYS = 7;
