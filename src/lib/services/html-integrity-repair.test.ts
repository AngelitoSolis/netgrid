import { describe, it, expect } from "vitest";
import {
  countSuspectedBrWelds,
  hasUnbalancedTags,
  repairPunctuationArtifacts,
  repairStructure,
} from "./html-integrity-repair";

/**
 * The repair pass exists because the T23 defects shipped for months before
 * they were found, so the damage is already in published bodies. Three of the
 * six defects can be undone on an existing post; three destroyed information
 * (the space a <br> occupied, the original heading depth, the text a $&
 * replacement overwrote) and can only be regenerated.
 */

describe("repairPunctuationArtifacts", () => {
  it("undoes the space-before-comma and double-space-after-comma artifact", () => {
    const broken = "<p>The dose was raised ,  slowly ,  over six weeks.</p>";
    expect(repairPunctuationArtifacts(broken)).toBe(
      "<p>The dose was raised, slowly, over six weeks.</p>",
    );
  });

  it("is idempotent", () => {
    const once = repairPunctuationArtifacts("<p>raised ,  slowly.</p>");
    expect(repairPunctuationArtifacts(once)).toBe(once);
  });

  it("returns the input unchanged when there is no artifact", () => {
    const clean = "<p>Bullets, commas and colons: all fine.</p>";
    expect(repairPunctuationArtifacts(clean)).toBe(clean);
  });

  it("leaves French pre-colon spacing alone", () => {
    // Only the COMMA is normalized — FR typography spaces ; : ! ?
    const fr = "<p>Attention : ceci est un test ; rien de plus !</p>";
    expect(repairPunctuationArtifacts(fr)).toBe(fr);
  });

  it("does not rewrite markup or <code> content", () => {
    const html = '<p><code>a ,  b</code> and <a href="/x?a ,  b">link</a> text.</p>';
    const out = repairPunctuationArtifacts(html);
    expect(out).toContain("<code>a ,  b</code>");
    expect(out).toContain('href="/x?a ,  b"');
  });
});

describe("hasUnbalancedTags", () => {
  it("detects the exact truncation the old cap produced", () => {
    const cut = "<p>one two</p>\n<h2>Heading here</h2>\n<ul>\n<li>alpha ";
    expect(hasUnbalancedTags(cut)).toBe(true);
  });

  it("accepts balanced markup", () => {
    expect(hasUnbalancedTags("<p>a</p><ul><li>b</li></ul>")).toBe(false);
  });

  it("does not confuse <picture> with <p>", () => {
    expect(hasUnbalancedTags("<picture><source src=x></picture>")).toBe(false);
  });
});

describe("repairStructure", () => {
  it("closes everything the cut left open", () => {
    const out = repairStructure("<ul>\n<li>alpha beta.</li>\n<li>gamma ");
    expect(out).toMatch(/<\/li><\/ul>$/);
    expect(hasUnbalancedTags(out)).toBe(false);
  });

  it("is byte-identical when the body is already balanced", () => {
    const balanced = '<p>a</p><ul><li>b</li></ul><p>c <a href="/x">d</a></p>';
    expect(repairStructure(balanced)).toBe(balanced);
  });

  it("idempotent: a second pass changes nothing", () => {
    const once = repairStructure("<ul><li>alpha ");
    expect(repairStructure(once)).toBe(once);
  });
});

describe("countSuspectedBrWelds", () => {
  it("counts the lowercase→uppercase welds a deleted <br> leaves behind", () => {
    // The detector keys on a CamelCase junction, so it sees "theStudy" (the
    // old strip of "the<br>Study") and "netGrid". A weld that joins two
    // lowercase runs — "line oneline two" — is invisible to it, which is why
    // this is a RANKING for regeneration and not a verdict.
    expect(countSuspectedBrWelds("<p>Read theStudy today.</p>")).toBe(1);
    expect(countSuspectedBrWelds("<p>Welcome to netGrid.</p>")).toBe(1);
  });

  it("does not fire on ordinary prose", () => {
    expect(countSuspectedBrWelds("<p>line one line two</p>")).toBe(0);
    expect(countSuspectedBrWelds("<p>One sentence. Then another one.</p>")).toBe(0);
  });
});