import { describe, it, expect } from "vitest";
import { runLayer1 } from "./layer1";
import type { StyleProfile } from "../types";

/**
 * Layer 1C (punctuation) and 1D (tag whitelist) ran on the raw HTML string
 * before T23. Both are now parser-backed and text-node scoped, because the
 * string versions corrupted the markup they were meant to clean: the em-dash
 * rule stamped " ,  " into prose AND into href/title attributes, the <br>
 * strip welded words together, the unwrap pass left one <div> per nesting
 * level behind (and exempted it from the unknown-tag scan), and every
 * disallowed heading collapsed to the first allowed level, inverting the
 * outline.
 */
function profile(overrides: Partial<StyleProfile> = {}): StyleProfile {
  return {
    blogId: "test",
    nicheKey: "generic",
    subNicheId: 1,
    voiceId: 1,
    skeletonId: 1,
    cadenceId: 1,
    quirks: [],
    schemaId: 1,
    tagSetId: 2,
    citationStyleId: 4,
    structuralPool: [1],
    compliancePhraseIds: [],
    compliancePlacement: "BOTTOM",
    wordBandMin: 0,
    wordBandMax: 10_000_000,
    scrubberStrictness: "loose",
    primaryCompounds: [],
    secondaryCompounds: [],
    ...overrides,
  } as StyleProfile;
}

describe("layer 1C — punctuation", () => {
  it("consumes the whitespace around an em dash", () => {
    const out = runLayer1(
      "<p>The dose was raised — slowly — over six weeks.</p>",
      profile(),
    );
    expect(out.content).toContain("raised, slowly, over six weeks.");
    expect(out.content).not.toContain(" ,  ");
    expect(out.fixesApplied).toContain("em_dash_replaced");
  });

  it("leaves attribute values alone", () => {
    const out = runLayer1(
      '<p><a href="https://x.test/a—b" title="Study — 2024">Study — 2024</a></p>',
      profile(),
    );
    expect(out.content).toContain('href="https://x.test/a—b"');
    expect(out.content).toContain(">Study, 2024<");
  });

  it("keeps unspaced en dash ranges", () => {
    const out = runLayer1("<p>Studied 1990–1995 in depth.</p>", profile());
    expect(out.content).toContain("1990–1995");
  });

  it("does not rewrite text inside <code> or <pre>", () => {
    const out = runLayer1(
      "<p><code>a — b</code> and x — y</p>",
      profile(),
    );
    expect(out.content).toContain("<code>a — b</code>");
    expect(out.content).toContain("x, y");
  });

  it("is byte-identical for a body with nothing to fix", () => {
    const clean = "<p>One plain sentence.</p>";
    expect(runLayer1(clean, profile()).content).toBe(clean);
  });
});

describe("layer 1D — tags", () => {
  it("replaces <br> with a space instead of welding words", () => {
    const out = runLayer1("<p>line one<br>line two</p>", profile());
    expect(out.content).toContain("line one line two");
    expect(out.content).not.toContain("oneline");
  });

  it("unwraps nested wrappers completely", () => {
    const out = runLayer1(
      '<div class="wrap"><div class="inner"><p>hello</p></div></div>',
      profile(),
    );
    expect(out.content).toBe("<p>hello</p>");
    expect(out.violations.some((v) => v.loc === "tag_div")).toBe(false);
  });

  it("maps a disallowed heading to the NEAREST allowed level", () => {
    const out = runLayer1(
      "<h2>A</h2><h3>B</h3><h4>C</h4><h5>D</h5><h6>E</h6>",
      profile({ tagSetId: 2 }),
    );
    expect(out.content).toBe("<h2>A</h2><h3>B</h3><h3>C</h3><h3>D</h3><h3>E</h3>");
  });

  it("maps upward as well as downward (tag set 10 has no h2)", () => {
    const out = runLayer1("<h2>A</h2><h3>B</h3><h5>C</h5>", profile({ tagSetId: 10 }));
    expect(out.content).toBe("<h3>A</h3><h3>B</h3><h4>C</h4>");
  });

  it("preserves heading attributes through the remap", () => {
    const out = runLayer1('<h4 id="anchor">C</h4>', profile({ tagSetId: 2 }));
    expect(out.content).toBe('<h3 id="anchor">C</h3>');
  });

  it("reports a tag that is genuinely not on the whitelist", () => {
    const out = runLayer1("<p>a</p><table></table>", profile());
    expect(out.violations.some((v) => v.loc === "tag_table")).toBe(true);
  });

  it("keeps a headerless blog terminal when a heading appears", () => {
    const out = runLayer1("<h2>A</h2><p>b</p>", profile({ tagSetId: 6 }));
    expect(out.terminal).toBe(true);
    expect(
      out.violations.some((v) => v.kind === "structural_mismatch_headerless"),
    ).toBe(true);
  });
});