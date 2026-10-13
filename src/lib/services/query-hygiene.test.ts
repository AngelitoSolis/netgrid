// S2/S8 query-hygiene detector — pure-helper boundaries (the DB detectors are
// fail-safe wrappers around these rules, so the money logic is testable here).

import { describe, expect, it, vi } from "vitest";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";

// The §E telemetry + v1 ledger reads below hit the drizzle select builder.
// Mock the module the same way content-generation-actions.test.ts does, with
// a thenable chain whose resolved rows each test enqueues.
const dbMocks = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const rows = dbMocks.selectQueue.shift() ?? [];
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        // Mirror real drizzle: limit() bounds what the caller receives.
        limit: (n: number) => {
          const bounded = rows.slice(0, n);
          return {
            then: (
              resolve: (rows: unknown[]) => unknown,
              reject?: (e: unknown) => unknown,
            ) => Promise.resolve(bounded).then(resolve, reject),
          };
        },
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  },
}));

import {
  DEAD_MAX_TOTAL_IMPRESSIONS,
  PIN_MIN_IMPRESSIONS_90D,
  SPLIT_MIN_IMPRESSIONS_90D,
  deadIssueKey,
  foldedIssueKey,
  hygieneDecisionLine,
  hygieneFamilyFromKey,
  hygieneLedgerTelemetry,
  hygieneNoteLine,
  listHygieneIssues,
  metaContainsQuery,
  normPageDigest,
  pickSplitWinner,
  pinIssueKey,
  splitIssueKey,
} from "./query-hygiene";

describe("hygieneFamilyFromKey — the four namespaces and nothing else", () => {
  it("maps each hygiene prefix", () => {
    expect(hygieneFamilyFromKey("split:drain-cleaning")).toBe("split");
    expect(hygieneFamilyFromKey("folded:abc123")).toBe("folded");
    expect(hygieneFamilyFromKey("pin:bpc-157")).toBe("pin");
    expect(hygieneFamilyFromKey("dead:abc123")).toBe("dead");
  });

  it("S1's page2: rows are NOT hygiene — null", () => {
    expect(hygieneFamilyFromKey("page2:drain-cleaning")).toBeNull();
  });

  it("keyless legacy rows and nulls are null", () => {
    expect(hygieneFamilyFromKey(null)).toBeNull();
    expect(hygieneFamilyFromKey("")).toBeNull();
    expect(hygieneFamilyFromKey("unrelated:key")).toBeNull();
  });
});

describe("hygieneLedgerTelemetry — §E S8 detected-vs-decided counts", () => {
  it("buckets keyed rows open-vs-decided by family and ignores page2:", async () => {
    dbMocks.selectQueue.push([
      { issueKey: "split:alpha", status: "detected" },
      { issueKey: "split:beta", status: "approved" },
      { issueKey: "folded:gamma", status: "queued" },
      { issueKey: "pin:delta", status: "dismissed" },
      { issueKey: "dead:eps", status: "failed" },
      { issueKey: "dead:zeta", status: "verified" },
      { issueKey: "page2:eta", status: "queued" }, // S1's — never hygiene's
      { issueKey: null, status: "detected" }, // legacy keyless — skipped
    ]);
    const t = await hygieneLedgerTelemetry();
    expect(t.open).toEqual({ split: 1, folded: 1, pin: 0, dead: 0 });
    expect(t.decided).toEqual({ split: 1, folded: 0, pin: 1, dead: 2 });
  });

  it("an empty ledger is all zeros — a valid state, not an error", async () => {
    dbMocks.selectQueue.push([]);
    const t = await hygieneLedgerTelemetry(["11111111-1111-4111-8111-111111111111"]);
    expect(t.open).toEqual({ split: 0, folded: 0, pin: 0, dead: 0 });
    expect(t.decided).toEqual({ split: 0, folded: 0, pin: 0, dead: 0 });
  });
});

describe("hygieneDecisionLine — the /review telemetry line (F8)", () => {
  it("all-zero → null: the card shows no empty promise", () => {
    expect(
      hygieneDecisionLine({
        open: { split: 0, folded: 0, pin: 0, dead: 0 },
        decided: { split: 0, folded: 0, pin: 0, dead: 0 },
      }),
    ).toBeNull();
  });

  it("renders per-family open/decided pairs", () => {
    const line = hygieneDecisionLine({
      open: { split: 2, folded: 0, pin: 0, dead: 3 },
      decided: { split: 1, folded: 0, pin: 4, dead: 0 },
    }) ?? "";
    expect(line).toContain("split 2 open / 1 decided");
    expect(line).toContain("pin 0 open / 4 decided");
    expect(line).toContain("dead 3 open / 0 decided");
  });

  it("omits families with nothing on either side", () => {
    const line = hygieneDecisionLine({
      open: { split: 1, folded: 0, pin: 0, dead: 0 },
      decided: { split: 0, folded: 0, pin: 0, dead: 0 },
    }) ?? "";
    expect(line).not.toContain("folded");
    expect(line).not.toContain("pin");
    expect(line).toContain("split 1 open / 0 decided");
  });
});

describe("listHygieneIssues — the ?hygiene=1 ledger read (public fields only)", () => {
  it("maps rows to family/status/decidedAt without payload internals", async () => {
    const detected = new Date("2026-09-01T10:00:00Z");
    const approved = new Date("2026-09-05T09:00:00Z");
    dbMocks.selectQueue.push([
      {
        id: "i1",
        issueKey: "split:alpha",
        title: "Query split: alpha ranks on 2 pages",
        pageUrl: "https://example.com/winner/",
        severity: "warning",
        status: "approved",
        autoFixable: false,
        detectedAt: detected,
        approvedAt: approved,
        appliedAt: null,
        verifiedAt: null,
        resolvedAt: approved,
      },
      {
        id: "i2",
        issueKey: "dead:beta",
        title: "Zero-traction page",
        pageUrl: null,
        severity: "notice",
        status: "detected",
        autoFixable: false,
        detectedAt: new Date("2026-09-02T10:00:00Z"),
        approvedAt: null,
        appliedAt: null,
        verifiedAt: null,
        resolvedAt: null,
      },
    ]);
    const rows = await listHygieneIssues("c1", {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      issueId: "i1",
      family: "split",
      status: "approved",
      detectedAt: "2026-09-01T10:00:00.000Z",
      decidedAt: "2026-09-05T09:00:00.000Z",
    });
    // Open row: no decision stamp yet.
    expect(rows[1]).toMatchObject({
      issueId: "i2",
      family: "dead",
      status: "detected",
      pageUrl: null,
      decidedAt: null,
    });
    // The public row shape never carries internals.
    expect(Object.keys(rows[0])).not.toContain("fixPayload");
    expect(Object.keys(rows[0])).not.toContain("description");
  });

  it("clamps the limit to the same 1..500 band as rescues=1", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `i${i}`,
      issueKey: `pin:k${i}`,
      title: "t",
      pageUrl: null,
      severity: "notice",
      status: "detected",
      autoFixable: false,
      detectedAt: new Date(2026, 0, 1, 0, 0, i),
      approvedAt: null,
      appliedAt: null,
      verifiedAt: null,
      resolvedAt: null,
    }));
    dbMocks.selectQueue.push(many);
    const rows = await listHygieneIssues("c1", { limit: 9999 });
    expect(rows).toHaveLength(500);
  });
});

describe("issue key helpers", () => {
  it("namespaces the normalized query under split:", () => {
    expect(splitIssueKey("Drain Cleaning Old Town")).toBe(
      `split:${normalizeQueryKey("drain cleaning old town")}`,
    );
  });

  it("namespaces the normalized query under pin: (S1's page2: sibling)", () => {
    expect(pinIssueKey("bpc-157 dosage quebec")).toBe(
      `pin:${normalizeQueryKey("bpc-157 dosage quebec")}`,
    );
  });

  it("page keys are stable digests of the normalized URL (params/slash collapse)", () => {
    const a = foldedIssueKey("https://example.com/drain-cleaning/?utm_source=mail");
    const b = foldedIssueKey("http://example.com/drain-cleaning/");
    expect(a).toBe(b);
    expect(a.startsWith("folded:")).toBe(true);
    // issue_key is varchar(255) — the digest must always fit.
    expect(a.length).toBeLessThanOrEqual(255);
  });

  it("distinct pages get distinct keys", () => {
    expect(normPageDigest("https://example.com/a")).not.toBe(
      normPageDigest("https://example.com/b"),
    );
  });

  it("unparseable/empty URLs produce empty keys; non-URL strings fall back to a stable digest", () => {
    expect(foldedIssueKey("   ")).toBe("");
    expect(deadIssueKey("")).toBe("");
    expect(normPageDigest("relative/path-only")).not.toBe(""); // trimmed-self fallback, still deterministic
  });

  it("dead: keys share the same digest convention as folded:", () => {
    const url = "https://example.com/old-post";
    expect(deadIssueKey(url).slice(5)).toBe(foldedIssueKey(url).slice(7)); // same sha1 tail
  });
});

describe("metaContainsQuery (the pin detector's containment rule)", () => {
  const q = "drain cleaning old town";

  it("matches when EVERY query token appears in the meta, word order free", () => {
    expect(metaContainsQuery("Old Town Drain Cleaning — Same Day Service", q)).toBe(true);
  });

  it("does not match a partial overlap (missing tokens = not pinned)", () => {
    expect(metaContainsQuery("Drain Service and Sewer Repair", q)).toBe(false);
  });

  it("never matches against null or empty meta", () => {
    expect(metaContainsQuery(null, q)).toBe(false);
    expect(metaContainsQuery(undefined, q)).toBe(false);
    expect(metaContainsQuery("", q)).toBe(false);
  });

  it("treats case and spacing variants as the same query (normalizeQueryKey pipeline)", () => {
    expect(metaContainsQuery("DRAIN   CLEANING Old Town", "drain cleaning old town")).toBe(true);
  });

  it("note: hyphens JOIN words in normalizeQueryKey, so 'Drain-Cleaning' is one token — the containment rule compares tokens of the normalized form, exactly as every other dedupe key does (F5)", () => {
    expect(metaContainsQuery("Drain Cleaning Old Town", "drain cleaning old town")).toBe(true);
  });

  it("rejects queries with no alphanumeric content (empty key can never pin)", () => {
    expect(metaContainsQuery("anything at all", "— ??? —")).toBe(false);
  });
});

describe("pickSplitWinner (deterministic consolidation target)", () => {
  it("picks the better average position first, regardless of volume", () => {
    const pages = [
      { url: "https://b.example/weak", impressions90d: 500, avgPosition: 14 },
      { url: "https://a.example/strong", impressions90d: 30, avgPosition: 9 },
    ];
    expect(pickSplitWinner(pages)).toBe("https://a.example/strong");
  });

  it("breaks position ties by impressions (more evidence wins)", () => {
    const pages = [
      { url: "https://b.example", impressions90d: 30, avgPosition: 12 },
      { url: "https://a.example", impressions90d: 500, avgPosition: 12 },
    ];
    expect(pickSplitWinner(pages)).toBe("https://a.example");
  });

  it("breaks full ties lexicographically — a TOTAL order, never random", () => {
    const pages = [
      { url: "https://b.example", impressions90d: 50, avgPosition: 12 },
      { url: "https://a.example", impressions90d: 50, avgPosition: 12 },
    ];
    expect(pickSplitWinner(pages)).toBe("https://a.example");
  });

  it("does not mutate the input array (callers reuse it for the fixPayload)", () => {
    const pages = [
      { url: "https://b.example", impressions90d: 50, avgPosition: 12 },
      { url: "https://a.example", impressions90d: 50, avgPosition: 9 },
    ];
    const before = [...pages].map((p) => p.url);
    pickSplitWinner(pages);
    expect(pages.map((p) => p.url)).toEqual(before);
  });

  it("returns an empty string for no pages (callers skip the finding)", () => {
    expect(pickSplitWinner([])).toBe("");
  });
});

describe("detector floors", () => {
  it("are positive, finite numbers (env can override; defaults must be sane)", () => {
    expect(SPLIT_MIN_IMPRESSIONS_90D).toBeGreaterThan(0);
    expect(PIN_MIN_IMPRESSIONS_90D).toBeGreaterThan(0);
    expect(DEAD_MAX_TOTAL_IMPRESSIONS).toBeGreaterThan(0);
  });

  it("split floor sits at or below the pin floor (splits are diagnosable on less volume)", () => {
    expect(SPLIT_MIN_IMPRESSIONS_90D).toBeLessThanOrEqual(PIN_MIN_IMPRESSIONS_90D);
  });
});

describe("hygieneNoteLine — the 'under sprint notes' PDF line (§E)", () => {
  it("all-zero → null: the PDF omits silence (F8)", () => {
    expect(hygieneNoteLine({ split: 0, folded: 0, pin: 0, dead: 0 })).toBeNull();
  });

  it("counts render per family, singular/plural honest", () => {
    const line = hygieneNoteLine({ split: 2, folded: 1, pin: 0, dead: 3 }) ?? "";
    expect(line).toContain("2 keyword-split candidates");
    expect(line).toContain("1 folded page ·");
    expect(line).toContain("3 zero-traction pages");
    expect(line).not.toContain("ranker");
  });
});
