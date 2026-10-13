import { describe, expect, it } from "vitest";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import {
  RESCUE_MAX_APPLIED_NETWORK,
  RESCUE_MAX_APPLIED_PER_BLOG,
  RESCUE_MAX_GENERATED_PER_RUN,
  computeRescueOutcome,
  normalizeForMatch,
  rescueIssueKey,
  rescueIssuePageUrl,
  rescueIssueTitle,
  rescueSeverity,
  type RescueFinding,
} from "./page2-rescue";

// S1 (page-2 goldmine rescue loop) — pure-core tests. The DB-backed wrappers in
// page2-rescue.ts are thin SQL over search_performance / seo_issues with fail-
// safe empty returns; the DECISIONS live here and pin the brief's boundaries:
//   1. F8 honest skip — a delta exists ONLY when both measurements exist, and
//      improved-or-stable (delta >= -1) counts as resolved;
//   2. F4 stable identity — one issue_key per normalized query, namespaced;
//   3. F1 managed check — URL comparison ignores tracking params + trailing
//      slash + host case, never the pathname itself;
//   4. severity convention — top-3 pairs by impressions are critical.

describe("computeRescueOutcome (F8 proof layer)", () => {
  it("improved: positive delta, resolved", () => {
    const v = computeRescueOutcome(14.2, 8.0, 300);
    expect(v.deltaPositions).toBe(6.2); // one decimal place, no float noise
    expect(v.resolved).toBe(true);
    expect(v.afterPosition).toBe(8.0);
    expect(v.afterImpressions).toBe(300);
  });

  it("stable at exactly -1: the documented boundary counts as resolved", () => {
    const v = computeRescueOutcome(12, 13, null);
    expect(v.deltaPositions).toBe(-1);
    expect(v.resolved).toBe(true); // same page, same fold — not a failure
  });

  it("worse than one position: stays open for the next cycle", () => {
    const v = computeRescueOutcome(12, 13.9, null);
    expect(v.deltaPositions).toBe(-1.9);
    expect(v.resolved).toBe(false);
  });

  it("missing BEFORE (no pre-snapshot): no delta, never a fabricated ROI", () => {
    const v = computeRescueOutcome(null, 8, 300);
    expect(v.deltaPositions).toBeNull();
    expect(v.resolved).toBe(false);
    // The after measurement is still carried for display — it was real.
    expect(v.afterPosition).toBe(8);
  });

  it("missing AFTER (query fell out of the trailing window): thin data, not an error", () => {
    const v = computeRescueOutcome(14.2, null, null);
    expect(v.deltaPositions).toBeNull();
    expect(v.resolved).toBe(false);
  });

  it("non-finite AFTER is treated as missing, never written into a delta", () => {
    const v = computeRescueOutcome(14.2, Number.NaN, null);
    expect(v.deltaPositions).toBeNull();
    expect(v.afterPosition).toBeNull();
  });

  it("rounds the delta to one decimal place for rendering", () => {
    const v = computeRescueOutcome(14.25, 8.03, null); // raw delta 6.22
    expect(v.deltaPositions).toBe(6.2);
  });
});

describe("rescueIssueKey (F4 stable identity)", () => {
  it("namespaces the normalized query under page2:", () => {
    expect(rescueIssueKey("drain cleaning old town")).toBe(
      `page2:${normalizeQueryKey("drain cleaning old town")}`,
    );
  });

  it("is stable across case, spacing and punctuation (same row every daily run)", () => {
    const a = rescueIssueKey("Drain Cleaning — Old Town!");
    const b = rescueIssueKey("DRAIN   cleaning   old town?");
    expect(a).toBe(b);
  });

  it("never collides with other detectors' namespaces", () => {
    expect(rescueIssueKey("x").startsWith("page2:")).toBe(true);
    expect(rescueIssueKey("x").startsWith("split:")).toBe(false);
  });
});

describe("rescueSeverity (brief D.1 convention)", () => {
  it("top-3 pairs by impressions are critical", () => {
    expect(rescueSeverity(0)).toBe("critical");
    expect(rescueSeverity(1)).toBe("critical");
    expect(rescueSeverity(2)).toBe("critical");
  });

  it("the rest are warning, not noise-criticals", () => {
    expect(rescueSeverity(3)).toBe("warning");
    expect(rescueSeverity(49)).toBe("warning");
  });
});

describe("normalizeForMatch (F1 managed check only)", () => {
  it("strips tracking params GSC adds but our stored URLs never have", () => {
    const gsc = normalizeForMatch("https://example.com/drain-cleaning/?utm_source=gsc&utm_medium=cpc");
    const stored = normalizeForMatch("https://example.com/drain-cleaning/");
    expect(gsc).toBe(stored);
  });

  it("compares origin+pathname case-insensitively on the host", () => {
    expect(normalizeForMatch("HTTPS://Example.COM/A")).toBe(
      normalizeForMatch("https://example.com/A"),
    );
  });

  it("trims trailing slashes and collapses /index.html to the site root", () => {
    expect(normalizeForMatch("https://x.com/a/b/")).toBe("x.com/a/b");
    expect(normalizeForMatch("https://x.com/index.html")).toBe(
      normalizeForMatch("https://x.com/"),
    );
  });

  it("keeps pathname case (it is part of the URL identity)", () => {
    expect(normalizeForMatch("https://x.com/Drain-Cleaning")).toBe("x.com/Drain-Cleaning");
    expect(normalizeForMatch("https://x.com/drain-cleaning")).not.toBe(
      normalizeForMatch("https://x.com/Drain-Cleaning"),
    );
  });

  it("falls back to a trimmed, param-stripped string for non-URL input", () => {
    expect(normalizeForMatch("some/path?x=1#frag")).toBe("some/path");
    expect(normalizeForMatch("   ")).toBe("");
    expect(normalizeForMatch("")).toBe("");
  });
});

describe("rescueIssueTitle + rescueIssuePageUrl", () => {
  const managed: RescueFinding = {
    blogId: "b1",
    query: "drain cleaning old town",
    page: "https://example.com/drain-cleaning/?utm_source=x",
    impressions90d: 300,
    clicks90d: 4,
    avgPosition: 12.5,
    managed: true,
    canonicalUrl: "https://example.com/drain-cleaning/",
    postId: "p1",
    severity: "critical",
  };

  it("renders the brief's greppable title convention with one-decimal positions", () => {
    expect(rescueIssueTitle("drain cleaning old town", 12.45, 300)).toBe(
      'Page-2 rescue: "drain cleaning old town" (12.5 avg, 300 imp/90d)',
    );
    // Integer positions render without a trailing .0 — stable string output.
    expect(rescueIssueTitle("q", 12, 99)).toContain("(12 avg, 99 imp/90d)");
  });

  it("stores the canonical URL when we own the page (what findPostByUrl resolves)", () => {
    expect(rescueIssuePageUrl(managed)).toBe("https://example.com/drain-cleaning/");
  });

  it("falls back to the raw GSC string for unmanaged pages", () => {
    const unmanaged: RescueFinding = { ...managed, managed: false, canonicalUrl: null };
    expect(rescueIssuePageUrl(unmanaged)).toBe(managed.page);
  });
});

describe("budget constants (F7)", () => {
  it("are positive integers with sane defaults", () => {
    expect(Number.isInteger(RESCUE_MAX_GENERATED_PER_RUN)).toBe(true);
    expect(Number.isInteger(RESCUE_MAX_APPLIED_PER_BLOG)).toBe(true);
    expect(Number.isInteger(RESCUE_MAX_APPLIED_NETWORK)).toBe(true);
    expect(RESCUE_MAX_GENERATED_PER_RUN).toBeGreaterThan(0);
    expect(RESCUE_MAX_APPLIED_PER_BLOG).toBeGreaterThan(0);
    expect(RESCUE_MAX_APPLIED_NETWORK).toBeGreaterThanOrEqual(RESCUE_MAX_APPLIED_PER_BLOG);
  });
});

