import { describe, expect, it } from "vitest";
import {
  buildDossierContextBlock,
  dossierFreshnessFromRows,
  DOSSIER_CONTEXT_TOKEN_BUDGET,
  NOT_PROVIDED,
  type DossierView,
} from "./client-dossier";

// S6 (Client SEO dossier) — pure-builder DoD tests. The merged READ is thin SQL
// with per-section fail-safes; the DECISIONS live in buildDossierContextBlock:
//   - byte-stable for a fixture dossier (deterministic, no timestamps inside);
//   - ≤ ~1200 tokens by construction, truncation order competitor → wins →
//     audience → area; differentiators and business_model never truncate;
//   - missing facts render as NOT_PROVIDED, gaps printed as gaps (F3/F8).

function fixture(overrides?: Partial<DossierView>): DossierView {
  return {
    clientId: "client-1",
    started: true,
    businessModel: "Family plumbers — 24/7 emergency call-outs, own trucks.",
    serviceArea: ["Downtown", "Riverside"],
    differentiators: ["Licensed & insured since 1998"],
    audience: null,
    competitors: [],
    recentWins: [],
    gaps: null,
    lastVerifiedAt: null,
    staleWarning: null,
    siteProfiles: [],
    topLivePairs: [
      {
        query: "drain cleaning old town",
        page: "/blog/x",
        impressions90d: 210,
        clicks90d: 5,
        avgPosition: 14.2,
      },
    ],
    openIssueCounts: {},
    ...overrides,
  };
}

describe("buildDossierContextBlock — byte stability (hard S6 DoD)", () => {
  it("is deterministic: same view in → identical string out", () => {
    const view = fixture({ audience: "Homeowners with burst pipes at midnight." });
    expect(buildDossierContextBlock(view)).toBe(buildDossierContextBlock(view));
  });

  it("leaks no timestamps: lastVerifiedAt changes do not change the block", () => {
    const a = buildDossierContextBlock(fixture({ lastVerifiedAt: "2026-01-01T00:00:00.000Z" }));
    const b = buildDossierContextBlock(fixture({ lastVerifiedAt: "2026-09-01T00:00:00.000Z" }));
    expect(a).toBe(b);
  });

  it("renders the staleness warning line only when pre-computed by the reader", () => {
    const fresh = buildDossierContextBlock(fixture());
    const stale = buildDossierContextBlock(
      fixture({
        staleWarning:
          "WARNING: this dossier was last verified more than 90 days ago — treat its facts as possibly stale and confirm material claims with the operator.",
      }),
    );
    expect(fresh).not.toContain("WARNING");
    expect(stale).toContain("possibly stale");
  });
});

describe("buildDossierContextBlock — honesty (F3/F8)", () => {
  it("renders every missing fact as NOT_PROVIDED, never a guess", () => {
    const block = buildDossierContextBlock(
      fixture({ businessModel: null, differentiators: [], audience: null }),
    );
    expect(block).toContain(`BUSINESS MODEL:\n${NOT_PROVIDED}`);
    expect(block).toContain(`DIFFERENTIATORS:\n${NOT_PROVIDED}`);
  });

  it("says explicitly when the dossier has not been started", () => {
    const block = buildDossierContextBlock(fixture({ started: false }));
    expect(block).toContain("DOSSIER NOT STARTED");
  });

  it("prints gaps as gaps; 'none recorded' is a valid state, not an error", () => {
    expect(buildDossierContextBlock(fixture())).toContain("none recorded");
    const withGaps = buildDossierContextBlock(
      fixture({ gaps: "No review history provided\nPricing unconfirmed" }),
    );
    expect(withGaps).toContain("No review history provided");
  });

  it("honest no-data state for live search data", () => {
    const block = buildDossierContextBlock(fixture({ topLivePairs: [] }));
    expect(block).toContain("no Search Console data in the trailing window");
  });

  it("renders live pairs with a stable one-decimal position", () => {
    const block = buildDossierContextBlock(fixture());
    expect(block).toContain('"drain cleaning old town" @ position 14.2 (210 impressions)');
  });

describe("buildDossierContextBlock — budget + truncation order (hard S6 DoD)", () => {
  const charBudget = DOSSIER_CONTEXT_TOKEN_BUDGET * 4; // ~4800 chars by default

  /** Deterministic filler of ~`target` chars so each section has real weight. */
  function big(seed: string, target = 1600): string {
    let s = "";
    while (s.length < target) s += seed + " ";
    return s.trim();
  }

  it("drops whole sections in the order competitor → wins → audience → area", () => {
    // Hand-computed against the default budget (~4800 chars, core ≈ 500):
    // competitors ≈ 3290, wins ≈ 1627, audience ≈ 1612, area ≈ 3275.
    //   all four      → ~10300 (over)
    //   − competitors → ~7000  (still over)
    //   − wins        → ~5400  (still over)
    //   − audience    → ~3800  (under budget → stop; AREA survives as tier 4)
    const view = fixture({
      competitors: [
        { name: big("Competitor A"), category: "plumber" },
        { name: big("Competitor B"), category: "drainage" },
      ],
      recentWins: [big("Rescued query X from position 14 to 7")],
      audience: big("Homeowners with burst pipes at midnight comparing three quotes."),
      serviceArea: [big("Downtown core and the river district"), big("North side suburbs")],
    });

    const block = buildDossierContextBlock(view);

    expect(block).not.toContain("COMPETITOR PROFILES");
    expect(block).not.toContain("RECENT WINS");
    expect(block).not.toContain("AUDIENCE:");
    expect(block).toContain("SERVICE AREA (real places only)");
    expect(block.length).toBeLessThanOrEqual(charBudget);
  });

  it("drops audience before service area when only the earlier tier is oversized", () => {
    // Audience alone at ~4600 pushes core+area+audience over budget; the drop
    // order marks null competitors/wins first (no-ops) and cuts AUDIENCE while
    // SERVICE AREA — the last tier — stays.
    const view = fixture({
      audience: big("Homeowners with burst pipes at midnight comparing three quotes.", 4600),
    });
    const block = buildDossierContextBlock(view);
    expect(block).not.toContain("AUDIENCE:");
    expect(block).toContain("SERVICE AREA (real places only)");
    expect(block.length).toBeLessThanOrEqual(charBudget);
  });

  it("NEVER truncates business_model or differentiators (pathological core kept whole)", () => {
    const hugeModel = big("24/7 emergency plumbing, own trucks, no subcontractors.", 4500);
    const block = buildDossierContextBlock(fixture({ businessModel: hugeModel }));
    // Core alone exceeds the budget — documented behavior is to keep it all.
    expect(block).toContain(hugeModel);
  });

  it("a small fixture always fits under the budget", () => {
    const block = buildDossierContextBlock(fixture());
    expect(block.length).toBeLessThanOrEqual(charBudget);
  });
});
});

describe("dossierFreshnessFromRows — the §E weekly stale-dossier counter", () => {
  const NOW = new Date("2026-09-25T00:00:00Z");
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("boundary: exactly 90 days is still fresh; 91 is stale ('stale (>90d)')", () => {
    const res = dossierFreshnessFromRows(
      [{ lastVerifiedAt: day(90) }, { lastVerifiedAt: day(91) }],
      2,
      NOW,
    );
    expect(res.verified).toBe(1);
    expect(res.stale).toBe(1);
  });

  it("a missing or unparseable stamp counts as never-verified, never silently fresh", () => {
    const res = dossierFreshnessFromRows(
      [{ lastVerifiedAt: null }, { lastVerifiedAt: "not-a-date" }, { lastVerifiedAt: day(1) }],
      3,
      NOW,
    );
    expect(res.neverVerified).toBe(2);
    expect(res.verified).toBe(1);
  });

  it("clients without a dossier row are covered by the total-client floor", () => {
    const res = dossierFreshnessFromRows([{ lastVerifiedAt: day(1) }], 5, NOW);
    expect(res.clients).toBe(5);
    expect(res.neverVerified).toBe(0); // rows only; missing rows show in clients − rows
  });
});
