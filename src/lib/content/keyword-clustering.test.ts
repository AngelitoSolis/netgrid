import { describe, it, expect } from "vitest";
import {
  clusterKeyFor,
  clusterKeywords,
  normalizeForClustering,
} from "./keyword-clustering";
import type { ActiveClientKeyword } from "./client-keywords";

/** Minimal ranked row; clusterKeywords only reads `keyword`. */
function row(keyword: string, winnability = 1): ActiveClientKeyword {
  return {
    keyword,
    searchVolume: null,
    source: "google_autocomplete",
    keywordDifficulty: null,
    competition: null,
    winnability,
  };
}

describe("normalizeForClustering", () => {
  it("fuses compound identifiers however they are spelled", () => {
    expect(normalizeForClustering("BPC-157 Dosage")).toBe("bpc157 dosage");
    expect(normalizeForClustering("bpc 157 dosage")).toBe("bpc157 dosage");
    expect(normalizeForClustering("TB 500 vs BPC 157")).toBe("tb500 vs bpc157");
  });

  it("folds accents", () => {
    expect(normalizeForClustering("Peptides Montréal")).toBe("peptides montreal");
  });
});

describe("clusterKeyFor", () => {
  it("collapses the buying-query variants Autocomplete generates", () => {
    // This is the doorway pattern: five phrasings of one query became five
    // separate articles on the same site about the same thing.
    const variants = [
      "best place to buy peptides",
      "where to buy peptides",
      "peptides for sale",
      "buy peptides online",
      "peptides price",
    ];
    const keys = new Set(variants.map(clusterKeyFor));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("transactional|peptide");
  });

  it("keeps a different intent in its own cluster", () => {
    // "peptides" informational is a genuinely different post from
    // "buy peptides" — stripping qualifiers alone would have merged them.
    expect(clusterKeyFor("peptides")).not.toBe(clusterKeyFor("buy peptides"));
  });

  it("keeps a meaningful geo modifier", () => {
    expect(clusterKeyFor("peptides canada")).not.toBe(clusterKeyFor("peptides"));
  });

  it("treats spaced and hyphenated compounds as the same cluster", () => {
    expect(clusterKeyFor("bpc 157 dosage")).toBe(clusterKeyFor("bpc-157 dosage"));
  });

  it("does NOT merge posts that are genuinely about different things", () => {
    // A calculator page is a different article from a dosage explainer.
    expect(clusterKeyFor("bpc-157 dosage")).not.toBe(
      clusterKeyFor("bpc-157 dosage calculator"),
    );
    // Words that change what the article is about must not be stripped.
    expect(clusterKeyFor("peptide reviews")).not.toBe(clusterKeyFor("peptides"));
    expect(clusterKeyFor("peptide side effects")).not.toBe(clusterKeyFor("peptides"));
  });

  it("never degenerates to an empty key on an all-qualifier query", () => {
    // "where to buy" is nothing BUT stopwords and qualifiers. An empty
    // residual would make it swallow every other cluster.
    const key = clusterKeyFor("where to buy");
    expect(key).not.toBe("transactional|");
    expect(key.split("|")[1].length).toBeGreaterThan(0);
  });

  it("folds plurals", () => {
    expect(clusterKeyFor("peptide dosage")).toBe(clusterKeyFor("peptides dosage"));
  });
});

describe("clusterKeywords", () => {
  it("keeps the FIRST (best-ranked) member as the representative", () => {
    const clusters = clusterKeywords([
      row("where to buy peptides", 9),
      row("peptides for sale", 8),
      row("buy peptides online", 7),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].representative.keyword).toBe("where to buy peptides");
    expect(clusters[0].variants).toEqual(["peptides for sale", "buy peptides online"]);
  });

  it("preserves input order across clusters, so best-first survives", () => {
    const clusters = clusterKeywords([
      row("buy peptides", 9),
      row("peptide side effects", 8),
      row("peptides for sale", 7),
    ]);
    expect(clusters.map((c) => c.representative.keyword)).toEqual([
      "buy peptides",
      "peptide side effects",
    ]);
    expect(clusters[0].variants).toContain("peptides for sale");
  });

  it("turns N near-duplicates into ONE target", () => {
    const rows = [
      "buy peptides",
      "buy peptides online",
      "where to buy peptides",
      "peptides for sale",
      "best place to buy peptides",
      "cheap peptides online",
    ].map((k) => row(k));
    const clusters = clusterKeywords(rows);
    expect(clusters).toHaveLength(1);
    // Every phrasing is still covered — as secondary keywords on one post.
    expect(clusters[0].variants).toHaveLength(rows.length - 1);
  });

  it("does not list the representative among its own variants", () => {
    const clusters = clusterKeywords([row("buy peptides"), row("buy peptides")]);
    expect(clusters[0].variants).toEqual([]);
  });

  it("returns [] for an empty pool", () => {
    expect(clusterKeywords([])).toEqual([]);
  });
});
