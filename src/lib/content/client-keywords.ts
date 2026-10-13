// No `import "server-only"` here on purpose: every consumer is already a
// "use server" action file or a standalone tsx script (e.g.
// src/lib/db/import-city-assignments.ts), never a client component — Next's
// own "use server" boundary already keeps this out of client bundles. The
// guard actively broke standalone script execution (the real `server-only`
// package throws under plain Node — it only resolves to a no-op under the
// "react-server" export condition Next's bundler sets internally), so it's
// been removed here rather than worked around.
import { db } from "@/lib/db";
import { clientKeywords } from "@/lib/db/schema";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

export interface ActiveClientKeyword {
  keyword: string;
  searchVolume: number | null;
  source: string;
  /** DataForSEO 0-100 organic difficulty. Null on Autocomplete rows. */
  keywordDifficulty: number | null;
  /** DataForSEO 0-1 paid competition. Null on Autocomplete + restricted verticals. */
  competition: number | null;
  /** Computed winnability score for this row — higher is better. */
  winnability: number;
}

/** Optional integer tuning knob from the environment. Falls back on anything unparseable. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Winnability gates. Env-overridable so a market with different economics
// (or an emergency) can be retuned without a deploy — see render.yaml.

/** Measured keywords quieter than this are not worth a post. */
const MIN_SEARCH_VOLUME = envInt("KEYWORD_MIN_VOLUME", 20);
/** Measured head terms louder than this are not winnable on these domains. */
const MAX_SEARCH_VOLUME = envInt("KEYWORD_MAX_VOLUME", 20000);
/** Reject only MEASURED difficulty above this. NULL difficulty is never rejected. */
const MAX_KEYWORD_DIFFICULTY = envInt("KEYWORD_MAX_DIFFICULTY", 35);
/** Difficulty a row is SCORED at when its difficulty is unknown (most rows). */
const NEUTRAL_KEYWORD_DIFFICULTY = envInt("KEYWORD_NEUTRAL_DIFFICULTY", 45);
/** Below this many gated survivors, fall back to the ungated pool. */
const MIN_CANDIDATES = envInt("KEYWORD_MIN_CANDIDATES", 5);

// NOTE ON THE REGEX BELOW: '\\s+' in TypeScript source produces the SQL
// literal '\s+'. Writing '\s+' here would produce 's+' (JS drops the unknown
// escape), and regexp_split_to_array would silently split on the letter s —
// wrong word counts, no error. Keep the double backslash.
const wordCount = sql`greatest(coalesce(array_length(regexp_split_to_array(btrim(${clientKeywords.keyword}), '\\s+'), 1), 1), 1)`;

/** 0 = this row has real measured volume, 1 = Autocomplete proxy only. */
const evidenceTier = sql`case when ${clientKeywords.searchVolume} is null then 1 else 0 end`;

/**
 * Winnability — magnitude, discounted by how hard the term is and how
 * commercially contested it is, bonused for long-tail specificity. Higher is
 * better. Kept as one inspectable SQL expression so the same formula can be
 * pasted into psql to explain any ordering decision.
 *
 * Behaviour at low DataForSEO coverage, which is the situation the approved
 * budget produces for most of the network: an Autocomplete-only row has NULL
 * volume, NULL difficulty and NULL competition, so the difficulty and
 * competition factors are the SAME CONSTANT for every such row and cancel out
 * of their relative order. Within that population the ranking reduces to
 * log(hit_count) x long-tail bonus — still a large improvement on the pure
 * popularity sort it replaces, and it degrades in exactly the direction you
 * want as real difficulty data arrives for a growing slice of the pool.
 */
const winnability = sql`(
  (case
     when ${clientKeywords.searchVolume} is not null then ln(1 + ${clientKeywords.searchVolume}::numeric)
     else ln(1 + ${clientKeywords.hitCount}::numeric)
   end)
  * (1 - least(greatest(coalesce(${clientKeywords.keywordDifficulty}, ${NEUTRAL_KEYWORD_DIFFICULTY}::int), 0), 100)::numeric / 100)
  * (1 - 0.25 * least(greatest(coalesce(${clientKeywords.competition}, 0.5), 0), 1)::numeric)
  * (1 + 0.12 * least(greatest(${wordCount} - 2, 0), 4)::numeric)
)`;

/** Reject measured volume outside the winnable band. NULL volume always passes. */
const volumeBand = sql`(
  ${clientKeywords.searchVolume} is null
  or (${clientKeywords.searchVolume} >= ${MIN_SEARCH_VOLUME}::int
      and ${clientKeywords.searchVolume} <= ${MAX_SEARCH_VOLUME}::int)
)`;

/** Reject measured difficulty above the ceiling. NULL difficulty always passes. */
const difficultyGate = sql`(
  ${clientKeywords.keywordDifficulty} is null
  or ${clientKeywords.keywordDifficulty} <= ${MAX_KEYWORD_DIFFICULTY}::int
)`;

/** One ranked read of the pool with the supplied extra gates applied. */
function rankedQuery(clientId: string, limit: number, gates: SQL[]) {
  return db
    .select({
      keyword: clientKeywords.keyword,
      searchVolume: clientKeywords.searchVolume,
      source: clientKeywords.source,
      keywordDifficulty: clientKeywords.keywordDifficulty,
      // numeric columns come back as strings over the wire; cast so callers
      // get real numbers and never have to Number() a maybe-null string.
      competition: sql<number | null>`${clientKeywords.competition}::double precision`,
      winnability: sql<number>`${winnability}::double precision`,
    })
    .from(clientKeywords)
    .where(
      and(
        eq(clientKeywords.clientId, clientId),
        eq(clientKeywords.isActive, true),
        ...gates,
      ),
    )
    .orderBy(
      sql`${evidenceTier} asc`,
      sql`${winnability} desc`,
      desc(clientKeywords.hitCount),
      asc(clientKeywords.bestPosition),
      // Final deterministic tiebreak so a rebuild produces a stable order.
      asc(clientKeywords.keyword),
    )
    .limit(limit);
}

/**
 * The most WINNABLE active keyword rows for a client, best first.
 *
 * Ranks by a winnability score (magnitude discounted by difficulty and
 * competition, bonused for long-tail specificity) rather than by raw
 * popularity — the old "search_volume desc, hit_count desc" ordering picked
 * the single hardest term in the client's universe every time.
 *
 * Two passes on purpose. The strict pass applies the volume band and the
 * difficulty ceiling; if that leaves fewer than MIN_CANDIDATES rows the
 * ungated pool is used instead, so a client whose whole corpus sits outside
 * the band degrades to "ranked but ungated" rather than to an empty ledger.
 * Fail-safe to [].
 */
async function activeClientKeywordRows(
  clientId: string,
  limit: number,
): Promise<ActiveClientKeyword[]> {
  try {
    const strict = await rankedQuery(clientId, limit, [volumeBand, difficultyGate]);
    if (strict.length >= MIN_CANDIDATES) return strict;

    const relaxed = await rankedQuery(clientId, limit, []);
    if (relaxed.length > strict.length) {
      console.warn(
        `[client-keywords] winnability gates left ${strict.length} candidate(s) for client ` +
          `${clientId}; falling back to the ungated pool (${relaxed.length}).`,
      );
      return relaxed;
    }
    return strict;
  } catch (err) {
    console.warn(
      `[client-keywords] ranked read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * The most winnable active keywords for a client, best first — merged into
 * the ideation keyword pool by getActiveKnowledgeForBlog so every generated
 * post targets them. Fail-safe to [].
 */
export async function topActiveClientKeywords(
  clientId: string,
  limit = 40,
): Promise<string[]> {
  const rows = await activeClientKeywordRows(clientId, limit);
  return rows.map((r) => r.keyword);
}

/**
 * Same ranking as topActiveClientKeywords, but with the volume, source,
 * difficulty, competition and score each row carries — the
 * local-keyword-targeting ledger snapshots these onto blog_keyword_targets
 * (see keyword-target-actions.ts) so its rows stay meaningful even if a
 * keyword is later re-ranked or deactivated.
 */
export async function topActiveClientKeywordsWithMeta(
  clientId: string,
  limit = 40,
): Promise<ActiveClientKeyword[]> {
  return activeClientKeywordRows(clientId, limit);
}
