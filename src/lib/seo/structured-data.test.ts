import { describe, it, expect } from "vitest";
import {
  buildArticleGraph,
  buildPostBodyGraph,
  buildFaqPage,
  buildBreadcrumbList,
  renderJsonLdScript,
  renderManagedJsonLdBlock,
  upsertManagedBlock,
  stripManagedBlock,
  schemaMarkerToken,
  htmlMarkers,
  normalizeFaqItems,
  extractFaqFromHtml,
  hasFaqSection,
  renderFaqSection,
  normalizeOrigin,
  siteIdentityForBlog,
  authorIdentityFrom,
  personId,
  orgId,
  LEGACY_HTML_START,
  LEGACY_HTML_END,
  MIN_FAQ_ITEMS,
  type SiteIdentity,
} from "./structured-data";

const site: SiteIdentity = {
  origin: "https://example.com",
  name: "Example",
  logoUrl: null,
};

const article = {
  url: "https://example.com/blog/post",
  headline: "How to store BPC-157",
  description: "What the storage literature actually says.",
  datePublished: "2026-01-01T00:00:00Z",
};

describe("normalizeOrigin", () => {
  it("keeps scheme + host and drops path and trailing slash", () => {
    expect(normalizeOrigin("https://example.com/blog/")).toBe("https://example.com");
    expect(normalizeOrigin("example.com")).toBe("https://example.com");
    expect(normalizeOrigin("  http://a.example.com/x?y=1 ")).toBe("http://a.example.com");
  });
  it("is empty for empty input", () => {
    expect(normalizeOrigin("")).toBe("");
  });
});

describe("renderJsonLdScript — script breakout", () => {
  // This is a correctness requirement, not tidiness. JSON-LD sits inside a
  // <script> element, which the HTML tokenizer treats as RAW TEXT: the first
  // literal "</script" anywhere inside — including inside a JSON string —
  // ends the element and everything after it becomes markup.
  it("cannot be broken out of by a hostile headline", () => {
    const doc = buildArticleGraph({
      site,
      article: { ...article, headline: 'Bad </script><img src=x onerror=alert(1)>' },
    });
    const html = renderJsonLdScript(doc);
    expect(html).not.toContain("</script><img");
    // Exactly one closing tag: the real one at the end.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c");
  });

  it("still parses back to the same data after escaping", () => {
    const doc = buildArticleGraph({
      site,
      article: { ...article, headline: "A & B <C>" },
    });
    const json = renderJsonLdScript(doc)
      .replace(/^<script type="application\/ld\+json">/, "")
      .replace(/<\/script>$/, "")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0026/g, "&");
    expect(JSON.parse(json)["@graph"][1].name).toBe("A & B <C>");
  });
});

describe("buildArticleGraph", () => {
  it("is a connected @graph, not four loose objects", () => {
    const doc = buildArticleGraph({ site, article });
    const types = doc["@graph"].map((n) => n["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebPage");
    expect(types).toContain("Article");
    expect(types).toContain("BreadcrumbList");

    const art = doc["@graph"].find((n) => n["@type"] === "Article")!;
    expect(art.publisher).toEqual({ "@id": orgId(site.origin) });
    expect(art.isPartOf).toEqual({ "@id": "https://example.com/blog/post#webpage" });
  });

  it("makes the Organization the author when no person is on file", () => {
    // Honest. The alternative — inventing a Person — is the defect T12 removed.
    const doc = buildArticleGraph({ site, article });
    const art = doc["@graph"].find((n) => n["@type"] === "Article")!;
    expect(art.author).toEqual({ "@id": orgId(site.origin) });
    expect(doc["@graph"].some((n) => n["@type"] === "Person")).toBe(false);
  });

  it("references a real author by a stable @id so two posts merge to one entity", () => {
    const mk = (url: string) =>
      buildArticleGraph({
        site,
        article: { ...article, url },
        author: { name: "Jane Doe", url: "https://example.com/author/jane" },
      });
    const a = mk("https://example.com/blog/one");
    const b = mk("https://example.com/blog/two");
    const idA = (a["@graph"].find((n) => n["@type"] === "Person")!)["@id"];
    const idB = (b["@graph"].find((n) => n["@type"] === "Person")!)["@id"];
    expect(idA).toBe(idB);
    expect(idA).toBe(personId(site.origin, "Jane Doe"));
  });

  it("omits rather than invents: no logo, no data: image, no empty sameAs", () => {
    const doc = buildArticleGraph({
      site,
      article: { ...article, imageUrl: "data:image/png;base64,AAAA" },
      author: { name: "Jane Doe", sameAs: [] },
    });
    const org = doc["@graph"].find((n) => n["@type"] === "Organization")!;
    const person = doc["@graph"].find((n) => n["@type"] === "Person")!;
    const art = doc["@graph"].find((n) => n["@type"] === "Article")!;
    expect(org.logo).toBeUndefined();
    expect(person.sameAs).toBeUndefined();
    expect(art.image).toBeUndefined();
  });

  it("defaults dateModified to datePublished rather than leaving it absent", () => {
    const art = buildArticleGraph({ site, article })["@graph"].find(
      (n) => n["@type"] === "Article",
    )!;
    expect(art.dateModified).toBe(article.datePublished);
  });

  it("truncates the headline to Google's displayed limit", () => {
    const long = "x".repeat(200);
    const art = buildArticleGraph({ site, article: { ...article, headline: long } })[
      "@graph"
    ].find((n) => n["@type"] === "Article")!;
    expect((art.headline as string).length).toBe(110);
  });
});

describe("buildFaqPage", () => {
  const two = [
    { question: "Does it need refrigeration?", answer: "Yes, once reconstituted." },
    { question: "How long does it last?", answer: "Weeks, not months." },
  ];

  it("needs at least MIN_FAQ_ITEMS to be worth emitting", () => {
    expect(MIN_FAQ_ITEMS).toBe(2);
    expect(buildFaqPage([two[0]])).toBeNull();
    expect(buildFaqPage(two)).not.toBeNull();
  });

  it("drops blank pairs before counting", () => {
    expect(buildFaqPage([two[0], { question: "  ", answer: "x" }])).toBeNull();
  });
});

describe("buildBreadcrumbList", () => {
  it("leaves the final crumb without an item, so it is valid before publish", () => {
    // "No item on the last element" is how schema.org says "you are here" —
    // which is what lets a breadcrumb be built before the platform has
    // returned the post's URL.
    const bc = buildBreadcrumbList(site, "My Post", null);
    const items = bc.itemListElement as Array<Record<string, unknown>>;
    expect(items[items.length - 1].item).toBeUndefined();
    expect(items[items.length - 1].name).toBe("My Post");
    expect(bc["@id"]).toBeUndefined();
  });

  it("adds the blog index crumb when the site has one", () => {
    const bc = buildBreadcrumbList(
      { ...site, blogUrl: "https://example.com/blog", blogName: "Blog" },
      "My Post",
      "https://example.com/blog/post",
    );
    const items = bc.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[1].name).toBe("Blog");
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
  });
});

describe("buildPostBodyGraph", () => {
  it("returns null when there would be nothing to emit", () => {
    // Callers must then leave the body alone rather than ship an empty script.
    expect(
      buildPostBodyGraph({ site, pageTitle: "t", faq: [], includeBreadcrumb: false }),
    ).toBeNull();
  });

  it("emits FAQ + breadcrumb without an Article node", () => {
    const doc = buildPostBodyGraph({
      site,
      pageTitle: "t",
      faq: [
        { question: "Q one here?", answer: "A one here, long enough." },
        { question: "Q two here?", answer: "A two here, long enough." },
      ],
    })!;
    const types = doc["@graph"].map((n) => n["@type"]);
    expect(types).toContain("FAQPage");
    expect(types).toContain("BreadcrumbList");
    // No second Article next to whatever the theme/Yoast already emits.
    expect(types).not.toContain("Article");
  });
});

describe("managed block", () => {
  const token = schemaMarkerToken("https://example.com");

  it("derives a stable per-site token, and different sites differ", () => {
    expect(schemaMarkerToken("https://example.com")).toBe(token);
    expect(schemaMarkerToken("example.com")).toBe(token);
    expect(schemaMarkerToken("https://other.com")).not.toBe(token);
    expect(token).toMatch(/^[0-9a-f]{8}$/);
  });

  it("carries no vendor name — that is the point of the token", () => {
    const { start, end } = htmlMarkers(token);
    expect(start).not.toMatch(/netgrid/i);
    expect(end).not.toMatch(/netgrid/i);
  });

  it("is idempotent: re-running replaces instead of stacking", () => {
    const doc = buildPostBodyGraph({ site, pageTitle: "t" })!;
    const block = renderManagedJsonLdBlock(doc, token);
    const once = upsertManagedBlock("<p>body</p>", block, token);
    const twice = upsertManagedBlock(once, block, token);
    expect(twice).toBe(once);
    expect(twice.match(/application\/ld\+json/g)).toHaveLength(1);
  });

  it("migrates a legacy branded block out of the live page", () => {
    const doc = buildPostBodyGraph({ site, pageTitle: "t" })!;
    const block = renderManagedJsonLdBlock(doc, token);
    const legacyBody = `<p>x</p>${LEGACY_HTML_START}<script>old</script>${LEGACY_HTML_END}`;
    const out = upsertManagedBlock(legacyBody, block, token);
    expect(out).not.toContain(LEGACY_HTML_START);
    expect(out).not.toContain("netgrid-seo");
    expect(out).toContain(htmlMarkers(token).start);
  });

  it("strips both current and legacy blocks", () => {
    const doc = buildPostBodyGraph({ site, pageTitle: "t" })!;
    const body = upsertManagedBlock("<p>x</p>", renderManagedJsonLdBlock(doc, token), token);
    expect(stripManagedBlock(body, token)).not.toContain("application/ld+json");
  });
});

describe("FAQ plumbing", () => {
  it("normalises the shapes seen in the wild and caps the answer", () => {
    const items = normalizeFaqItems(
      [
        { question: "Does it need refrigeration", answer: "Yes it does, once reconstituted." },
        { q: "How long does it last", a: "Weeks rather than months, per the label." },
        { question: "short", answer: "too short" },
        null,
      ],
      { maxAnswerWords: 3 },
    );
    expect(items).toHaveLength(2);
    // A missing question mark is added, so the Question node reads as one.
    expect(items[0].question.endsWith("?")).toBe(true);
    expect(items[0].answer.endsWith("…")).toBe(true);
  });

  it("dedupes repeated questions, which would be invalid FAQPage markup", () => {
    const items = normalizeFaqItems([
      { question: "Is it legal here?", answer: "That depends on the jurisdiction." },
      { question: "IS IT LEGAL HERE?", answer: "Different wording, same question." },
    ]);
    expect(items).toHaveLength(1);
  });

  it("round-trips through the rendered section, so markup matches visible text", () => {
    // The markup must never claim an answer the reader cannot see — that is
    // the most common cause of a structured-data manual action.
    const items = [
      { question: "Does it need refrigeration?", answer: "Yes, once reconstituted it does." },
      { question: "How long does it last?", answer: "Weeks rather than months." },
    ];
    const html = `<p>intro</p>${renderFaqSection(items, "Frequently asked questions")}`;
    expect(hasFaqSection(html)).toBe(true);
    const back = extractFaqFromHtml(html);
    expect(back.map((i) => i.question)).toEqual(items.map((i) => i.question));
    expect(back.map((i) => i.answer)).toEqual(items.map((i) => i.answer));
  });

  it("escapes HTML in the rendered section", () => {
    const html = renderFaqSection(
      [{ question: "A <b>bold</b> question?", answer: "An & answer that is long enough." }],
      "FAQ",
    );
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
  });

  it("finds no FAQ in a body that has none", () => {
    expect(hasFaqSection("<h2>Background</h2><p>x</p>")).toBe(false);
    expect(extractFaqFromHtml("<h2>Background</h2><p>x</p>")).toEqual([]);
  });

  it("recognises a French Q/A heading", () => {
    expect(hasFaqSection("<h2>Questions fréquentes</h2><p>x</p>")).toBe(true);
  });
});

describe("identity adapters", () => {
  it("prefers the brand name, falling back to the domain", () => {
    expect(siteIdentityForBlog({ domain: "example.com", brandName: "Acme" }).name).toBe("Acme");
    expect(siteIdentityForBlog({ domain: "example.com" }).origin).toBe("https://example.com");
  });

  it("returns null for no author, so the graph falls back to Organization", () => {
    expect(authorIdentityFrom(null)).toBeNull();
    expect(authorIdentityFrom({ name: "   " })).toBeNull();
  });

  it("keeps only absolute third-party sameAs URLs", () => {
    const id = authorIdentityFrom({
      name: "Jane",
      sameAs: ["https://linkedin.com/in/jane", "not-a-url", ""],
    })!;
    expect(id.sameAs).toEqual(["https://linkedin.com/in/jane"]);
  });
});
