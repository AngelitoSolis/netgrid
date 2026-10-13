import { describe, expect, it } from "vitest";
import { normalizeQueryKey } from "./topic-similarity";
import {
  applyRankedPoolFilter,
  isRankedPosition,
  liveRankDecision,
  rankedQueryKeys,
} from "./gsc-pool";

// S0 (GSC-aware ideation + live ledger re-rank) — pure-core tests. The DB-backed
// wrappers in gsc-pool.ts are thin SQL over search_performance with fail-safe
// empty returns; the DECISIONS live here and are what the DoD pins:
//   1. a query we already rank on never reaches ideation candidates;
//   2. clients with no GSC data see zero behavior change;
//   3. pending ledger order after re-rank matches a hand-computed expectation.

describe("isRankedPosition (S0-a guard window)", () => {
  it("excludes positions above the top of page one", () => {
    expect(isRankedPosition(1)).toBe(false);
    expect(isRankedPosition(2.99)).toBe(false);
  });

  it("includes the inclusive lower bound (position 3)", () => {
    expect(isRankedPosition(3)).toBe(true);
    expect(isRankedPosition(3.01)).toBe(true);
  });

  it("includes the inclusive upper bound (position 20)", () => {
    expect(isRankedPosition(20)).toBe(true);
  });

  it("excludes past the fold and non-finite input", () => {
    expect(isRankedPosition(20.01)).toBe(false);
    expect(isRankedPosition(Number.NaN)).toBe(false);
    expect(isRankedPosition(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("rankedQueryKeys (we-have-a-page-for-this guard)", () => {
  it("keeps only queries with at least one page in positions 3-20", () => {
    const keys = rankedQueryKeys([
      { query: "drain cleaning old town", avgPosition: 14.2 }, // in → keep
      { query: "sewer inspection cost", avgPosition: 1.5 }, // top-1, out of guard window
      { query: "peptide shipping times", avgPosition: 23.0 }, // page 3+, out
    ]);
    expect(keys.has(normalizeQueryKey("drain cleaning old town"))).toBe(true);
    expect(keys.has(normalizeQueryKey("sewer inspection cost"))).toBe(false);
    expect(keys.has(normalizeQueryKey("peptide shipping times"))).toBe(false);
  });

  it("normalizes case, accents and punctuation (same key as blog_covered_queries)", () => {
    const keys = rankedQueryKeys([
      { query: "Drain Cleaning — Old Town!", avgPosition: 12 },
    ]);
    expect(keys.has(normalizeQueryKey("drain cleaning old town"))).toBe(true);
  });

  it("dedupes to one key per normalized query (case + spacing are one page each)", () => {
    const keys = rankedQueryKeys([
      { query: "Sewer Inspection Cost!", avgPosition: 8 },
      // Same normalized key, different raw spelling and a different page.
      { query: "SEWER   inspection   cost?", avgPosition: 16 },
    ]);
    expect(keys.size).toBe(1);
    expect(keys.has(normalizeQueryKey("sewer inspection cost"))).toBe(true);
  });

  it("skips queries that normalize to nothing", () => {
    const keys = rankedQueryKeys([{ query: "!!! ???", avgPosition: 5 }]);
    expect(keys.size).toBe(0);
  });
});

describe("applyRankedPoolFilter (S0-a)", () => {
  const candidates = [
    { query: "drain cleaning old town" }, // live-ranked → must never reach ideation
    { query: "glp1 side effects" },
    { query: "sewer inspection cost" }, // variant of a ranked key below
    { query: "peptide storage tips" },
  ];

  it("drops every candidate the client already ranks on, best-first order intact", () => {
    const rankedKeys = new Set([
      normalizeQueryKey("drain cleaning old town"),
      // "Sewer Inspection Cost!" normalizes to the same key as the candidate.
      normalizeQueryKey("Sewer Inspection Cost!"),
    ]);
    const { kept, excludedCount } = applyRankedPoolFilter(candidates, rankedKeys);
    expect(excludedCount).toBe(2);
    expect(kept.map((c) => c.query)).toEqual([
      "glp1 side effects",
      "peptide storage tips",
    ]);
  });

  it("never lets a live-ranked query reach the kept list (DoD: seeded pair)", () => {
    // A search_performance row for ("drain cleaning old town", /blog/x) at
    // position 14.2 with 210 impressions produces exactly this guard set.
    const rankedKeys = rankedQueryKeys([
      { query: "drain cleaning old town", avgPosition: 14.2 },
    ]);
    const pool = [
      { query: "DRAIN Cleaning Old Town" }, // case variant of the ranked query
      { query: "something else entirely" },
    ];
    const { kept, excludedCount } = applyRankedPoolFilter(pool, rankedKeys);
    expect(excludedCount).toBe(1);
    expect(kept.map((c) => c.query)).toEqual(["something else entirely"]);
  });

  it("zero behavior change when the client has no GSC data (empty guard set)", () => {
    const { kept, excludedCount } = applyRankedPoolFilter(candidates, new Set());
    expect(excludedCount).toBe(0);
    expect(kept.map((c) => c.query)).toEqual(
      candidates.map((c) => c.query), // same rows, same order
    );
  });

  it("keeps a candidate whose key normalizes to empty (it can never collide)", () => {
    const { kept } = applyRankedPoolFilter([{ query: "???" }], new Set(["x"]));
    expect(kept).toHaveLength(1);
  });

describe("liveRankDecision (S0-b comparator — exact rule)", () => {
  it("no GSC data → build-time priority stands, unchanged bucket", () => {
    expect(liveRankDecision(7, null)).toEqual({
      priority: 7,
      bucket: "unchanged",
    });
    expect(liveRankDecision(7, Number.NaN).bucket).toBe("unchanged");
  });

  it("top-3 (best position < 3) → already-wins band at the bottom of the queue", () => {
    expect(liveRankDecision(1, 2.0)).toEqual({
      priority: 10_001,
      bucket: "already-wins",
    });
    // Boundary just inside top-3.
    expect(liveRankDecision(4, 2.99).bucket).toBe("already-wins");
  });

  it("page two (8 - 20.4) → rescue-queue band (S1 owns the query)", () => {
    expect(liveRankDecision(3, 8.0)).toEqual({
      priority: 10_003,
      bucket: "rescue-queue",
    });
    expect(liveRankDecision(9, 20.4).bucket).toBe("rescue-queue");
    // Just past the fold is NOT rescue-able — no invented behavior.
    expect(liveRankDecision(9, 20.41)).toEqual({
      priority: 9,
      bucket: "unchanged",
    });
  });

  it("positions between buckets (3 - 8) stay at build-time priority (documented gap)", () => {
    expect(liveRankDecision(5, 3.0).bucket).toBe("unchanged");
    expect(liveRankDecision(5, 7.99)).toEqual({
      priority: 5,
      bucket: "unchanged",
    });
  });

  it("preserves relative build-time order inside a moved band", () => {
    const a = liveRankDecision(2, 1.0); // already-wins
    const b = liveRankDecision(6, 2.5); // already-wins
    expect(a.priority).toBeLessThan(b.priority);
    expect([a.priority, b.priority].every((p) => p >= 10_000)).toBe(true);
  });
});

describe("S0-b hand-computed pending ledger order (DoD)", () => {
  // The claim query orders by (attempts asc, priority asc). This mirrors the
  // production re-rank step: best position across keyword OR any folded variant
  // from a live GSC map, then liveRankDecision per row.
  interface Row {
    id: string;
    keyword: string;
    variants?: string[];
    attempts: number;
    priority: number;
  }

  function rerankAndSort(rows: Row[], live: Map<string, number>): Row[] {
    const updated = rows.map((row) => {
      let best: number | null = null;
      for (const term of [row.keyword, ...(row.variants ?? [])]) {
        const key = normalizeQueryKey(term);
        if (!key) continue;
        const pos = live.get(key);
        if (pos !== undefined && (best === null || pos < best)) best = pos;
      }
      return { ...row, priority: liveRankDecision(row.priority, best).priority };
    });
    return updated.sort(
      (a, b) => a.attempts - b.attempts || a.priority - b.priority,
    );
  }

  it("moves ranked rows to the bottom in the exact hand-computed order", () => {
    const rows: Row[] = [
      // We already rank #2 for this — a new post would compete with our winner.
      { id: "a", keyword: "drain cleaning old town", attempts: 0, priority: 1 },
      // Page-2 via the FOLDED VARIANT (the row's own keyword has no data).
      {
        id: "b",
        keyword: "sewer inspection",
        variants: ["Sewer Inspection Cost"],
        attempts: 0,
        priority: 3,
      },
      // No GSC data at all — build-time priority stands.
      { id: "c", keyword: "plumbing tips", attempts: 0, priority: 2 },
    ];
    const live = new Map([
      [normalizeQueryKey("drain cleaning old town"), 2.0],
      [normalizeQueryKey("sewer inspection cost"), 14.5],
    ]);

    const order = rerankAndSort(rows, live).map((r) => r.id);
    // Hand-computed: c keeps priority 2 → claimed first; a (top-3) sits at band
    // position 10_001 before b (page-2) at 10_003.
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("client with no GSC data: order is byte-identical to today's behavior", () => {
    const rows: Row[] = [
      { id: "a", keyword: "drain cleaning old town", attempts: 0, priority: 1 },
      { id: "b", keyword: "sewer inspection", attempts: 0, priority: 3 },
      { id: "c", keyword: "plumbing tips", attempts: 0, priority: 2 },
    ];
    const order = rerankAndSort(rows, new Map()).map((r) => r.id);
    expect(order).toEqual(["a", "c", "b"]); // plain build-time priority asc
  });

  it("never-tried rows still beat requeued ones (attempts key unchanged by S0)", () => {
    const rows: Row[] = [
      { id: "retried", keyword: "x", attempts: 1, priority: 1 },
      { id: "fresh-ranked", keyword: "y", attempts: 0, priority: 10_005 }, // moved band
    ];
    const order = rerankAndSort(rows, new Map()).map((r) => r.id);
    expect(order).toEqual(["fresh-ranked", "retried"]);
  });
});
});