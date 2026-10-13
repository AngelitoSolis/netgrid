// S4 DoD tests — deterministic output, character caps, version math, the
// no-invented-facts guarantee, and the paste parser's honest gaps. The pure
// composer is the generator; the async builder is its thin DB composition.

import { describe, expect, it } from "vitest";
import {
  buildAttributePack,
  buildDescriptionPack,
  buildPhotosPack,
  buildPostsPack,
  buildReviewsPack,
  buildServicesPack,
  clampDescription,
  composeGbpPacks,
  GBP_DESCRIPTION_MAX_CHARS,
  GBP_POSTS_COUNT,
  mergeCompetitorProfile,
  NOT_PROVIDED_SHORT,
  parseCompetitorPaste,
  rotationDueFromVersions,
  summarizeGbpPacksForAppendix,
  type GbpFacts,
} from "./gbp-packs";

const FROM = new Date("2026-09-25T00:00:00Z");

const facts = (over: Partial<GbpFacts> = {}): GbpFacts => ({
  businessName: "Acme Plumbing",
  businessModel: "Family-run plumbing and heating outfit",
  differentiators: ["24/7 emergency callout", "Written quotes before any work"],
  places: ["Melbourne", "Geelong", "Ballarat", "Ararat"],
  services: [
    { serviceKey: "drain cleaning", display: "Drain Cleaning", priority: 1 },
    { serviceKey: "roof repair", display: "Roof Repair", priority: 2 },
  ],
  servicePages: new Map([["drain cleaning", "https://acme.example/drain-cleaning-melbourne"]]),
  ctaUrl: "https://acme.example",
  competitors: [
    {
      name: "Joe's Plumbing",
      category: "Plumber",
      attributes: ["Wheelchair accessible", "24/7 emergency callout", "Online estimates"],
      services: [{ name: "Drain cleaning", price: "$120" }],
      description: "Family-run since 2009",
      reviewCount: 142,
      reviews: [
        { date: "2026-08-01", rating: 5 },
        { date: "2026-08-12", rating: 4 },
      ],
      photos: 38,
      photosPerMonth: 3,
    },
  ],
  ...over,
});

describe("composeGbpPacks — determinism (DoD)", () => {
  it("same facts + same instant → byte-identical packs", () => {
    const a = composeGbpPacks(facts(), FROM);
    const b = composeGbpPacks(facts(), FROM);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("every one of the seven packs is present", () => {
    const packs = composeGbpPacks(facts(), FROM);
    for (const key of ["categories", "attributes", "services", "description", "posts", "photos", "reviews"] as const) {
      expect(packs[key]).toBeDefined();
    }
  });
});

describe("no invented facts (DoD) — every fact token traces to the input corpus", () => {
  it("packs never mention a place or service that is not in the facts", () => {
    const f = facts();
    const packs = composeGbpPacks(f, FROM);
    const corpus = JSON.stringify(packs);
    // Tokens that would prove invention:
    expect(corpus).not.toContain("Sydney");
    expect(corpus).not.toContain("Bendigo");
    expect(corpus).not.toContain("pool cleaning");
  });

  it("a removed fact disappears from the output (sensitivity check)", () => {
    const withoutBallarat = facts({ places: ["Melbourne", "Geelong", "Ararat"] });
    expect(JSON.stringify(composeGbpPacks(withoutBallarat, FROM))).not.toContain("Ballarat");
  });

  it("missing facts render the ask-on-call line, never a guess", () => {
    const packs = composeGbpPacks(facts({ businessName: null, businessModel: null, places: [] }), FROM);
    const corpus = JSON.stringify(packs);
    expect(corpus).toContain(NOT_PROVIDED_SHORT);
  });
});

describe("description A/B — 750-char cap + rotation (DoD)", () => {
  it("both versions respect the cap, before insert", () => {
    const { versions } = buildDescriptionPack(facts(), FROM);
    expect(versions).toHaveLength(2);
    for (const v of versions) {
      expect(v.chars).toBeLessThanOrEqual(GBP_DESCRIPTION_MAX_CHARS);
      expect(v.body.length).toBe(v.chars);
    }
  });

  it("clampDescription cuts at a sentence boundary and never exceeds the cap", () => {
    const long = "First sentence is here. ".repeat(60);
    const clamped = clampDescription(long);
    expect(clamped.length).toBeLessThanOrEqual(GBP_DESCRIPTION_MAX_CHARS);
    expect(clamped.endsWith(".")).toBe(true);
    expect(clamped).toContain("First sentence is here.");
  });

  it("rotation schedule is 30 days apart, deterministic in the passed instant", () => {
    const { versions } = buildDescriptionPack(facts(), FROM);
    expect(versions[0].rotateOn).toBe("2026-10-25T00:00:00.000Z");
    expect(versions[1].rotateOn).toBe("2026-11-24T00:00:00.000Z");
  });

  it("measurement states no signal until real brand-query data exists (F8)", () => {
    expect(buildDescriptionPack(facts(), FROM).measurement).toBe("no measurable signal yet");
  });
});

describe("posts calendar — 8 weekly slots with the 4-week area rule", () => {
  it("8 posts, weekly cadence, hooks within 100 chars", () => {
    const { posts } = buildPostsPack(facts(), FROM);
    expect(posts).toHaveLength(GBP_POSTS_COUNT);
    for (const post of posts) {
      expect(post.hook.length).toBeLessThanOrEqual(100);
      expect(post.body.length).toBeLessThanOrEqual(1500);
    }
    expect(new Date(posts[1].publishOn).getTime() - new Date(posts[0].publishOn).getTime()).toBe(
      7 * 86_400_000,
    );
  });

  it("no area repeats within 4 consecutive slots when ≥4 real places exist", () => {
    const { posts } = buildPostsPack(facts(), FROM);
    for (let i = 0; i < posts.length; i++) {
      const window = posts.slice(Math.max(0, i - 3), i).map((p) => p.area);
      expect(window).not.toContain(posts[i].area);
    }
  });

  it("fewer than 4 real places → the payload says so honestly (never invented areas)", () => {
    const { posts, areaRotationNote } = buildPostsPack(facts({ places: ["Melbourne"] }), FROM);
    expect(areaRotationNote).toContain("cannot hold");
    expect(posts.every((p) => p.area === "Melbourne")).toBe(true);
  });

  it("targetUrl comes only from real published pages (service page first, real site CTA as fallback)", () => {
    const { posts } = buildPostsPack(facts(), FROM);
    expect(posts[0].targetUrl).toBe("https://acme.example/drain-cleaning-melbourne");
    expect(posts[1].targetUrl).toBe("https://acme.example");
  });
});

describe("attributes — the diff never marks an unverifiable attribute as true", () => {
  it("ours keep; competitor-only attrs ask on call", () => {
    const rows = buildAttributePack(facts());
    const keep = rows.filter((r) => r.verdict === "keep").map((r) => r.attribute);
    const ask = rows.filter((r) => r.verdict === "cannot verify — ask on call").map((r) => r.attribute);
    expect(keep).toEqual(["24/7 emergency callout", "Written quotes before any work"]);
    expect(ask).toEqual(["Online estimates", "Wheelchair accessible"]); // alphabetical
  });
});

describe("services — every real service gets a description + the cross-check gap", () => {
  it("each service description is 40-60 words, fact-templated", () => {
    const { items } = buildServicesPack(facts());
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.words).toBeGreaterThanOrEqual(40);
      expect(item.words).toBeLessThanOrEqual(60);
      expect(item.gbpDescription).toContain(item.service);
    }
  });

  it("the client's own GBP side of the cross-check is an honest gap, not a competitor stand-in", () => {
    const { crossCheck } = buildServicesPack(facts());
    expect(crossCheck.onWebsiteMissingOnGbp).toEqual(["Drain Cleaning", "Roof Repair"]);
    expect(crossCheck.onGbpMissingOnWebsite).toEqual([NOT_PROVIDED_SHORT]);
  });
});

describe("photos — honest audit + velocity-plus-one target", () => {
  it("target beats competitor velocity by one; queue follows the filename convention", () => {
    const { target, queue } = buildPhotosPack(facts(), FROM);
    expect(target).toBe("Publish 4 photos per month — competitor velocity plus one.");
    expect(queue[0]).toMatch(/^service-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.jpg$/);
    expect(queue).toHaveLength(12);
  });

  it("no competitor photo data → honest gap, no invented target", () => {
    const { audit, target } = buildPhotosPack(facts({ competitors: [] }), FROM);
    expect(audit).toContain(NOT_PROVIDED_SHORT);
    expect(target).toContain(NOT_PROVIDED_SHORT);
  });
});

describe("reviews — bands ≤80 words, no discounts, real-business sign-off", () => {
  it("three bands, each within the word cap, signed by the operator-confirmed name", () => {
    const { bands, sla } = buildReviewsPack(facts());
    expect(bands.map((b) => b.band)).toEqual(["5-star", "4-star", "3-star and below"]);
    for (const band of bands) {
      expect(band.words).toBeLessThanOrEqual(80);
      expect(band.template.endsWith("— Acme Plumbing")).toBe(true);
      expect(band.template.toLowerCase()).not.toContain("discount");
    }
    expect(sla).toContain("24 hours");
  });
});

describe("paste parsing — paste-friendly, honest gaps", () => {
  it("parses the labeled format including a bare review list", () => {
    const parsed = parseCompetitorPaste(
      [
        "name: Joe's Plumbing",
        "category: Plumber",
        "attributes: Wheelchair accessible, Online estimates",
        "services: Drain cleaning $120 | Water heater repair",
        "description: Family-run since 2009",
        "review count: 142",
        "reviews:",
        "2026-08-01, 5",
        "2026-08-12, 4",
        "photos: 38",
        "photos per month: 3",
      ].join("\n"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("Joe's Plumbing");
    expect(parsed!.services).toEqual([
      { name: "Drain cleaning", price: "$120" },
      { name: "Water heater repair", price: null },
    ]);
    expect(parsed!.reviews).toEqual([
      { date: "2026-08-01", rating: 5 },
      { date: "2026-08-12", rating: 4 },
    ]);
    expect(parsed!.photos).toBe(38);
    expect(parsed!.photosPerMonth).toBe(3);
  });

  it("an unnamed paste is rejected; missing fields stay null/[] — never invented", () => {
    expect(parseCompetitorPaste("category: Plumber")).toBeNull();
    const parsed = parseCompetitorPaste("name: someone");
    expect(parsed!.category).toBeNull();
    expect(parsed!.services).toEqual([]);
    expect(parsed!.reviewCount).toBeNull();
  });
});

describe("versioning — insert-only semantics (DoD)", () => {
  it("merge replaces the same-named competitor, appends new ones, caps the list", () => {
    const first = mergeCompetitorProfile([], parseCompetitorPaste("name: A\ncategory: one")!);
    const second = mergeCompetitorProfile(first, parseCompetitorPaste("name: a\ncategory: two")!);
    expect(second).toHaveLength(1);
    expect(second[0].category).toBe("two");
    const third = mergeCompetitorProfile(second, parseCompetitorPaste("name: B")!);
    expect(third.map((c) => c.name)).toEqual(["a", "B"]);
  });
});

describe("rotationDueFromVersions — the §E weekly rotation check", () => {
  const day = (n: number) => new Date(FROM.getTime() + n * 86_400_000);
  const v = (version: number, createdAt: Date, appliedAt: Date | null) => ({
    version,
    createdAt,
    appliedAt,
  });

  it("no versions → an honest null state, never 'due'", () => {
    expect(rotationDueFromVersions([], FROM)).toEqual({
      liveVersion: null,
      daysLive: null,
      due: false,
      nextVersion: null,
    });
  });

  it("live version under 30 days → not due", () => {
    const res = rotationDueFromVersions(
      [v(1, day(-10), day(-10)), v(2, day(-10), null)],
      FROM,
    );
    expect(res.due).toBe(false);
    expect(res.liveVersion).toBe(1);
    expect(res.nextVersion).toBe(2);
  });

  it("live ≥30 days with an unapplied alternate → due, naming the next version", () => {
    const res = rotationDueFromVersions(
      [v(1, day(-40), day(-30)), v(2, day(-40), null)],
      FROM,
    );
    expect(res.due).toBe(true);
    expect(res.daysLive).toBeGreaterThanOrEqual(30);
    expect(res.nextVersion).toBe(2);
  });

  it("live ≥30 days but nothing to rotate to → NOT due (never nags without an alternate)", () => {
    const res = rotationDueFromVersions([v(1, day(-90), day(-90))], FROM);
    expect(res.due).toBe(false);
    expect(res.nextVersion).toBeNull();
  });

  it("the latest APPLIED version is live even when a newer row exists", () => {
    const res = rotationDueFromVersions(
      [v(1, day(-10), day(-10)), v(2, day(-2), null)],
      FROM,
    );
    expect(res.liveVersion).toBe(1);
    expect(res.daysLive).toBe(10);
  });
});

describe("summarizeGbpPacksForAppendix — sent packs only (§E PDF column)", () => {
  it("keeps ONLY sent_to_client rows; ready packs never reach the client PDF", () => {
    const res = summarizeGbpPacksForAppendix([
      {
        assetType: "categories",
        status: "ready",
        createdAt: FROM,
        payload: {
          primary: { gbpCategory: "operator-picked GBP category for: Drain Cleaning" },
          secondary: [{ gbpCategory: "for: Emergency Plumber" }],
        },
      },
      {
        assetType: "reviews",
        status: "sent_to_client",
        createdAt: FROM,
        payload: {
          bands: [{ band: "5-star" }, { band: "4-star" }, { band: "3-star and below" }],
          sla: "First response within 24 hours of any review.",
        },
      },
    ]);
    expect(res.packs.map((p) => p.title)).toEqual(["Review responses"]);
    expect(res.packs[0].lines[0]).toContain("3 review-response templates");
    expect(res.packs[0].lines[1]).toContain("24 hours");
  });

  it("malformed payloads degrade to an honest line, never a throw", () => {
    const res = summarizeGbpPacksForAppendix([
      { assetType: "photos", status: "sent_to_client", createdAt: FROM, payload: null },
    ]);
    expect(res.packs).toHaveLength(1);
    expect(res.packs[0].lines).toEqual([NOT_PROVIDED_SHORT]);
  });

  it("carries the latest sent date when provided", () => {
    const res = summarizeGbpPacksForAppendix([
      { assetType: "description", status: "sent_to_client", createdAt: "2026-09-01T00:00:00Z", payload: {} },
      { assetType: "posts", status: "sent_to_client", createdAt: "2026-09-20T00:00:00Z", payload: {} },
    ]);
    expect(res.latestSentOn).toBe("2026-09-20");
  });
});