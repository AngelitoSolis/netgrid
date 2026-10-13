// No `import "server-only"` here on purpose — same reasoning as
// src/lib/content/client-keywords.ts and topic-candidates.ts: every consumer is
// a server-side module (a "use server" action, a cron route, an admin server
// component), and the real `server-only` package throws under plain Node, which
// would break the standalone tsx scripts in src/lib/db/.
//
// GSC-aware pool + ledger logic ("S0", SEO-loop build brief).
//
// Two jobs, both grounded in search_performance — the table gsc-sync already
// fills. No new data source (F5):
//
//   S0-a  IDEATION GUARD. The ideation candidate pool used to know nothing
//         about where we ALREADY rank, so it could write a NEW post for a query
//         an existing page sits #14 on — instant cannibalization.
//         queriesWeAlreadyRankFor() returns the normalized keys of every query
//         with ≥1 page in positions 3–20 over the trailing window;
//         topic-candidates.ts drops those candidates before the model ever sees
//         them (they are the rescue loop's job to FIX, not ideation's to
//         re-write).
//
//   S0-b  LEDGER RE-RANK. blog_keyword_targets rows keep their build-time
//         priority forever — even after GSC shows us at #2 or #40.
//         rerankPendingTargetsByLivePosition() moves pending rows we already
//         rank on out of the new-build queue (exact comparator below). The
//         refresh-keywords cron calls it right after each blog's ledger rebuild
//         step, so priority reflects live data instead of a build-time snapshot.
//
// Position aggregation is impressions-weighted everywhere — the one rule from
// the build brief: SUM(position * impressions) / NULLIF(SUM(impressions), 0).
// Plain AVG dilutes high-volume pairs with long-tail noise and mis-ranks the
// goldmine list (same formula lib/search/performance-summary.ts already uses;
// this module reuses it rather than inventing a second one).
//
// Dates are America/Los_Angeles strings — gsc-sync's convention. Window bounds
// come from gscToday()/shiftDate(), never server UTC: between 00:00 and ~08:00
// UTC the UTC date is a day Google has not opened yet, which would silently
// truncate every window computed here (see gsc-sync.ts).
//
// EVERYTHING HERE FAILS SAFE. An error returns [] / an empty set / unchanged
// rows because this module sits in front of ideation and the publish drip — a
// lookup failure must read as "no live data", never as "block content".

import { db } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { blogKeywordTargets } from "@/lib/db/schema";
import { gscToday, shiftDate } from "@/lib/services/gsc-sync";
import { normalizeQueryKey } from "./topic-similarity";

/** Optional integer tuning knob from the environment. Falls back on anything
 * unparseable. Same pattern as client-keywords.ts (F7: every budget is
 * env-tunable). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// ── Named constants + env overrides ──────────────────────────────────────────

/** Trailing window (days) for every GSC-based decision in this module. */
export const RESCUE_WINDOW_DAYS = envInt("GSC_RESCUE_WINDOW_DAYS", 90);

/** Minimum impressions a (query, page) pair needs inside the window before it
 * is actionable at all — the brief's rescue floor: 50 over 90 days by default.
 * Set absurdly high to disable detection entirely (feature kill switch). */
export const MIN_IMPRESSIONS_90D = envInt("GSC_RESCUE_MIN_IMPRESSIONS", 50);

/** "Page 2" position window for rescue candidates. The source article says
 * ~11–20; we widen the low end to 8 because a meta-only fix reaches further
 * than a rewrite, and cap at 20.4 so a page averaging just past the fold is
 * not called rescue-able. */
export const RESCUE_POS_MIN = 8.0;
export const RESCUE_POS_MAX = 20.4;

/** S0-a guard window: "we already have a page for this query" means at least
 * one of our pages averages inside positions 3–20 on it. Position 1–2 is left
 * alone (nothing to fix, and the pin detector owns those); past 20 the pair is
 * too far away for a meta fix and belongs in ordinary ideation. */
const RANKED_POS_MIN = 3.0;
const RANKED_POS_MAX = 20.0;

/** Below this many impressions on a pair, live evidence is too thin to move a
 * build-time priority (F8: no decisions made on noise). Default 10/90d. */
export const LIVE_RERANK_MIN_IMPRESSIONS = envInt(
  "GSC_LIVE_RERANK_MIN_IMPRESSIONS",
  10,
);

/** Claim order for blog_keyword_targets is (attempts asc, priority asc) — lower
 * priority is claimed first. Rows we already rank on are pushed into this
 * offset band so they sit at the BOTTOM of a blog's new-build queue without
 * touching attempts or the retry lifecycle. 10_000 is far above any real pool
 * rank (the ledger builds from pools capped well under that). */
const LIVE_RANK_OFFSET = 10_000;

/** How many pairs rankedPageQueryPairs returns, best (highest-impressions)
 * first — same cap as the S1 detector. */
const PAIR_LIMIT_DEFAULT = 50;

// ── Types ────────────────────────────────────────────────────────────────────

/** One aggregated (query, page) pair over the trailing window. */
export interface PageQueryPair {
  query: string;
  /** The full URL exactly as stored in search_performance — possibly a raw GSC
   * string with UTM noise; canonicalize before matching against posts. */
  page: string;
  impressions90d: number;
  clicks90d: number;
  /** Impressions-weighted average position over the window. */
  avgPosition: number;
}

export interface RankedPairsOptions {
  windowDays?: number;
  minImpressions?: number;
  limit?: number;
}

// ── Pure core (unit-tested, no DB) ───────────────────────────────────────────

/** S0-a guard predicate: does this pair count as "a page we already rank on"?
 * Inclusive bounds — a page averaging exactly position 3 or exactly 20 is in. */
export function isRankedPosition(avgPosition: number): boolean {
  return (
    Number.isFinite(avgPosition) &&
    avgPosition >= RANKED_POS_MIN &&
    avgPosition <= RANKED_POS_MAX
  );
}

/** Normalized keys of every query with ≥1 page in positions 3–20 — the "we
 * have a page for this" guard set. normalizeQueryKey (F5: THE dedupe key) so
 * case/accent/punctuation variants collapse identically to blog_covered_queries. */
export function rankedQueryKeys(
  pairs: ReadonlyArray<{ query: string; avgPosition: number }>,
): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) {
    if (!isRankedPosition(p.avgPosition)) continue;
    const key = normalizeQueryKey(p.query);
    if (key) out.add(key);
  }
  return out;
}

/** S0-a pool filter, pure. Drops candidates whose normalized key is in
 * rankedKeys and returns the drop count so callers can log it ("N ranked
 * queries excluded from ideation"). Input order of survivors is preserved —
 * the T09 seam contract (≤limit rows, best-first) is untouched by this step. */
export function applyRankedPoolFilter<T extends { query: string }>(
  candidates: readonly T[],
  rankedKeys: ReadonlySet<string>,
): { kept: T[]; excludedCount: number } {
  if (rankedKeys.size === 0) return { kept: [...candidates], excludedCount: 0 };
  const kept: T[] = [];
  let excludedCount = 0;
  for (const c of candidates) {
    const key = normalizeQueryKey(c.query);
    if (key && rankedKeys.has(key)) excludedCount++;
    else kept.push(c);
  }
  return { kept, excludedCount };
}

// ── S0-b comparator — the EXACT rule; tests pin it ───────────────────────────

export type LiveRankBucket = "unchanged" | "already-wins" | "rescue-queue";

export interface LiveRankDecision {
  priority: number;
  bucket: LiveRankBucket;
}

/**
 * S0-b live re-rank comparator — the exact rule, documented per the brief:
 *
 *   bestPosition = the minimum impressions-weighted position across ALL pages
 *                  for a row's keyword OR any of its folded variants over the
 *                  trailing window (evidence floor LIVE_RERANK_MIN_IMPRESSIONS).
 *
 *   - no qualifying GSC pair              → { priority, "unchanged" }: no data
 *     means build-time priority stands (zero behavior change for clients with
 *     no GSC rows — a hard DoD of S0).
 *   - bestPosition < 3                    → "already-wins": we already rank
 *     top-3 on it; a new post would compete against our own winner. Pushed to
 *     the bottom of the queue via LIVE_RANK_OFFSET + originalPriority.
 *   - RESCUE_POS_MIN ≤ bestPosition ≤
 *     RESCUE_POS_MAX (8–20.4)             → "rescue-queue": page 2 — the S1
 *     detector owns this query end-to-end (detect → fix → verify). Same offset
 *     so a new build never races the rescue for the same slot.
 *   - otherwise (3 ≤ pos < 8, or > 20.4)  → { priority, "unchanged" }: the
 *     brief defines only top-3 and page-2 buckets; we do not invent behavior
 *     for in-between positions.
 *
 * originalPriority is ADDED to the offset (not replaced), so rows inside a
 * bucket keep their relative build-time order — the comparator preserves the
 * total order of the queue, it only moves whole bands.
 */
export function liveRankDecision(
  originalPriority: number,
  bestPosition: number | null,
): LiveRankDecision {
  if (bestPosition === null || !Number.isFinite(bestPosition)) {
    return { priority: originalPriority, bucket: "unchanged" };
  }
  if (bestPosition < RANKED_POS_MIN) {
    return {
      priority: LIVE_RANK_OFFSET + originalPriority,
      bucket: "already-wins",
    };
  }
  if (bestPosition >= RESCUE_POS_MIN && bestPosition <= RESCUE_POS_MAX) {
    return {
      priority: LIVE_RANK_OFFSET + originalPriority,
      bucket: "rescue-queue",
    };
  }
  return { priority: originalPriority, bucket: "unchanged" };
}

// ── DB-backed reads (thin wrappers — fail-safe to empty) ─────────────────────

/** Trailing-window start as an LA date string. `date > start` then includes
 * exactly the trailing `windowDays` LA dates up to and including today. */
function windowStart(windowDays: number): string {
  return shiftDate(gscToday(), -windowDays);
}

/** The neon-http driver returns { rows }; tolerate a bare array the same way
 * gsc-sync.ts does, so this keeps working if the driver layer changes. */
function asRows(result: unknown): Array<Record<string, unknown>> {
  const raw = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;
  return (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
}

function finiteNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Trailing-window (query, page) aggregates for ONE blog — the single read every
 * GSC detector in this build builds on. Impressions-weighted position per the
 * one rule above, floors as named constants with env override, best-first by
 * impressions, capped. Fail-safe to [].
 */
export async function rankedPageQueryPairs(
  blogId: string,
  opts: RankedPairsOptions = {},
): Promise<PageQueryPair[]> {
  const windowDays = Math.max(1, opts.windowDays ?? RESCUE_WINDOW_DAYS);
  const minImpressions = Math.max(0, opts.minImpressions ?? MIN_IMPRESSIONS_90D);
  const limit = Math.max(1, opts.limit ?? PAIR_LIMIT_DEFAULT);
  try {
    const result = await db.execute(sql`
      SELECT query, page,
             SUM(impressions)::int AS impressions_window,
             SUM(clicks)::int      AS clicks_window,
             (SUM(position::numeric * impressions) / NULLIF(SUM(impressions), 0))::double precision AS avg_position
      FROM search_performance
      WHERE blog_id = ${blogId} AND date > ${windowStart(windowDays)}
      GROUP BY query, page
      HAVING SUM(impressions) >= ${minImpressions}
      ORDER BY impressions_window DESC
      LIMIT ${limit}
    `);
    const out: PageQueryPair[] = [];
    for (const r of asRows(result)) {
      const avgPosition = finiteNum(r.avg_position);
      if (avgPosition === null) continue; // NULL only when total impressions were 0 — impossible past the floor, but never emit a NaN pair.
      out.push({
        query: String(r.query ?? ""),
        page: String(r.page ?? ""),
        impressions90d: Math.max(0, Number(r.impressions_window) || 0),
        clicks90d: Math.max(0, Number(r.clicks_window) || 0),
        avgPosition,
      });
    }
    return out;
  } catch (err) {
    console.warn(
      `[gsc-pool] ranked pairs read failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * S0-a guard set: normalized keys of every query for which this client has ≥1
 * page in positions 3–20 over the trailing window (any of its blogs — a client
 * with several city blogs "has a page" network-wide). Fail-safe to an empty
 * set: if the read fails, ideation behaves exactly as before.
 */
export async function queriesWeAlreadyRankFor(
  clientId: string,
  opts: { windowDays?: number } = {},
): Promise<Set<string>> {
  const windowDays = Math.max(1, opts.windowDays ?? RESCUE_WINDOW_DAYS);
  try {
    const result = await db.execute(sql`
      WITH pairs AS (
        SELECT query, page,
               (SUM(position::numeric * impressions) / NULLIF(SUM(impressions), 0))::double precision AS wpos
        FROM search_performance
        WHERE client_id = ${clientId} AND date > ${windowStart(windowDays)}
        GROUP BY query, page
      )
      SELECT DISTINCT query
      FROM pairs
      WHERE wpos >= ${RANKED_POS_MIN} AND wpos <= ${RANKED_POS_MAX}
    `);
    const keys = new Set<string>();
    for (const r of asRows(result)) {
      const key = normalizeQueryKey(String(r.query ?? ""));
      if (key) keys.add(key);
    }
    return keys;
  } catch (err) {
    console.warn(
      `[gsc-pool] ranked-query guard read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return new Set();
  }
}

/**
 * Best (minimum) impressions-weighted position per NORMALIZED query key for one
 * blog over the trailing window, with an evidence floor — the input map for
 * S0-b re-ranking. Keyed by normalizeQueryKey so folded variants match the way
 * every other dedupe in this codebase matches (F5). Fail-safe to empty map.
 */
export async function liveBestPositionByQuery(
  blogId: string,
  opts: { windowDays?: number; minImpressions?: number } = {},
): Promise<Map<string, number>> {
  const windowDays = Math.max(1, opts.windowDays ?? RESCUE_WINDOW_DAYS);
  const minImpressions = Math.max(
    0,
    opts.minImpressions ?? LIVE_RERANK_MIN_IMPRESSIONS,
  );
  try {
    const result = await db.execute(sql`
      WITH pairs AS (
        SELECT query, page,
               SUM(impressions)::int AS imp,
               (SUM(position::numeric * impressions) / NULLIF(SUM(impressions), 0))::double precision AS wpos
        FROM search_performance
        WHERE blog_id = ${blogId} AND date > ${windowStart(windowDays)}
        GROUP BY query, page
        HAVING SUM(impressions) >= ${minImpressions}
      )
      SELECT query, MIN(wpos)::double precision AS best_pos
      FROM pairs
      GROUP BY query
    `);
    const out = new Map<string, number>();
    for (const r of asRows(result)) {
      const pos = finiteNum(r.best_pos);
      if (pos === null) continue;
      const key = normalizeQueryKey(String(r.query ?? ""));
      if (!key) continue;
      // Two raw queries can normalize to the same key; keep the better one.
      const existing = out.get(key);
      if (existing === undefined || pos < existing) out.set(key, pos);
    }
    return out;
  } catch (err) {
    console.warn(
      `[gsc-pool] live-position read failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }
}

// ── S0-b ledger re-rank ──────────────────────────────────────────────────────

export interface LiveRerankResult {
  rowsChecked: number;
  alreadyWins: number;
  rescueQueue: number;
  unchanged: number;
}

/**
 * S0-b — re-prioritize a blog's PENDING ledger rows by where we actually rank
 * today. Called by the refresh-keywords cron AFTER each blog's existing ledger
 * rebuild step (rebuildAllKeywordTargetsInternal), so priority reflects live
 * GSC data instead of a build-time snapshot.
 *
 * One position-map read for the whole blog, then liveRankDecision per row over
 * its keyword AND every folded variant (a row represents a cluster; any member
 * ranking means we have a page for it). Only rows whose bucket changed are
 * written back — one UPDATE each; no transactions needed on this driver.
 *
 * NEVER THROWS: on any failure it returns zero counts and leaves every row
 * untouched, exactly like the rest of the ledger lifecycle functions.
 */
export async function rerankPendingTargetsByLivePosition(
  blogId: string,
): Promise<LiveRerankResult> {
  const empty: LiveRerankResult = {
    rowsChecked: 0,
    alreadyWins: 0,
    rescueQueue: 0,
    unchanged: 0,
  };
  try {
    const rows = await db
      .select({
        id: blogKeywordTargets.id,
        keyword: blogKeywordTargets.keyword,
        variants: blogKeywordTargets.variants,
        priority: blogKeywordTargets.priority,
      })
      .from(blogKeywordTargets)
      .where(
        and(
          eq(blogKeywordTargets.blogId, blogId),
          eq(blogKeywordTargets.status, "pending"),
        ),
      );
    if (rows.length === 0) return empty;

    const live = await liveBestPositionByQuery(blogId);
    let alreadyWins = 0;
    let rescueQueue = 0;
    let unchanged = 0;

    for (const row of rows) {
      // Best position across the keyword and every folded variant. Variants
      // come back untyped from jsonb — coerce defensively, same as the claim
      // path does (a malformed value must not throw on a scheduling path).
      let best: number | null = null;
      const terms: string[] = [row.keyword];
      if (Array.isArray(row.variants)) {
        for (const v of row.variants) {
          const s = String(v ?? "").trim();
          if (s) terms.push(s);
        }
      }
      for (const term of terms) {
        const key = normalizeQueryKey(term);
        if (!key) continue;
        const pos = live.get(key);
        if (pos !== undefined && (best === null || pos < best)) best = pos;
      }

      const decision = liveRankDecision(Number(row.priority), best);
      if (decision.bucket === "unchanged") {
        unchanged++;
        continue;
      }
      await db
        .update(blogKeywordTargets)
        .set({ priority: decision.priority, updatedAt: new Date() })
        .where(eq(blogKeywordTargets.id, row.id));
      if (decision.bucket === "already-wins") alreadyWins++;
      else rescueQueue++;
    }

    return { rowsChecked: rows.length, alreadyWins, rescueQueue, unchanged };
  } catch (err) {
    console.warn(
      `[gsc-pool] live re-rank failed for blog ${blogId} — leaving priorities untouched:`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}