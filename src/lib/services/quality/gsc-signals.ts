/**
 * lib/services/quality/gsc-signals.ts
 *
 * The ONLY place T19 reads Google Search Console data. Everything Search
 * Console-shaped that the quality score needs comes through these two
 * functions, so if T04's tables are ever reshaped you change the queries here
 * and nothing else in the task.
 *
 * The T19 SOP assumed a contract T04 did not ship:
 *
 *   SOP assumed                        T04 actually landed
 *   ───────────────────────────────    ──────────────────────────────────────
 *   index_coverage(page_url,           index_coverage(post_id UNIQUE,
 *     indexed boolean, checked_at)       inspected_url, verdict varchar,
 *                                        coverage_state, last_checked_at)
 *   search_performance(page_url,       search_performance(blog_id, page,
 *     date, impressions, clicks,         date, query, clicks, impressions,
 *     position)                          position)  -- one row PER QUERY
 *
 * Both differences are improvements and are used as such: coverage is keyed by
 * post id (exact, uniquely indexed) rather than by a URL string that can be
 * rewritten under us, and performance rows are summed across queries for a
 * page.
 *
 * DEGRADATION IS THE POINT. If a query errors these functions return
 * "unknown" / unavailable. They never throw: they are called from the publish
 * path via the fire-and-forget per-post scan, and a Search Console outage must
 * not be able to fail a publish. An unknown indexation verdict makes the score
 * NULL — never 0, and never a guess.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { indexCoverage, searchPerformance } from "@/lib/db/schema";
import type { IndexationVerdict, SearchSignal } from "./score";

/** Trailing window for the search-performance rollup, in days. */
export const SEARCH_WINDOW_DAYS = 28;

/** YYYY-MM-DD `days` before now — search_performance.date is a string column. */
function windowStart(days: number, now: Date): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Has Google indexed this exact post?
 *
 * Reads T04's URL-Inspection verdict. Google's `indexStatusResult.verdict`
 * vocabulary is PASS / PARTIAL / NEUTRAL / FAIL / VERDICT_UNSPECIFIED:
 *
 *   PASS, PARTIAL  -> indexed (PARTIAL is "indexed, with warnings")
 *   FAIL, NEUTRAL  -> not_indexed. NEUTRAL is the common one and it is the
 *                     one that matters: "Crawled - currently not indexed" and
 *                     "Discovered - currently not indexed" both land here.
 *   anything else  -> unknown
 *
 * "unknown" is a first-class answer and is returned whenever we genuinely do
 * not know: no coverage row for the post yet, an unrecognised verdict, or a
 * query error. The caller turns "unknown" into a NULL score, NOT into a zero —
 * an unchecked page and a deindexed page are different facts and the product
 * must not conflate them.
 */
export async function getIndexationVerdict(
  postId: string,
): Promise<IndexationVerdict> {
  if (!postId) return "unknown";
  try {
    const [row] = await db
      .select({
        verdict: indexCoverage.verdict,
        coverageState: indexCoverage.coverageState,
      })
      .from(indexCoverage)
      .where(eq(indexCoverage.postId, postId))
      .limit(1);

    if (!row) return "unknown";

    const verdict = (row.verdict ?? "").toUpperCase();
    if (verdict === "PASS" || verdict === "PARTIAL") return "indexed";
    if (verdict === "FAIL" || verdict === "NEUTRAL") return "not_indexed";

    // No usable verdict — fall back to the human coverage string, which is
    // populated even on some responses that omit a verdict. Order matters:
    // "Submitted and indexed" contains "indexed", and so does "Crawled -
    // currently not indexed", so the negative form is tested first.
    const state = (row.coverageState ?? "").toLowerCase();
    if (!state) return "unknown";
    if (state.includes("not indexed") || state.includes("excluded")) {
      return "not_indexed";
    }
    if (state.includes("indexed")) return "indexed";
    return "unknown";
  } catch (err) {
    console.warn(`[quality/gsc] coverage lookup failed for post ${postId}:`, err);
    return "unknown";
  }
}

/**
 * Impressions, clicks and impression-weighted average position for this URL
 * over the trailing SEARCH_WINDOW_DAYS.
 *
 * Position is weighted by impressions rather than averaged flat: a day with
 * 400 impressions at position 12 says far more about the page than a day with
 * 1 impression at position 3, and a flat average lets a single stray query
 * dominate the number.
 *
 * `blogId` is not just a filter. Search Console NEVER returns a row for a page
 * that got zero impressions, so "no rows for this URL" is ambiguous between
 * two opposite facts:
 *
 *   (a) T04's sync has not reached this blog yet   -> unavailable
 *   (b) the blog IS synced and this page got zero  -> a real, bad measurement
 *
 * The blog-level probe resolves it. Without that probe every invisible page —
 * exactly the page this score exists to catch — would read as "no data" and be
 * excluded from its own score. The SOP's `impressions = 0` row it expected to
 * find never physically exists in GSC data; this is the equivalent.
 */
export async function getSearchRollup(
  pageUrl: string,
  blogId: string,
  now: Date = new Date(),
): Promise<SearchSignal> {
  if (!pageUrl) return { available: false, reason: "Post has no public URL" };
  if (!blogId) return { available: false, reason: "Post has no blog" };

  const since = windowStart(SEARCH_WINDOW_DAYS, now);

  try {
    const [row] = await db
      .select({
        impressions: sql<string | number>`coalesce(sum(${searchPerformance.impressions}), 0)`,
        clicks: sql<string | number>`coalesce(sum(${searchPerformance.clicks}), 0)`,
        position: sql<string | number | null>`
          case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
               then sum(${searchPerformance.position} * ${searchPerformance.impressions})
                    / sum(${searchPerformance.impressions})
               else null end`,
        rows: sql<string | number>`count(*)`,
      })
      .from(searchPerformance)
      .where(
        and(
          eq(searchPerformance.blogId, blogId),
          eq(searchPerformance.page, pageUrl),
          gte(searchPerformance.date, since),
        ),
      );

    if (row && Number(row.rows ?? 0) > 0) {
      const position =
        row.position === null || row.position === undefined
          ? null
          : Number(row.position);
      return {
        available: true,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        position: position !== null && Number.isFinite(position) ? position : null,
        source: "page",
      };
    }

    // No rows for this page. Is the blog synced at all?
    const [probe] = await db
      .select({ rows: sql<string | number>`count(*)` })
      .from(searchPerformance)
      .where(
        and(
          eq(searchPerformance.blogId, blogId),
          gte(searchPerformance.date, since),
        ),
      );

    if (!probe || Number(probe.rows ?? 0) === 0) {
      return {
        available: false,
        reason:
          `No Search Console data for this blog in the last ${SEARCH_WINDOW_DAYS} days ` +
          `(the property may not be verified, or the sync has not reached it)`,
      };
    }

    // The blog is synced and Google reported nothing for this URL: the page
    // drew no impressions at all. That is a measurement, and a bad one.
    return {
      available: true,
      impressions: 0,
      clicks: 0,
      position: null,
      source: "blog-zero",
    };
  } catch (err) {
    console.warn(`[quality/gsc] performance lookup failed for ${pageUrl}:`, err);
    return { available: false, reason: "Search Console query failed" };
  }
}
