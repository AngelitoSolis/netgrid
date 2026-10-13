import { describe, it, expect } from "vitest";
import {
  authorSlug,
  isYmylNiche,
  bylineFor,
  authorJsonLdNode,
  YMYL_NICHE_KEYS,
  type BylineContext,
  type ResolvedAuthor,
} from "./author-entity";

function author(over: Partial<ResolvedAuthor> = {}): ResolvedAuthor {
  return {
    id: "a1",
    name: "Jane O'Neill-Smith",
    slug: "jane-o-neill-smith",
    bio: "Writes about tendon rehab research.",
    jobTitle: null,
    photoUrl: null,
    credentials: [],
    sameAs: [],
    authorPageUrl: null,
    wpUserId: null,
    ...over,
  };
}

function ctx(over: Partial<BylineContext> = {}): BylineContext {
  return {
    blogId: "b1",
    clientId: "c1",
    domain: "example.com",
    niche: "roofing",
    author: null,
    fallbackByline: "Example Editorial Team",
    blocked: false,
    ...over,
  };
}

describe("authorSlug", () => {
  it("makes a stable URL-safe handle", () => {
    expect(authorSlug("Jane O'Neill-Smith")).toBe("jane-o-neill-smith");
  });
  it("folds accents", () => {
    expect(authorSlug("Chloé Dubé")).toBe("chloe-dube");
  });
  it("never returns empty", () => {
    expect(authorSlug("!!!")).toBe("author");
    expect(authorSlug("")).toBe("author");
  });
});

describe("isYmylNiche", () => {
  it("covers the five money-or-health niches", () => {
    for (const k of ["peptides", "gambling", "online_casino", "loans", "tax_lawyer"]) {
      expect(isYmylNiche(k), k).toBe(true);
    }
    expect(YMYL_NICHE_KEYS.size).toBe(5);
  });

  it("normalises spacing and case the way the niche keys are written", () => {
    expect(isYmylNiche("Online Casino")).toBe(true);
    expect(isYmylNiche("tax-lawyer")).toBe(true);
    expect(isYmylNiche("  PEPTIDES ")).toBe(true);
  });

  it("does not sweep in ordinary niches", () => {
    for (const k of ["roofing", "web_dev", "restaurants", "", null, undefined]) {
      expect(isYmylNiche(k as string), String(k)).toBe(false);
    }
  });
});

describe("bylineFor", () => {
  it("prefers the real person", () => {
    expect(bylineFor(ctx({ author: author() }))).toBe("Jane O'Neill-Smith");
  });

  it("falls back to an honest organisational byline, never an invented person", () => {
    // The thing this replaces hashed the store handle over a table of 900
    // invented names. "Example Editorial Team" claims no personal expertise
    // and is true.
    expect(bylineFor(ctx())).toBe("Example Editorial Team");
  });
});

describe("authorJsonLdNode", () => {
  it("emits an Organization when there is no author on file", () => {
    const node = authorJsonLdNode(ctx());
    expect(node["@type"]).toBe("Organization");
    expect(node.name).toBe("Example Editorial Team");
    // Crucially NOT a Person — an invented Person is the defect.
    expect(node["@type"]).not.toBe("Person");
  });

  it("emits a resolvable Person when there is", () => {
    const node = authorJsonLdNode(
      ctx({
        author: author({
          authorPageUrl: "https://example.com/author/jane",
          jobTitle: "Staff writer",
          photoUrl: "https://example.com/jane.jpg",
          sameAs: ["https://linkedin.com/in/jane"],
        }),
      }),
    );
    expect(node["@type"]).toBe("Person");
    // The three properties that let an entity be RESOLVED rather than
    // discarded: something to key on, somewhere to go, corroboration.
    expect(node["@id"]).toBe("https://example.com/author/jane#person");
    expect(node.url).toBe("https://example.com/author/jane");
    expect(node.sameAs).toEqual(["https://linkedin.com/in/jane"]);
    expect(node.jobTitle).toBe("Staff writer");
  });

  it("omits @id and url when no author page exists yet", () => {
    // Degrades rather than emitting a dangling identifier.
    const node = authorJsonLdNode(ctx({ author: author() }));
    expect(node["@type"]).toBe("Person");
    expect(node["@id"]).toBeUndefined();
    expect(node.url).toBeUndefined();
  });

  it("emits credentials only as documented qualifications", () => {
    const node = authorJsonLdNode(
      ctx({ author: author({ credentials: ["BSc Biochemistry"] }) }),
    );
    expect(node.hasCredential).toEqual([
      { "@type": "EducationalOccupationalCredential", name: "BSc Biochemistry" },
    ]);
  });

  it("omits hasCredential entirely when there are none", () => {
    // An empty array is the correct value for most authors; emitting an empty
    // hasCredential would imply the question was asked and answered.
    expect(authorJsonLdNode(ctx({ author: author() })).hasCredential).toBeUndefined();
  });
});
