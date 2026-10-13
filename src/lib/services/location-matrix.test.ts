// S3 — location matrix pure core (DoD: planner output matches hand-computed
// expectations exactly; re-running is byte-identical — idempotent builds; the
// claim comparator IS the neighborhood rotation; budget + coverage boundaries
// are exact). No DB here: the DB-backed builder and outcome reads are thin
// compositions of these primitives.

import { describe, expect, it } from "vitest";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import {
  compareLocationCandidates,
  decideClaimedTargetDisposition,
  locationBudgetExhausted,
  locationCoveragePct,
  localServicePageStructure,
  MATRIX_ROW_CAP,
  MATRIX_SERVICE_CAP,
  planMatrixRows,
  placesForBlog,
  type MatrixBlogPlaces,
  type MatrixServiceTerm,
} from "./location-matrix";

const services = (terms: string[]): MatrixServiceTerm[] =>
  terms.map((t, i) => ({
    serviceKey: t.toLowerCase().replace(/\s+/g, " ").trim(),
    display: t,
    priority: i + 1,
  }));

const blog = (id: string, places: string[]): MatrixBlogPlaces => ({
  blogId: id,
  places: places.map((p) => ({ placeName: p, source: "city" as const })),
});

describe("planMatrixRows — hand-computed fixtures", () => {
  it("plans every (service × place) row for a carrying blog, in documented order", () => {
    const rows = planMatrixRows({
      services: services(["Drain Cleaning", "Roof Repair"]),
      blogs: [blog("b1", ["Melbourne"])],
      clientLocalPresence: true,
    });
    expect(rows).toEqual([
      {
        blogId: "b1",
        serviceKey: "drain cleaning",
        placeName: "Melbourne",
        combinedQuery: "Drain Cleaning Melbourne",
        status: "pending",
        skipReason: null,
        priority: 1,
      },
      {
        blogId: "b1",
        serviceKey: "roof repair",
        placeName: "Melbourne",
        combinedQuery: "Roof Repair Melbourne",
        status: "pending",
        skipReason: null,
        priority: 2,
      },
    ]);
  });

  it("is idempotent — identical inputs produce a byte-identical row set (re-run adds 0 rows)", () => {
    const input = {
      services: services(["Drain Cleaning", "Roof Repair"]),
      blogs: [blog("b1", ["Melbourne", "Old Town"]), blog("b2", ["Geelong"])],
      clientLocalPresence: true,
      coveredByBlog: new Map([["b1", new Set([normalizeQueryKey("drain cleaning melbourne")])]]),
    };
    expect(planMatrixRows(input)).toEqual(planMatrixRows(input));
  });

  it("a client without local presence gets informational-only rows, never pages", () => {
    const rows = planMatrixRows({
      services: services(["Drain Cleaning"]),
      blogs: [blog("b1", ["Melbourne"])],
      clientLocalPresence: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "skipped", skipReason: "no_local_presence" });
  });

  it("already_covered skips only the covered pair — sibling places/services stay pending", () => {
    const rows = planMatrixRows({
      services: services(["Drain Cleaning", "Roof Repair"]),
      blogs: [blog("b1", ["Melbourne"])],
      clientLocalPresence: true,
      coveredByBlog: new Map([["b1", new Set([normalizeQueryKey("Drain Cleaning Melbourne")])]]),
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      serviceKey: "drain cleaning",
      status: "skipped",
      skipReason: "already_covered",
    });
    expect(rows[1]).toMatchObject({ serviceKey: "roof repair", status: "pending" });
  });

  it("duplicate_cluster is client-wide: a second blog planning the same normalized pair is skipped", () => {
    const rows = planMatrixRows({
      services: services(["Drain Cleaning"]),
      blogs: [blog("b1", ["Melbourne"]), blog("b2", ["Melbourne"])],
      clientLocalPresence: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ blogId: "b1", status: "pending", skipReason: null });
    expect(rows[1]).toMatchObject({ blogId: "b2", status: "skipped", skipReason: "duplicate_cluster" });
  });

  it("hard-caps rows at MATRIX_ROW_CAP so one fat client cannot fan out unbounded", () => {
    const many = Array.from({ length: 300 }, (_, i) => `service ${i + 1}`);
    expect(many.length).toBeGreaterThan(MATRIX_SERVICE_CAP); // the cap lives in the DB picker
    const rows = planMatrixRows({
      services: services(many),
      blogs: [blog("b1", ["Melbourne"]), blog("b2", ["Geelong"])],
      clientLocalPresence: true,
    });
    expect(rows).toHaveLength(MATRIX_ROW_CAP);
  });
});

describe("placesForBlog — real places only", () => {
  it("orders city → neighborhood → additional areas with sources, trimming empties", () => {
    expect(
      placesForBlog("  Melbourne ", " Old Town ", ["  Geelong ", "", "   "]).map((p) => p),
    ).toEqual([
      { placeName: "Melbourne", source: "city" },
      { placeName: "Old Town", source: "neighborhood" },
      { placeName: "Geelong", source: "additional_area" },
    ]);
  });

  it("dedupes case-insensitively (first source wins) and caps the fan-out", () => {
    const places = placesForBlog("Melbourne", "melbourne", ["MELBOURNE", "a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(places[0]).toEqual({ placeName: "Melbourne", source: "city" });
    expect(places).toHaveLength(8); // MAX_PLACES_PER_BLOG
  });

  it("a blog with neither city nor profile facts contributes no places (and therefore no rows)", () => {
    expect(placesForBlog(null, null, [])).toEqual([]);
  });

  it("appends the client's OTHER-blog cities last, alphabetical, deduped against the blog's own places", () => {
    const places = placesForBlog("Melbourne", "Old Town", ["Geelong"], [
      "Ballarat",
      "melbourne", // own city from a sibling blog — never planned twice
      "Ararat",
      "",
    ]);
    expect(places.map((p) => p.placeName)).toEqual([
      "Melbourne",
      "Old Town",
      "Geelong",
      "Ararat", // other-blog cities are alphabetical after the curated places
      "Ballarat",
    ]);
    expect(places.slice(3).every((p) => p.source === "city")).toBe(true);
  });

  it("other-blog cities only take leftover cap slots — operator-curated places keep theirs", () => {
    const places = placesForBlog("Melbourne", "Old Town", ["Geelong"], [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(places).toHaveLength(8); // MAX_PLACES_PER_BLOG
    expect(places.slice(0, 3).map((p) => p.placeName)).toEqual(["Melbourne", "Old Town", "Geelong"]);
  });
});

describe("compareLocationCandidates — the ordering IS the neighborhood rotation", () => {
  it("priority asc, then untried rows first (NULLS FIRST), then oldest attempt", () => {
    const tried = new Date("2026-09-01T00:00:00Z");
    const triedLater = new Date("2026-09-02T00:00:00Z");
    const ranked = [
      { id: "tried-later", priority: 1, lastAttemptAt: triedLater },
      { id: "untried-p3", priority: 3, lastAttemptAt: null },
      { id: "tried", priority: 1, lastAttemptAt: tried },
      { id: "untried-p2", priority: 2, lastAttemptAt: null },
    ].sort(compareLocationCandidates);
    expect(ranked.map((c) => c.id)).toEqual(["tried", "tried-later", "untried-p2", "untried-p3"]);
  });

  it("rows without a priority snapshot never beat ranked ones", () => {
    expect(
      compareLocationCandidates(
        { id: "a", priority: null, lastAttemptAt: null },
        { id: "b", priority: 99, lastAttemptAt: null },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("locationBudgetExhausted — pagesPerDay boundary is exact (failures included)", () => {
  it("counts EVERY attempt in the last 24h against the cap — the caller's query counts rows by last_attempt_at whatever their current status, so a failed (requeued 'pending') attempt still burns its day-slot", () => {
    expect(locationBudgetExhausted(0, 2)).toBe(false);
    expect(locationBudgetExhausted(1, 2)).toBe(false);
    expect(locationBudgetExhausted(2, 2)).toBe(true); // boundary: N of N = exhausted
    expect(locationBudgetExhausted(3, 2)).toBe(true);
    expect(locationBudgetExhausted(0, 0)).toBe(true); // a 0-cap never claims
  });
});

describe("localServicePageStructure — the fixed anatomy", () => {
  it("is deterministic and built only from the claimed terms", () => {
    expect(localServicePageStructure("drain cleaning", "Old Town")).toBe(
      localServicePageStructure("drain cleaning", "Old Town"),
    );
    const text = localServicePageStructure("drain cleaning", "Old Town");
    expect(text).toContain("drain cleaning");
    expect(text).toContain("Old Town");
  });

  it("falls back to honest placeholders instead of inventing a service or place", () => {
    const text = localServicePageStructure("", "");
    expect(text).toContain("the service");
    expect(text).toContain("the area");
  });

  it("carries all five skeleton-#13 anatomy sections — the no-profile prompt path is forced through the same contract", () => {
    const text = localServicePageStructure("drain cleaning", "Old Town");
    expect(text).toContain("LOCAL SERVICE PAGE STRUCTURE");
    expect(text).toContain("- H1 must be exactly: drain cleaning in Old Town");
    expect(text).toContain("from the operator facts below ONLY");
    expect(text).toContain("Service list: only services present in the directive/knowledge data");
    expect(text).toContain("Local proof points: only real facts");
    expect(text).toContain("FAQ block");
  });
});

describe("locationCoveragePct — one formula for every surface", () => {
  it("counts only actionable rows in the denominator; skipped rows never count", () => {
    expect(locationCoveragePct(3, 6)).toBe(50);
    expect(locationCoveragePct(7, 9)).toBe(78); // 77.8 → rounded
    expect(locationCoveragePct(0, 5)).toBe(0); // 0% is a real state, not "—"
  });

  it("no matrix (or a nonsensical one) → null, and every surface omits the line", () => {
    expect(locationCoveragePct(0, 0)).toBeNull();
    expect(locationCoveragePct(5, 0)).toBeNull();
    expect(locationCoveragePct(2, -1)).toBeNull();
    expect(locationCoveragePct(0, Number.NaN)).toBeNull();
  });
});

describe("decideClaimedTargetDisposition — refused-claim lifecycle (DoD)", () => {
  it("a gate-blocked MATRIX row stays requeueable: 'failed' = pending + reason (cool-off, not hot-loop)", () => {
    expect(
      decideClaimedTargetDisposition({
        ledger: "location_page_targets",
        keyword: "drain cleaning old town",
        gateBlocked: true,
        gateReason: "site profile has no signature facts",
      }),
    ).toEqual({ action: "failed", reason: "site profile has no signature facts" });
  });

  it("a gate-blocked LEGACY row keeps its pre-S3 mark and exact reason string", () => {
    expect(
      decideClaimedTargetDisposition({
        ledger: "blog_keyword_targets",
        keyword: "drain cleaning melbourne",
        gateBlocked: true,
        gateReason: null,
      }),
    ).toEqual({
      action: "skipped",
      reason: "local page refused: site profile is not ready",
    });
  });

  it("duplicate titles and already-covered rows retire terminal-skipped, byte-identical reasons", () => {
    expect(
      decideClaimedTargetDisposition({
        ledger: "blog_keyword_targets",
        keyword: "k",
        gateBlocked: false,
        duplicateTitle: { title: "Old Post", score: 0.456 },
      }),
    ).toEqual({ action: "skipped", reason: 'title duplicates "Old Post" (46% word overlap)' });
    expect(
      decideClaimedTargetDisposition({
        ledger: "location_page_targets",
        keyword: "k",
        gateBlocked: false,
      }),
    ).toEqual({ action: "skipped", reason: 'keyword "k" is already covered by this blog' });
  });
});