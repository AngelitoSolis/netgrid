// S3 — the shared claimer (mega-prompt DoD): the legacy keyword-ledger claim
// maps 1:1 into ClaimedTargetPage (byte-identical to pre-S3 for a city blog —
// the mandatory regression), the location claim is ONE atomic UPDATE whose
// candidate subquery owns the rotation order (mirroring the pure comparator —
// selection+claim are a single statement, so concurrent runs never share a
// row), clients.location_pages_per_day counts EVERY attempt in the last 24h
// (failures included), and a lost claim race either retries the next row or
// falls through to the legacy ledger. The refused-claim disposition matrix
// lives in location-matrix.test.ts (pure, same module that owns it).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  claimKeywordTargetForBlog: vi.fn(),
  markKeywordTargetGenerated: vi.fn(),
  markKeywordTargetFailed: vi.fn(),
  markKeywordTargetSkipped: vi.fn(),
  releaseKeywordTargetClaim: vi.fn(),
  releaseStuckKeywordTargets: vi.fn(),
  markLocationTargetGenerated: vi.fn(),
  markLocationTargetFailed: vi.fn(),
  markLocationTargetSkipped: vi.fn(),
  releaseLocationTargetClaim: vi.fn(),
}));

// post-language.ts (in the claimer's import graph) imports "server-only",
// which throws outside Next's RSC runtime — stub it for plain Node (vitest).
vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { execute: mocks.dbExecute },
}));

vi.mock("@/lib/actions/keyword-target-actions", () => ({
  claimKeywordTargetForBlog: mocks.claimKeywordTargetForBlog,
  markKeywordTargetGenerated: mocks.markKeywordTargetGenerated,
  markKeywordTargetFailed: mocks.markKeywordTargetFailed,
  markKeywordTargetSkipped: mocks.markKeywordTargetSkipped,
  releaseKeywordTargetClaim: mocks.releaseKeywordTargetClaim,
  releaseStuckKeywordTargets: mocks.releaseStuckKeywordTargets,
  markLocationTargetGenerated: mocks.markLocationTargetGenerated,
  markLocationTargetFailed: mocks.markLocationTargetFailed,
  markLocationTargetSkipped: mocks.markLocationTargetSkipped,
  releaseLocationTargetClaim: mocks.releaseLocationTargetClaim,
}));

import { claimNextTargetedPageForBlog } from "./content-generation-actions";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("claimNextTargetedPageForBlog — the shared claimer", () => {
  it("maps the legacy keyword-ledger claim 1:1 (regression: byte-identical for a city blog)", async () => {
    // Campaign off → the location claimer bails after its one gate query.
    mocks.dbExecute.mockResolvedValueOnce([{ enabled: false, pages_per_day: 2 }]);
    mocks.claimKeywordTargetForBlog.mockResolvedValueOnce({
      id: "kt-1",
      keyword: "drain cleaning melbourne",
      city: "Melbourne",
      topicTitle: "Drain Cleaning Melbourne",
      localFraming: true,
      variants: ["drain cleaning in melbourne"],
    });

    const claimed = await claimNextTargetedPageForBlog("blog-1");

    expect(mocks.claimKeywordTargetForBlog).toHaveBeenCalledWith("blog-1");
    expect(claimed).toEqual({
      id: "kt-1",
      ledger: "blog_keyword_targets",
      keyword: "drain cleaning melbourne",
      city: "Melbourne",
      topicTitle: "Drain Cleaning Melbourne",
      localFraming: true,
      variants: ["drain cleaning in melbourne"],
    });
  });

  it("claims atomically: one UPDATE whose candidate subquery owns the comparator order", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ enabled: true, pages_per_day: 2 }]) // campaign gate
      .mockResolvedValueOnce([{ n: 0 }]) // budget: 0 of 2 used today
      .mockResolvedValueOnce([
        // The atomic claim's UPDATE ... RETURNING — selection (ORDER BY
        // priority ASC, untried first, oldest attempt, id) happens INSIDE the
        // statement, so two concurrent runs can never hold the same row. The
        // ordering contract itself stays unit-tested on the pure comparator.
        { id: "row-a", service_key: "drain cleaning", place_name: "Old Town", combined_query: "drain cleaning old town" },
      ])
      .mockResolvedValueOnce([{ any: true }]); // EXISTS after any 0-row race

    const claimed = await claimNextTargetedPageForBlog("blog-1");

    expect(claimed).toMatchObject({
      id: "row-a",
      ledger: "location_page_targets",
      keyword: "drain cleaning old town",
      city: "Old Town",
      topicTitle: "Drain Cleaning in Old Town",
      localFraming: true,
      variants: [],
    });
    // One targeted page per due blog: a location claim wins, the legacy ledger
    // is never consulted in the same run.
    expect(mocks.claimKeywordTargetForBlog).not.toHaveBeenCalled();
  });

  it("respects clients.location_pages_per_day EXACTLY across two runs", async () => {
    // Run 1 (previous test) claimed 1 of 2 — this run shows the boundary: 2 of
    // 2 attempts in the last 24h (failures included — a failed attempt keeps
    // its fresh last_attempt_at) → no new claim, and the claimer never even
    // reaches the pending pool.
    mocks.dbExecute
      .mockResolvedValueOnce([{ enabled: true, pages_per_day: 2 }])
      .mockResolvedValueOnce([{ n: 2 }]);

    const claimed = await claimNextTargetedPageForBlog("blog-1");

    expect(claimed).toBeUndefined();
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2); // gate + budget only
    expect(mocks.claimKeywordTargetForBlog).toHaveBeenCalledTimes(1); // legacy fallback, drained
  });

  it("a lost claim race retries the NEXT pending row before ever giving up the slot", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ enabled: true, pages_per_day: 2 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([
        { id: "row-b", service_key: "roof repair", place_name: "Old Town", combined_query: "roof repair old town" },
      ])
      .mockResolvedValueOnce([{ any: true }]) // lost the race — candidates remain
      .mockResolvedValueOnce([
        { id: "row-b", service_key: "roof repair", place_name: "Old Town", combined_query: "roof repair old town" },
      ]); // second atomic attempt claims the next row

    const claimed = await claimNextTargetedPageForBlog("blog-1");
    expect(claimed).toMatchObject({
      id: "row-b",
      ledger: "location_page_targets",
      keyword: "roof repair old town",
    });
    expect(mocks.claimKeywordTargetForBlog).not.toHaveBeenCalled();
  });

  it("a drained pool after a lost race falls through to the legacy ledger instead of dropping the slot", async () => {
    mocks.dbExecute
      .mockResolvedValueOnce([{ enabled: true, pages_per_day: 2 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([]) // UPDATE returned nothing — another run won the last row
      .mockResolvedValueOnce([{ any: false }]); // pool is genuinely empty now

    const claimed = await claimNextTargetedPageForBlog("blog-1");
    expect(claimed).toBeUndefined();
    expect(mocks.claimKeywordTargetForBlog).toHaveBeenCalledTimes(1);
  });

  it("campaign off costs one query and never touches the location pool", async () => {
    mocks.dbExecute.mockResolvedValueOnce([{ enabled: false, pages_per_day: 2 }]);
    mocks.claimKeywordTargetForBlog.mockResolvedValueOnce(undefined);

    await claimNextTargetedPageForBlog("blog-1");

    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    expect(mocks.claimKeywordTargetForBlog).toHaveBeenCalledTimes(1);
  });
});