import { describe, expect, it } from "vitest";
import {
  computeQualityScore,
  MIN_COVERAGE,
  QUALITY_WEIGHTS,
  rampDown,
  scoreDuplication,
  scoreHygiene,
  scoreSearch,
  scoreVitals,
  type QualitySignals,
} from "./score";

const NOW = new Date("2026-08-25T00:00:00.000Z");

/** A fully-available, mid-range signal set. Override per test. */
function signals(over: Partial<QualitySignals> = {}): QualitySignals {
  return {
    indexation: "indexed",
    search: {
      available: true,
      impressions: 180,
      clicks: 4,
      position: 14,
      source: "page",
    },
    duplication: {
      available: true,
      maxSimilarity: 0.83,
      sameBlogSimilarity: 0.83,
      networkSimilarity: 0.71,
      nearestPostId: "post-b",
      nearestPostTitle: "Sibling",
      nearestBlogId: "blog-a",
      nearestIsSameBlog: true,
    },
    vitals: {
      available: true,
      lcpMs: 3100,
      cls: 0.06,
      tbtMs: 240,
      sampledUrl: "https://example.com/a",
      sampleAgeDays: 5,
    },
    hygiene: { criticalIssues: 0, warnings: 2, notices: 1 },
    ...over,
  };
}

describe("rampDown", () => {
  it("is 100 at or below good and 0 at or above poor", () => {
    expect(rampDown(2500, 2500, 4000)).toBe(100);
    expect(rampDown(1000, 2500, 4000)).toBe(100);
    expect(rampDown(4000, 2500, 4000)).toBe(0);
    expect(rampDown(9000, 2500, 4000)).toBe(0);
  });

  it("interpolates linearly in between", () => {
    expect(rampDown(3250, 2500, 4000)).toBe(50);
  });
});

describe("scoreSearch", () => {
  it("scores a measured zero as zero — indexed and invisible is a real failure", () => {
    expect(scoreSearch(0, null)).toBe(0);
  });

  it("rewards top-3 and punishes deep positions", () => {
    expect(scoreSearch(500, 2)).toBe(100);
    expect(scoreSearch(500, 8)).toBe(85);
    expect(scoreSearch(500, 45)).toBe(40);
    expect(scoreSearch(500, 80)).toBe(20);
  });

  it("caps low-volume pages so a single impression cannot look like a ranking", () => {
    expect(scoreSearch(3, 2)).toBe(50);
    expect(scoreSearch(30, 2)).toBe(80);
  });
});

describe("scoreDuplication", () => {
  it("is clean below the clean threshold and zero above the zero threshold", () => {
    expect(scoreDuplication(0.4)).toBe(100);
    expect(scoreDuplication(0.8)).toBe(100);
    expect(scoreDuplication(0.95)).toBe(0);
    expect(scoreDuplication(0.99)).toBe(0);
  });

  it("ramps in between", () => {
    expect(scoreDuplication(0.875)).toBe(50);
  });
});

describe("scoreVitals", () => {
  it("renormalises over whichever vitals are present", () => {
    // LCP only, at exactly 'good' -> 100 regardless of the missing two.
    expect(scoreVitals({ lcpMs: 2000, cls: null, tbtMs: null })).toBe(100);
  });

  it("returns null when nothing was measured", () => {
    expect(scoreVitals({ lcpMs: null, cls: null, tbtMs: null })).toBeNull();
  });

  it("does not treat a real CLS as zero (the pagespeed-client x1000 bug)", () => {
    // 0.4 is a bad CLS. If a caller ever passes the x1000 storage form by
    // mistake, this stays 0 rather than silently scoring 100.
    expect(scoreVitals({ lcpMs: null, cls: 0.4, tbtMs: null })).toBe(0);
    expect(scoreVitals({ lcpMs: null, cls: 0.05, tbtMs: null })).toBe(100);
  });
});

describe("scoreHygiene", () => {
  it("uses the scanner's shared PENALTY weights", () => {
    expect(scoreHygiene({ criticalIssues: 0, warnings: 0, notices: 0 })).toBe(100);
    // 1 critical (12) + 2 warnings (10) + 1 notice (2) = 24
    expect(scoreHygiene({ criticalIssues: 1, warnings: 2, notices: 1 })).toBe(76);
  });

  it("floors at zero", () => {
    expect(scoreHygiene({ criticalIssues: 50, warnings: 0, notices: 0 })).toBe(0);
  });
});

describe("computeQualityScore — the gate", () => {
  it("returns NULL, not zero, when indexation is unknown", () => {
    const r = computeQualityScore(signals({ indexation: "unknown" }), {
      ageDays: 90,
      now: NOW,
    });
    expect(r.score).toBeNull();
    expect(r.reason).toMatch(/Indexation unknown/);
  });

  it("returns 0 when the page is known not to be indexed, however good the page is", () => {
    const r = computeQualityScore(
      signals({
        indexation: "not_indexed",
        hygiene: { criticalIssues: 0, warnings: 0, notices: 0 },
      }),
      { ageDays: 90, now: NOW },
    );
    expect(r.score).toBe(0);
    expect(r.reason).toMatch(/Not indexed/);
    // Components are still reported so the 0 is diagnosable.
    expect(r.components).toHaveLength(4);
  });
});

describe("computeQualityScore — blending", () => {
  it("matches the hand-computed worked example", () => {
    const r = computeQualityScore(signals(), { ageDays: 60, now: NOW });
    // search 65x35 + duplication 80x25 + vitals 78x25 + hygiene 88x15 = 7500/100
    expect(r.coverage).toBe(1);
    expect(r.score).toBe(75);
  });

  it("excludes — never zeroes — the search component for an immature post", () => {
    const r = computeQualityScore(signals(), { ageDays: 10, now: NOW });
    const search = r.components.find((c) => c.key === "search");
    expect(search?.score).toBeNull();
    expect(search?.detail).toMatch(/only scored from 28d/);
    // (80x25 + 78x25 + 88x15) / 65 = 81
    expect(r.score).toBe(81);
  });

  it("returns null when coverage falls below the floor", () => {
    const r = computeQualityScore(
      signals({
        search: { available: false, reason: "no data" },
        duplication: { available: false, reason: "no embedding" },
        vitals: { available: false, reason: "no sample" },
      }),
      { ageDays: 90, now: NOW },
    );
    // Only hygiene (0.15) survives, under MIN_COVERAGE.
    expect(r.coverage).toBeLessThan(MIN_COVERAGE);
    expect(r.score).toBeNull();
    expect(r.reason).toMatch(/n\/a rather than a number/);
  });

  it("scores on a partial signal set once the floor is met", () => {
    const r = computeQualityScore(
      signals({ search: { available: false, reason: "no GSC rows" } }),
      { ageDays: 90, now: NOW },
    );
    // duplication + vitals + hygiene = 0.65 coverage
    expect(r.coverage).toBeCloseTo(0.65, 5);
    expect(r.score).toBe(81);
    expect(r.reason).toMatch(/excluded, not counted as zero/);
  });

  it("a measured zero-impression page scores 0 on search, not n/a", () => {
    // This is the case T04's real schema made possible: Search Console never
    // emits a row for a page with no impressions, so the blog-level probe in
    // gsc-signals resolves "no rows" into a genuine zero. Without it the most
    // important failure the score exists to catch would read as "no data".
    const r = computeQualityScore(
      signals({
        search: {
          available: true,
          impressions: 0,
          clicks: 0,
          position: null,
          source: "blog-zero",
        },
      }),
      { ageDays: 90, now: NOW },
    );
    const search = r.components.find((c) => c.key === "search");
    expect(search?.score).toBe(0);
    expect(search?.detail).toMatch(/drew nothing/);
    // (0x35 + 80x25 + 78x25 + 88x15) / 100 = 5270/100 = 52.7 -> 53
    expect(r.score).toBe(53);
  });

  it("never invents a number: every null score carries a reason", () => {
    const cases = [
      computeQualityScore(signals({ indexation: "unknown" }), { ageDays: 90, now: NOW }),
      computeQualityScore(
        signals({
          search: { available: false, reason: "x" },
          duplication: { available: false, reason: "y" },
          vitals: { available: false, reason: "z" },
        }),
        { ageDays: 90, now: NOW },
      ),
    ];
    for (const r of cases) {
      expect(r.score).toBeNull();
      expect(r.reason).toBeTruthy();
    }
  });
});

describe("the constants themselves", () => {
  it("weights sum to 100 — a drift here silently rescales every score", () => {
    const sum = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});
