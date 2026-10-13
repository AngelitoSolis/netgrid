// Keyword clustering — folds Google Autocomplete's near-duplicate "alphabet
// soup" variants into ONE ledger target before each of them can become its
// own near-identical post.
//
// The scraper deliberately queries every seed with a-z appended
// (keyword-scraper.ts), which is exactly how you discover long-tail phrasing
// — and exactly how you end up with "buy peptides", "buy peptides online",
// "where to buy peptides" and "peptides for sale" as four separate rows. One
// post per row is doorway generation; one post per CLUSTER, targeting every
// phrasing in it, is the same coverage without the spam pattern.
//
// Dependency-free and pure apart from the opt-in embedding pass at the
// bottom, so it is unit-testable with no database and no network.
import type { ActiveClientKeyword } from "@/lib/content/client-keywords";
import {
  detectKeywordIntent,
  normalizeTargetKeyword,
  type KeywordIntent,
} from "@/lib/content/keyword-targeting";
import {
  embeddingsConfigured,
  generateEmbeddings,
} from "@/lib/services/embeddings-client";

// Function words. English + French, since a blog can be either (see
// content/language.ts). Mirrors topic-similarity.ts's list, extended with the
// query-shaped words Autocomplete produces.
const STOPWORDS = new Set([
  // English
  "a", "an", "the", "for", "to", "in", "of", "and", "or", "how", "much",
  "what", "is", "are", "your", "you", "with", "on", "at", "by", "from",
  "vs", "versus", "which", "when", "why", "do", "does", "can", "should",
  "this", "that", "it", "as", "be", "not", "my", "there", "any",
  // French
  "le", "la", "les", "de", "des", "du", "au", "aux", "en", "pour", "et",
  "ou", "comment", "combien", "votre", "vous", "avec", "sur", "est",
  "sont", "que", "qui", "quel", "quelle", "un", "une", "dans",
  "ce", "cette",
]);

// Purely commercial / positional qualifiers. Stripping these is what makes
// near-duplicate BUYING queries collapse together. Deliberately tight: a word
// that changes what the ARTICLE would be about (review, legit, safe, dosage,
// side effects) must NOT be here, or genuinely different posts would merge.
const COMMERCIAL_QUALIFIERS = new Set([
  // English
  "buy", "buying", "purchase", "purchasing", "order", "ordering",
  "shop", "shopping", "sale", "price", "pricing", "cost", "cheap",
  "cheapest", "discount", "deal", "online", "near", "nearby", "me",
  "where", "place", "site", "store", "shipping", "delivery",
  "affordable", "best", "top",
  // French
  "acheter", "achat", "prix", "cher", "commander", "livraison",
  "meilleur", "meilleure", "boutique", "magasin", "ligne",
]);

/** Crude but safe English singulariser — enough to fuse plural variants. */
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Lowercase, de-accent, and reduce a keyword to spaced alphanumerics, fusing
 * compound identifiers so their spellings agree:
 *   "BPC-157 Dosage"  -> "bpc157 dosage"
 *   "bpc 157 dosage"  -> "bpc157 dosage"
 *   "Peptides Montréal" -> "peptides montreal"
 */
export function normalizeForClustering(keyword: string): string {
  return normalizeTargetKeyword(keyword)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // hyphen/slash/underscore/dot between alphanumerics: bpc-157 -> bpc157
    .replace(/(?<=[a-z0-9])[-/_.](?=[a-z0-9])/g, "")
    // short letter-run + digit-run separated by a space: tb 500 -> tb500
    .replace(/\b([a-z]{2,4}) (\d{2,4})\b/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The significant tokens of a normalised keyword. Three-stage fallback so a
 * query made ENTIRELY of qualifiers ("where to buy") never degenerates to an
 * empty key and swallows every other cluster.
 */
function residualTokens(normalized: string): string[] {
  const all = normalized.split(" ").filter(Boolean).map(singularize);
  const core = all.filter(
    (t) => !STOPWORDS.has(t) && !COMMERCIAL_QUALIFIERS.has(t),
  );
  if (core.length > 0) return core;
  const withoutStopwords = all.filter((t) => !STOPWORDS.has(t));
  return withoutStopwords.length > 0 ? withoutStopwords : all;
}

/**
 * The cluster a keyword belongs to. Intent-prefixed on purpose: two keywords
 * with the same topic but different intent ("peptides" vs "buy peptides") are
 * genuinely different posts and must never merge.
 */
export function clusterKeyFor(keyword: string): string {
  const intent = detectKeywordIntent(keyword);
  const tokens = residualTokens(normalizeForClustering(keyword));
  const core = Array.from(new Set(tokens)).sort().join(" ");
  return `${intent}|${core || normalizeTargetKeyword(keyword)}`;
}

export interface KeywordCluster {
  /** Intent-prefixed normalised key — stable across rebuilds. */
  key: string;
  intent: KeywordIntent;
  /** The best-scoring member; the one that becomes the ledger row. */
  representative: ActiveClientKeyword;
  /** Every other phrasing, normalised. Secondary keywords for the post. */
  variants: string[];
}

/**
 * Group already-ranked keyword rows into clusters, preserving input order.
 * `rows` MUST arrive winnability-sorted (topActiveClientKeywordsWithMeta does
 * this) — the first row to claim a key becomes the representative, so input
 * order decides which phrasing the post is written for.
 */
export function clusterKeywords(rows: ActiveClientKeyword[]): KeywordCluster[] {
  const byKey = new Map<string, KeywordCluster>();

  for (const row of rows) {
    const key = clusterKeyFor(row.keyword);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        intent: detectKeywordIntent(row.keyword),
        representative: row,
        variants: [],
      });
      continue;
    }
    const variant = normalizeTargetKeyword(row.keyword);
    const head = normalizeTargetKeyword(existing.representative.keyword);
    if (variant !== head && !existing.variants.includes(variant)) {
      existing.variants.push(variant);
    }
  }

  // Map preserves insertion order, so clusters come back best-first.
  return Array.from(byKey.values());
}

// ─── Optional embedding refinement ──────────────────────────────────────────
//
// The lexical pass above is the product; this is a second, opt-in pass that
// merges clusters whose representatives are semantically the same query but
// share no residual tokens ("peptide sourcing" vs "peptide suppliers"). It
// costs one embeddings call per rebuild, so it is off unless
// KEYWORD_CLUSTER_EMBEDDINGS=1 AND the embeddings client is configured, and it
// degrades to the lexical result on ANY failure — a rebuild must never fail
// because an external API was unavailable.

const EMBEDDING_MERGE_THRESHOLD = 0.92;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function clusterEmbeddingsEnabled(): boolean {
  return process.env.KEYWORD_CLUSTER_EMBEDDINGS === "1" && embeddingsConfigured();
}

/**
 * Merge lexically-distinct clusters whose representatives are semantically
 * near-identical AND share an intent. Returns the input unchanged when
 * disabled, when there is nothing to compare, or on any error.
 */
export async function refineClustersWithEmbeddings(
  clusters: KeywordCluster[],
): Promise<KeywordCluster[]> {
  if (!clusterEmbeddingsEnabled() || clusters.length < 2) return clusters;

  try {
    const vectors = await generateEmbeddings(
      clusters.map((c) => c.representative.keyword),
    );
    const merged: KeywordCluster[] = [];
    const absorbed = new Set<number>();

    for (let i = 0; i < clusters.length; i++) {
      if (absorbed.has(i)) continue;
      const head = clusters[i];
      for (let j = i + 1; j < clusters.length; j++) {
        if (absorbed.has(j)) continue;
        const other = clusters[j];
        if (other.intent !== head.intent) continue;
        if (cosine(vectors[i], vectors[j]) < EMBEDDING_MERGE_THRESHOLD) continue;
        absorbed.add(j);
        const incoming = [
          normalizeTargetKeyword(other.representative.keyword),
          ...other.variants,
        ];
        for (const v of incoming) {
          if (
            v !== normalizeTargetKeyword(head.representative.keyword) &&
            !head.variants.includes(v)
          ) {
            head.variants.push(v);
          }
        }
      }
      merged.push(head);
    }
    return merged;
  } catch (err) {
    console.warn(
      "[keyword-clustering] embedding refinement failed; using lexical clusters only:",
      err instanceof Error ? err.message : err,
    );
    return clusters;
  }
}
