import { describe, it, expect, vi } from "vitest";

// content-generator imports @/lib/actions/news-actions, a "use server" module
// that transitively pulls in next-auth. Mock it (and the telemetry recorder)
// so the pure parsing helpers can be exercised without that graph.
vi.mock("@/lib/actions/news-actions", () => ({
  takeNewsContextForVertical: vi.fn(),
  formatNewsContextForPrompt: vi.fn(),
  getRecentNewsForVerticalInternal: vi.fn(),
}));
vi.mock("@/lib/services/run-telemetry", () => ({
  recordPipelineError: vi.fn(),
  bumpCounter: vi.fn(),
  bumpProvider: vi.fn(),
}));

const { safeParseClaudeJsonWithTier, safeParseClaudeJson } = await import(
  "./content-generator"
);

/**
 * The tier is what the truncation gate in generateContent keys on. Before T06
 * a "truncation" parse was published as-is: repairTruncatedJson closes the
 * open string and brackets, so the object parses but the body ends
 * mid-sentence. Getting this classification wrong in either direction is
 * expensive — a false "truncation" fails a good article, a missed one
 * publishes a fragment.
 */

const COMPLETE = JSON.stringify({
  title: "A Complete Article",
  content: "<p>First paragraph.</p><p>Second paragraph.</p>",
  excerpt: "Summary.",
});

describe("safeParseClaudeJsonWithTier — clean input", () => {
  it("reports tier 'none' for valid JSON", () => {
    const r = safeParseClaudeJsonWithTier<{ title: string }>(COMPLETE);
    expect(r.tier).toBe("none");
    expect(r.value.title).toBe("A Complete Article");
  });

  it("does not classify a complete document as truncated", () => {
    expect(safeParseClaudeJsonWithTier(COMPLETE).tier).not.toBe("truncation");
  });
});

describe("safeParseClaudeJsonWithTier — repairs that are NOT truncation", () => {
  // NOTE: markdown fences are NOT this function's job — callClaudeOnce and
  // callDeepSeekOnce both run extractJsonObject() before handing text over,
  // so the parser only ever sees a bare object.

  it("repairs smart quotes without claiming truncation", () => {
    const smart = '{\u201Ctitle\u201D:\u201CA Complete Article\u201D}';
    const r = safeParseClaudeJsonWithTier<{ title: string }>(smart);
    expect(r.value.title).toBe("A Complete Article");
    expect(r.tier).not.toBe("truncation");
  });

  it("repairs a trailing comma without claiming truncation", () => {
    const r = safeParseClaudeJsonWithTier<{ a: number }>('{"a":1,}');
    expect(r.value.a).toBe(1);
    expect(r.tier).not.toBe("truncation");
  });

  it("escapes stray attribute quotes without claiming truncation", () => {
    // An unescaped quote inside an HTML attribute — a complete document that
    // needs a lossless repair, not a salvage.
    const raw = '{"content":"<a href="https://x.test">link</a>","title":"T"}';
    const r = safeParseClaudeJsonWithTier<{ title: string }>(raw);
    expect(r.tier).not.toBe("truncation");
    expect(r.value.title).toBe("T");
  });
});

describe("safeParseClaudeJsonWithTier — genuine truncation", () => {
  it("flags a document cut off mid-string", () => {
    // The exact failure mode: the model hit max_tokens partway through the
    // body, so the string and the object are both left open.
    const cut =
      '{"title":"Where to Buy Peptides","content":"<p>The first paragraph is complete.</p><p>The second one stops mid-sen';
    const r = safeParseClaudeJsonWithTier<{ title: string; content: string }>(
      cut,
    );
    expect(r.tier).toBe("truncation");
    // The salvage still yields a readable title — that is its only purpose.
    expect(r.value.title).toBe("Where to Buy Peptides");
  });

  it("flags a document cut off between fields", () => {
    const cut = '{"title":"T","content":"<p>Body.</p>",';
    expect(safeParseClaudeJsonWithTier(cut).tier).toBe("truncation");
  });

  it("flags a truncated nested array", () => {
    const cut = '{"title":"T","keywords":["one","two","thr';
    expect(safeParseClaudeJsonWithTier(cut).tier).toBe("truncation");
  });
});

describe("safeParseClaudeJson — the back-compatible wrapper", () => {
  it("returns the value and drops the tier", () => {
    expect(safeParseClaudeJson<{ title: string }>(COMPLETE).title).toBe(
      "A Complete Article",
    );
  });

  it("still throws on input no tier can rescue", () => {
    expect(() => safeParseClaudeJson("not json at all")).toThrow();
  });

  it("agrees with the tiered parser on the parsed value", () => {
    const a = safeParseClaudeJson<{ title: string }>(COMPLETE);
    const b = safeParseClaudeJsonWithTier<{ title: string }>(COMPLETE).value;
    expect(a).toEqual(b);
  });
});

/**
 * T23 moved word counting and the cap into @/lib/content/html-utils, which is
 * now the single implementation the generator, the cap and the scrubber's
 * Layer 1F band check all share. What is left here is the delegation itself
 * (parity between this number and the scrubber's) and injectMoneyLink, which
 * used to corrupt the paragraph it was linking from.
 */
const { countWordsInHtml, injectMoneyLink } = await import(
  "./content-generator"
);

describe("countWordsInHtml — the one counter", () => {
  it("counts visible words only, not markup", () => {
    expect(countWordsInHtml("<p>one two three</p>")).toBe(3);
    expect(countWordsInHtml("<ul><li>a</li><li>b</li></ul>")).toBe(2);
  });

  it("is zero for markup with no text", () => {
    expect(countWordsInHtml("<p></p><br/>")).toBe(0);
  });

  it("agrees with the shared counter that capWordCount enforces against", async () => {
    const { capWordCount, countHtmlWords } = await import(
      "@/lib/content/html-utils"
    );
    const html =
      '<ul><li><a href="https://x.test" target="_blank" rel="nofollow">one two</a></li>' +
      "<li>three four</li><li>five six</li></ul>";
    // 6 visible words despite a link carrying two extra attribute tokens.
    expect(countWordsInHtml(html)).toBe(6);
    expect(countWordsInHtml(html)).toBe(countHtmlWords(html));
    // Against a 6-word cap there is nothing to do — byte-identical.
    expect(capWordCount(html, 6)).toBe(html);
  });
});

const URL_ = "https://shop.test/p";

/**
 * injectMoneyLink built its replacement with String.replace(pInner, newInner).
 * Even with a STRING pattern, replace() interprets $$, $&, $` and $' in the
 * replacement — and the replacement is built from the article's own prose — so
 * "$&" in a paragraph duplicated that whole paragraph into itself. It also
 * patched the first occurrence of the paragraph text ANYWHERE in the body, so
 * a heading above it with the same wording received the money link.
 */
describe("injectMoneyLink", () => {
  it("does not interpret $-sequences in the paragraph text", () => {
    const body = "<p>Codes like $& and $` appear in retinol guides.</p>";
    const out = injectMoneyLink(body, URL_, ["retinol"]);
    expect(out).toContain("Codes like $& and $` appear in");
    expect(out.match(/Codes like/g)?.length).toBe(1);
    expect(out).toContain(">retinol</a>");
  });

  it("keeps $$ intact", () => {
    const out = injectMoneyLink("<p>Costs $$ per gram of retinol.</p>", URL_, [
      "retinol",
    ]);
    expect(out).toContain("Costs $$ per gram");
  });

  it("patches the paragraph, not an identical heading above it", () => {
    const body = "<h2>Buy peptides safely</h2><p>Buy peptides safely</p>";
    const out = injectMoneyLink(body, URL_, ["peptides"]);
    expect(out).toContain("<h2>Buy peptides safely</h2>");
    expect(out).toContain('<p>Buy <a href="https://shop.test/p"');
  });

  it("skips a term that only occurs inside an attribute", () => {
    const body = '<p><em title="peptides">See the guide.</em></p>';
    expect(injectMoneyLink(body, URL_, ["peptides"])).toBe(body);
  });

  it("still links a real occurrence after an attribute-only hit", () => {
    const body = '<p><em title="retinol">Overview.</em> Buy retinol today.</p>';
    const out = injectMoneyLink(body, URL_, ["retinol"]);
    expect(out).toContain('<em title="retinol">Overview.</em>');
    expect(out).toContain(">retinol</a> today.");
  });

  it("adds nothing when the opening paragraph already links out", () => {
    const body = '<p>See <a href="https://x.test">the guide</a> on retinol.</p>';
    expect(injectMoneyLink(body, URL_, ["retinol"])).toBe(body);
  });

  it("leaves a body with no <p> alone", () => {
    const body = "<h2>Only a heading</h2>";
    expect(injectMoneyLink(body, URL_, ["heading"])).toBe(body);
  });

  it("ignores a non-http destination", () => {
    const body = "<p>Buy retinol today.</p>";
    expect(injectMoneyLink(body, "javascript:alert(1)", ["retinol"])).toBe(body);
  });
});
