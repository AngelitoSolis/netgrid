import { describe, it, expect } from "vitest";
import {
  detectKeywordIntent,
  containsWord,
  shouldApplyLocalFraming,
  keywordNamesAnyCity,
  isEligibleKeywordTarget,
  buildKeywordTargetTitle,
} from "./keyword-targeting";

describe("detectKeywordIntent — substring misfires", () => {
  // Every one of these was reproducible before the word-boundary fix. The
  // consequence was not cosmetic: intent picks the title template, so
  // "sleep disorder treatment" became "Where to Buy Sleep Disorder Treatment
  // in Montreal: Pricing & Availability" — a page that lies about what it
  // contains. After T09 intent also gates whether the city is used at all.
  const cases: Array<[keyword: string, wrongSignal: string]> = [
    ["sleep disorder treatment", "order"],
    ["costume jewelry cleaning", "cost"],
    ["workshop safety training", "shop"],
    ["asbestos removal guide", "best"],
    ["laptop screen repair", "top"],
  ];

  for (const [keyword, signal] of cases) {
    it(`classifies "${keyword}" as informational despite the embedded "${signal}"`, () => {
      expect(detectKeywordIntent(keyword)).toBe("informational");
    });
  }

  it("still detects the signals when they are real words", () => {
    expect(detectKeywordIntent("buy peptides online")).toBe("transactional");
    expect(detectKeywordIntent("peptides for sale")).toBe("transactional");
    expect(detectKeywordIntent("peptides near me")).toBe("transactional");
    expect(detectKeywordIntent("bpc 157 vs tb 500")).toBe("comparison");
    expect(detectKeywordIntent("best peptide supplier")).toBe("comparison");
  });

  it("handles digit-bearing and hyphenated terms as whole words", () => {
    expect(containsWord("bpc-157 dosage", "bpc-157")).toBe(true);
    expect(containsWord("laptop repair", "top")).toBe(false);
    expect(containsWord("for sale now", "for sale")).toBe(true);
  });
});

describe("shouldApplyLocalFraming", () => {
  it("requires BOTH transactional intent and a real local presence", () => {
    expect(shouldApplyLocalFraming("buy peptides", true)).toBe(true);
    // A real business, but the query is not geographically variable.
    expect(shouldApplyLocalFraming("peptide side effects", true)).toBe(false);
    // A commercial query, but the client has no local presence — a city page
    // here is the doorway pattern the task exists to stop.
    expect(shouldApplyLocalFraming("buy peptides", false)).toBe(false);
    expect(shouldApplyLocalFraming("peptide side effects", false)).toBe(false);
  });

  it("does not city-frame a misclassified informational keyword", () => {
    // The substring bug would have made this transactional, and therefore
    // city-framed, for a client with local presence.
    expect(shouldApplyLocalFraming("sleep disorder treatment", true)).toBe(false);
  });
});

describe("keywordNamesAnyCity", () => {
  it("matches a city by word, not by substring", () => {
    expect(keywordNamesAnyCity("peptides montreal", ["Montreal"])).toBe(true);
    // "Bar" must not match "barbell".
    expect(keywordNamesAnyCity("barbell training", ["Bar"])).toBe(false);
  });

  it("keeps a commercially valuable keyword when an ambiguous city word is incidental", () => {
    // "Sale" as a city would otherwise delete every "X for sale" keyword —
    // and "for sale" is itself a transactional signal, so that one collision
    // removes the most valuable class of target the client has.
    expect(keywordNamesAnyCity("peptides for sale", ["Sale"])).toBe(false);
    expect(keywordNamesAnyCity("mobile peptide delivery", ["Mobile"])).toBe(false);
    expect(keywordNamesAnyCity("nice cream recipes", ["Nice"])).toBe(false);
  });

  it("still matches an ambiguous city word used locatively", () => {
    expect(keywordNamesAnyCity("peptides in sale", ["Sale"])).toBe(true);
    expect(keywordNamesAnyCity("peptide delivery near mobile", ["Mobile"])).toBe(true);
  });

  it("folds accents so Montréal and Montreal are the same city", () => {
    expect(keywordNamesAnyCity("peptides montréal", ["Montreal"])).toBe(true);
    expect(keywordNamesAnyCity("peptides montreal", ["Montréal"])).toBe(true);
  });

  it("ignores two-letter noise rather than shredding the pool", () => {
    expect(keywordNamesAnyCity("peptide guide", ["ON"])).toBe(false);
  });

  it("feeds isEligibleKeywordTarget", () => {
    expect(isEligibleKeywordTarget("peptides for sale", ["Sale"])).toBe(true);
    expect(isEligibleKeywordTarget("peptides montreal", ["Montreal"])).toBe(false);
  });
});

describe("buildKeywordTargetTitle", () => {
  it("names the city when local framing is on", () => {
    const t = buildKeywordTargetTitle("buy peptides", "Montreal");
    expect(t).toContain("Montreal");
  });

  it("never names the city when local framing is off", () => {
    for (const kw of [
      "buy peptides",
      "peptide side effects",
      "bpc 157 vs tb 500",
      "sleep disorder treatment",
    ]) {
      const t = buildKeywordTargetTitle(kw, "Montreal", { localFraming: false });
      expect(t, `"${kw}" leaked the city into a non-local title`).not.toContain("Montreal");
      expect(t).not.toContain("{city}");
      expect(t).not.toContain("{k}");
    }
  });

  it("still varies by city so sibling blogs do not publish identical titles", () => {
    // The city stays in the hash seed even when it is absent from the output.
    const a = buildKeywordTargetTitle("buy peptides", "Montreal", { localFraming: false });
    const b = buildKeywordTargetTitle("buy peptides", "Toronto", { localFraming: false });
    const c = buildKeywordTargetTitle("buy peptides", "Vancouver", { localFraming: false });
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it("is deterministic across rebuilds", () => {
    expect(buildKeywordTargetTitle("buy peptides", "Montreal")).toBe(
      buildKeywordTargetTitle("buy peptides", "Montreal"),
    );
  });
});
