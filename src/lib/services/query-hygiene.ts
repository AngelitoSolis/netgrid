// S2 — Query hygiene (splits, Google-folded canonicals, accidental rankers) +
// S8 — Dead-weight triage. Four keyed detector families in ONE pass per blog,
// running inside the page-2 rescue cron run on fresh GSC data ("one detector
// pass", compact spec §S2/§S8). Same scan-row/upsert machinery as S1: one
// seo_scans row per run (rawData.kind = 'query_hygiene'), stable issue_key
// identity, partial unique index (migration 0056) makes daily runs idempotent.
//
// Families and their ledger shapes (B.2 categories are exact):
//   split:<normQuery>   content / warning    two+ pages split one real query
//   folded:<normPage>   technical / critical index_coverage says Google folded it
//   pin:<normQuery>     meta / notice        accidental page-1 ranker, meta lacks the query
//   dead:<normPage>     content / notice     six months of history, < 50 impressions ever
//
// Ground rules honoured (docs/mega-prompt-compact.md):
//   F1  Auto-apply ONLY for pages we own. split/folded/dead are RECOMMENDATION
//       rows (status 'detected', autoFixable false) — humans approve redirects,
//       merges and deletes (F2). Only pin is auto-safe: it reuses S1's
//       query_rescue fixPayload verbatim so the SAME apply branch, budget and
//       outcome loop carry it ("two detectors, one machine").
//   F4  One ledger. Every finding lands in seo_issues with a stable issue_key;
//       nothing is re-detected while any row holds the key (upsert guard).
//   F5  GSC reads via search_performance + impressions-weighted position;
//       dedupe via normalizeQueryKey; URL matching via S1's normalizeForMatch.
//   F7  Pin proposals count against the SAME client-day LLM budget as page-2
//       rescues (RESCUE_MAX_GENERATED_PER_RUN) — one cap on meta generation.
//   F8  No delta without both measurements; thin data is a valid state.

import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  blogs,
  generatedPosts,
  indexCoverage,
  seoIssues,
  seoScans,
} from "@/lib/db/schema";
import { gscToday, shiftDate } from "./gsc-sync";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import { RESCUE_WINDOW_DAYS } from "@/lib/content/gsc-pool";
import { buildDossierContextBlock, getDossierForClient } from "./client-dossier";
import { findTopicalLinkRefs } from "./semantic-linking";
import {
  generateProposalForFinding,
  normalizeForMatch,
  RESCUE_MAX_GENERATED_PER_RUN,
} from "./page2-rescue";

// ── Named constants + env overrides (F7: every floor is tunable) ─────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Lower per-page floor for the split detector — half of S1's rescue floor by
 * design: a split is diagnosable on less volume than a rescue, because the fix
 * (consolidate + redirect) moves nothing until a human approves it. */
export const SPLIT_MIN_IMPRESSIONS_90D = envInt("HYGIENE_SPLIT_MIN_IMPRESSIONS", 25);

/** Position ceiling for accidental rankers — page one, above the fold line. */
export const PIN_MAX_POSITION = 5;

/** Volume floor for a pin finding: below this the "accidental" rank is noise. */
export const PIN_MIN_IMPRESSIONS_90D = envInt("HYGIENE_PIN_MIN_IMPRESSIONS", 200);

/** A page with fewer total impressions than this across its FULL retained GSC
 * window (≤16 months) has no measurable search demand — dead-weight candidate. */
export const DEAD_MAX_TOTAL_IMPRESSIONS = envInt("HYGIENE_DEAD_MAX_IMPRESSIONS", 50);

/** Both the blog's backfill AND the post itself must be at least this old
 * before a page can be called dead — a young post on an old blog is simply
 * new, not dead. ~6 months per the brief. */
export const DEAD_MIN_HISTORY_DAYS = envInt("HYGIENE_DEAD_MIN_HISTORY_DAYS", 183);

// ── Types ────────────────────────────────────────────────────────────────────

export type HygieneFamily = "split" | "folded" | "pin" | "dead";
type HygieneCategory = "content" | "technical" | "meta";
type HygieneSeverity = "critical" | "warning" | "notice";

/** One detector output, ready for the shared ledger. `fixPayload.kind` is the
 * apply-branch dispatch identity (F4): 'query_rescue' rows drain through S1's
 * existing pipeline untouched; the recommendation kinds are human-only. */
export interface HygieneFinding {
  family: HygieneFamily;
  category: HygieneCategory;
  severity: HygieneSeverity;
  issueKey: string;
  /** Representative URL stored on seo_issues.page_url (winner / inspected / post). */
  pageUrl: string;
  title: string;
  description: string;
  suggestedFix: string | null;
  fixPayload: Record<string, unknown>;
  autoFixable: boolean;
  /** pin only — the BEFORE measurement so S1's outcome loop can prove movement. */
  preSnapshot?: Record<string, unknown>;
  /** Volume signal used for best-first ordering + generation budgeting. */
  rankImpressions: number;
}

export interface QueryHygieneMetrics {
  split: number;
  folded: number;
  pin: number;
  dead: number;
  opened: number;
  skippedExisting: number; // upsert guard hit — never re-detected (F4)
  generated: number; // LLM proposals attempted this run (F7 accounting)
}

/** The cron passes one GSC-connected blog at a time (shard-safe). */
export interface QueryHygieneBlogInput {
  id: string;
  clientId: string;
}

// ── Pure helpers (unit-tested, no DB) ────────────────────────────────────────

/** Stable issue identity for split findings — the normalized query. */
export function splitIssueKey(query: string): string {
  return `split:${normalizeQueryKey(query)}`;
}

/** Stable issue identity for pin findings (same namespace rule as S1's page2:). */
export function pinIssueKey(query: string): string {
  return `pin:${normalizeQueryKey(query)}`;
}

/**
 * Short stable identity for a PAGE url — sha1 of S1's normalizeForMatch form.
 * Full URLs do not fit issue_key's varchar(255), and the codebase already uses
 * this exact convention elsewhere (search_performance.rowHash: hash to a fixed
 * width, keep the verbatim value in a separate column for display).
 */
export function normPageDigest(pageUrl: string): string {
  const normalized = normalizeForMatch(pageUrl);
  if (!normalized) return "";
  return createHash("sha1").update(normalized).digest("hex");
}

/** `folded:<normPage>` — one row per page Google has folded into another URL. */
export function foldedIssueKey(pageUrl: string): string {
  const digest = normPageDigest(pageUrl);
  return digest ? `folded:${digest}` : "";
}

/** `dead:<normPage>` — one recommendation row per zero-traction page. */
export function deadIssueKey(pageUrl: string): string {
  const digest = normPageDigest(pageUrl);
  return digest ? `dead:${digest}` : "";
}

/**
 * Does the post's stored meta already contain this query (or a variant of it)?
 * Token-subset rule on normalizeQueryKey output: EVERY significant token of the
 * query must appear somewhere in the normalized meta text, word order free.
 * "drain cleaning old town" matches a title that says "Old Town Drain Cleaning"
 * but not one that only says "Drain Service". Empty/null meta never contains
 * anything; an empty query key can never be pinned (callers skip those).
 */
export function metaContainsQuery(
  metaText: string | null | undefined,
  query: string,
): boolean {
  const qKey = normalizeQueryKey(query);
  if (!qKey) return false;
  const mKey = normalizeQueryKey(metaText ?? "");
  if (!mKey) return false;
  const metaTokens = new Set(mKey.split(" "));
  for (const token of qKey.split(" ")) {
    if (!metaTokens.has(token)) return false;
  }
  return true;
}

/** One page's evidence in a split finding. */
export interface SplitPageStat {
  url: string;
  impressions90d: number;
  avgPosition: number;
}

/**
 * Deterministic winner pick for a split query — the page the variants should be
 * consolidated ONTO (F2: ledger only, humans approve any redirect). Total order
 * so two runs over identical data always name the same winner: better average
 * position first, then more impressions, then URL lexicographic as the final
 * tie-break. Pure so the boundary is testable.
 */
export function pickSplitWinner(pages: SplitPageStat[]): string {
  const sorted = [...pages].sort((a, b) => {
    if (a.avgPosition !== b.avgPosition) return a.avgPosition - b.avgPosition;
    if (a.impressions90d !== b.impressions90d) return b.impressions90d - a.impressions90d;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return sorted[0]?.url ?? "";
}

/** One decimal place for rendered positions — same helper convention as S1. */
function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ── Detector 1 — split:<normQuery> (content / warning) ───────────────────────

interface PairRow {
  query: string;
  page: string;
  impressions_90d: number | string;
  clicks_90d: number | string;
  avg_position: number | string;
}

/** Fetch the blog's (query, page) pairs above the SPLIT floor in one pass. */
async function fetchSplitPairRows(blogId: string): Promise<PairRow[]> {
  const today = gscToday();
  return (await db.execute(sql`
    SELECT query, page,
           SUM(impressions)::int AS impressions_90d,
           COALESCE(SUM(clicks), 0)::int AS clicks_90d,
           SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS avg_position
    FROM search_performance
    WHERE blog_id = ${blogId}
      AND date >= ${shiftDate(today, -RESCUE_WINDOW_DAYS)}
      AND date <= ${today}
      AND impressions > 0
    GROUP BY query, page
    HAVING SUM(impressions) >= ${SPLIT_MIN_IMPRESSIONS_90D}
    ORDER BY impressions_90d DESC
    LIMIT 200
  `)) as unknown as PairRow[];
}

/**
 * "Two posts split one real query": the same normalized query ranks on ≥2
 * distinct pages, each clearing the lower split floor. Distinctness is judged
 * on S1's normalizeForMatch form (tracking params never create a fake second
 * page). fail-safe [] — a detector error must not kill the shard run.
 */
export async function detectQuerySplits(blogId: string): Promise<HygieneFinding[]> {
  try {
    const rows = await fetchSplitPairRows(blogId);
    if (!rows.length) return [];

    // normKey -> normalized page url -> aggregated stats (raw query variants of
    // the same key and raw GSC strings of the same page both collapse here).
    interface Agg extends SplitPageStat {
      weightedSum: number;
    }
    const groups = new Map<string, Map<string, Agg>>();
    for (const row of rows) {
      const query = String(row.query ?? "").trim();
      const page = String(row.page ?? "").trim();
      if (!query || !page) continue;
      const normKey = normalizeQueryKey(query);
      const normPage = normalizeForMatch(page);
      if (!normKey || !normPage) continue;

      const impressions = Number(row.impressions_90d) || 0;
      const position = Math.round((Number(row.avg_position) || 0) * 100) / 100;
      let byPage = groups.get(normKey);
      if (!byPage) {
        byPage = new Map();
        groups.set(normKey, byPage);
      }
      const agg = byPage.get(normPage) ?? {
        url: page,
        impressions90d: 0,
        avgPosition: 0,
        weightedSum: 0,
      };
      agg.impressions90d += impressions;
      agg.weightedSum += position * impressions;
      byPage.set(normPage, agg);
    }

    const findings: HygieneFinding[] = [];
    for (const [normKey, byPage] of groups) {
      if (byPage.size < 2) continue; // one page owning the query is not a split
      const pages = [...byPage.values()].map((a) => ({
        url: a.url,
        impressions90d: a.impressions90d,
        avgPosition:
          a.impressions90d > 0 ? Math.round((a.weightedSum / a.impressions90d) * 100) / 100 : 0,
      }));
      const winnerUrl = pickSplitWinner(pages);
      const topImpressions = pages.reduce((m, p) => Math.max(m, p.impressions90d), 0);

      const pageList = pages
        .map(
          (p) =>
            `${p.url} — ${round1(p.avgPosition)} avg, ${p.impressions90d} imp/90d` +
            (p.url === winnerUrl ? " (winner)" : ""),
        )
        .join("\n");

      findings.push({
        family: "split",
        category: "content",
        severity: "warning",
        issueKey: splitIssueKey(normKey),
        pageUrl: winnerUrl,
        title: `Query split: "${normKey}" ranks on ${pages.length} pages`.slice(0, 500),
        description:
          `"${normKey}" (and its raw variants) earns real impressions on ${pages.length} different ` +
          `pages of this blog in the last ${RESCUE_WINDOW_DAYS} days — a split query dilutes every one of them. ` +
          `Evidence per page:\n${pageList}`,
        suggestedFix:
          `Consolidate onto "${winnerUrl}" (301 or canonical tag from the other page(s)). Pending keyword-target ` +
          `ledger rows for the losing pages are marked skipped on approve; the redirect itself is a human decision — ` +
          `approve it deliberately (F2).`,
        fixPayload: {
          kind: "query_split",
          targetQuery: normKey,
          winnerUrl,
          pages: [...pages].sort((a, b) => b.impressions90d - a.impressions90d),
        },
        autoFixable: false,
        rankImpressions: topImpressions,
      });
    }
    return findings;
  } catch (err) {
    console.warn(
      `[query-hygiene] split detection failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Detector 2 — folded:<normPage> (technical / critical) ────────────────────

/**
 * Google says this URL is a duplicate of another: index_coverage rows where
 * googleCanonical disagrees with the canonical the site itself declares (or,
 * when none is declared, with the inspected URL). The schema comment calls this
 * pair "the single most diagnostic" — this detector is what it was made for.
 * One row per post (index_coverage has a unique index on post_id), so no dedupe
 * is needed beyond skipping empty canonicals. Recommendation only: humans
 * approve whatever redirect or tag change follows (F2).
 */
export async function detectFoldedCanonicals(blogId: string): Promise<HygieneFinding[]> {
  try {
    const rows = await db
      .select({
        postId: indexCoverage.postId,
        inspectedUrl: indexCoverage.inspectedUrl,
        googleCanonical: indexCoverage.googleCanonical,
        userCanonical: indexCoverage.userCanonical,
        lastCheckedAt: indexCoverage.lastCheckedAt,
      })
      .from(indexCoverage)
      .where(and(eq(indexCoverage.blogId, blogId), isNotNull(indexCoverage.googleCanonical)));

    const findings: HygieneFinding[] = [];
    for (const row of rows) {
      const google = String(row.googleCanonical ?? "").trim();
      if (!google) continue;
      // No declared canonical: the inspected URL IS what the site asked for.
      const declared = String(row.userCanonical ?? "").trim() || row.inspectedUrl;
      const normGoogle = normalizeForMatch(google);
      const normDeclared = normalizeForMatch(declared);
      if (!normGoogle || !normDeclared || normGoogle === normDeclared) continue;

      const key = foldedIssueKey(row.inspectedUrl);
      if (!key) continue; // unparseable URL — nothing stable to key on, skip honestly

      findings.push({
        family: "folded",
        category: "technical",
        severity: "critical",
        issueKey: key,
        pageUrl: row.inspectedUrl,
        title: `Google folded ${row.inspectedUrl} into ${google}`.slice(0, 500),
        description:
          `URL Inspection (checked ${
            row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString().slice(0, 10) : "—"
          }) reports Google's canonical as "${google}" while the page declares "${declared}". ` +
          `Google is treating this URL as a duplicate of another — the classic "indexed but demoted" state: ` +
          `impressions keep arriving on the folded-into URL while this one fades.`,
        suggestedFix:
          `Decide which URL should own this content, then make it explicit: add/fix the canonical tag on ${row.inspectedUrl} ` +
          `(or 301 it to "${google}" if that page is the right home). Recommendation only — humans approve redirects (F2).`,
        fixPayload: {
          kind: "folded_canonical",
          postId: row.postId,
          inspectedUrl: row.inspectedUrl,
          googleCanonical: google,
          userCanonical: String(row.userCanonical ?? "").trim() || null,
        },
        autoFixable: false,
        rankImpressions: 0, // index_coverage carries no volume signal — ordering is irrelevant
      });
    }
    return findings;
  } catch (err) {
    console.warn(
      `[query-hygiene] folded-canonical detection failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Detector 3 — pin:<normQuery> (meta / notice) ─────────────────────────────

/**
 * "Accidental ranker": a query already sits at position ≤ 5 with real volume on
 * one of OUR posts, but the post's stored meta does not contain the query (or a
 * variant of it). Pin the rank: generate meta that names the query. This is
 * where S2 and S1 compose — the finding carries S1's exact query_rescue
 * fixPayload + preSnapshot shape, so the SAME apply branch, the SAME budgets
 * and the SAME outcome loop carry it with zero new machinery (F5).
 */
export async function detectAccidentalRankers(blogId: string): Promise<HygieneFinding[]> {
  try {
    const today = gscToday();
    const rows = (await db.execute(sql`
      SELECT query, page,
             SUM(impressions)::int AS impressions_90d,
             COALESCE(SUM(clicks), 0)::int AS clicks_90d,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS avg_position
      FROM search_performance
      WHERE blog_id = ${blogId}
        AND date >= ${shiftDate(today, -RESCUE_WINDOW_DAYS)}
        AND date <= ${today}
        AND impressions > 0
      GROUP BY query, page
      HAVING SUM(impressions) >= ${PIN_MIN_IMPRESSIONS_90D}
         AND SUM(position * impressions) / NULLIF(SUM(impressions), 0)
             BETWEEN 1 AND ${PIN_MAX_POSITION}
      ORDER BY impressions_90d DESC
      LIMIT 200
    `)) as unknown as PairRow[];

    if (!rows.length) return [];

    // F1 boundary: only pages WE published are pin-eligible. One read of this
    // blog's posts, matched on S1's normalizeForMatch form — same rule as the
    // page-2 detector, so both families agree on what "managed" means.
    const posts = await db
      .select({
        id: generatedPosts.id,
        externalPostUrl: generatedPosts.externalPostUrl,
        metaTitle: generatedPosts.metaTitle,
        metaDescription: generatedPosts.metaDescription,
      })
      .from(generatedPosts)
      .where(eq(generatedPosts.blogId, blogId));

    const byNormalizedUrl = new Map<
      string,
      { postId: string; url: string; metaText: string }
    >();
    for (const p of posts) {
      if (!p.externalPostUrl) continue;
      const key = normalizeForMatch(p.externalPostUrl);
      if (!key || byNormalizedUrl.has(key)) continue;
      byNormalizedUrl.set(key, {
        postId: p.id,
        url: p.externalPostUrl,
        metaText: `${p.metaTitle ?? ""} ${p.metaDescription ?? ""}`.trim(),
      });
    }

    const findings: HygieneFinding[] = [];
    for (const row of rows) {
      const query = String(row.query ?? "").trim();
      const gscPage = String(row.page ?? "").trim();
      if (!query || !gscPage) continue;
      const normKey = normalizeQueryKey(query);
      if (!normKey) continue; // empty key can never be pinned (F4 identity rule)

      const match = byNormalizedUrl.get(normalizeForMatch(gscPage));
      if (!match) continue; // unmanaged page — the page-2 family owns those
      if (metaContainsQuery(match.metaText, query)) continue; // already pinned in copy

      const impressions = Number(row.impressions_90d) || 0;
      const clicks = Number(row.clicks_90d) || 0;
      const avgPosition = Math.round((Number(row.avg_position) || 0) * 100) / 100;

      findings.push({
        family: "pin",
        category: "meta",
        severity: "notice",
        issueKey: pinIssueKey(normKey),
        pageUrl: match.url,
        title: `Pin ranker: "${query}" (#${round1(avgPosition)} avg, ${impressions} imp/90d) — meta lacks the query`.slice(0, 500),
        description:
          `"${query}" already ranks at ${round1(avgPosition)} average position with ${impressions} ` +
          `impressions (and ${clicks} clicks) in the last ${RESCUE_WINDOW_DAYS} days — an accidental page-1 ranker. ` +
          `The post's stored meta title/description does not contain the query, so nothing holds that rank if the ` +
          `SERP shifts. Pinning it is a meta-only change: same pipeline as a page-2 rescue, zero content edits.`,
        suggestedFix:
          "Generate a meta title + description that names this query (dossier-grounded), apply through the shared " +
          "rescue branch and live-verify. The outcome loop re-measures at day ≥ 28.",
        fixPayload: {
          // EXACTLY S1's shape — the apply branch dispatches on kind, and the
          // outcome loop reads targetQuery + preSnapshot.avgPositionBefore.
          kind: "query_rescue",
          targetQuery: query,
          proposedTitle: null as string | null,
          proposedDescription: null as string | null,
          windowDays: RESCUE_WINDOW_DAYS,
        },
        autoFixable: true, // managed by construction (F1) — drains like page2 rows
        preSnapshot: {
          query,
          avgPositionBefore: avgPosition,
          impressions90dBefore: impressions,
          clicks90dBefore: clicks,
          windowDays: RESCUE_WINDOW_DAYS,
          detectedAt: new Date().toISOString(),
        },
        rankImpressions: impressions,
      });
    }
    return findings;
  } catch (err) {
    console.warn(
      `[query-hygiene] pin detection failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Detector 4 — dead:<normPage> (content / notice) [S8] ─────────────────────

/** Cap on recommendation rows per run: a blog with dozens of zero-traction
 * pages should not flood the review queue in one pass. Best-first by volume
 * (closest to the threshold = most actionable), and inbound-link research is
 * only spent on the top few — findTopicalLinkRefs embeds, so it is budgeted. */
const DEAD_MAX_FINDINGS_PER_RUN = 10;
const DEAD_LINK_RESEARCH_CAP = 3;

/**
 * "No measurable search demand": a PUBLISHED post we own, at least ~6 months
 * old on a blog whose GSC backfill is complete (gscBackfilledAt present — the
 * full retained window actually exists to judge against), with fewer than
 * DEAD_MAX_TOTAL_IMPRESSIONS impressions across that ENTIRE window. Strictly a
 * RECOMMENDATION for /review: humans decide merge/retarget/delete per F2, and
 * the suggestedFix lists all three options plus this page's inbound semantic
 * links so a delete can be made without orphaning its topic cluster.
 */
export async function detectDeadWeightPages(blogId: string): Promise<HygieneFinding[]> {
  try {
    const today = gscToday();

    // Gate 1 — the blog must have full history to be judged against at all.
    const [blog] = await db
      .select({ domain: blogs.domain, gscBackfilledAt: blogs.gscBackfilledAt })
      .from(blogs)
      .where(eq(blogs.id, blogId))
      .limit(1);
    if (!blog?.gscBackfilledAt) return [];

    // Gate 2 — the post itself must have had a fair window to earn traction.
    const posts = await db
      .select({
        id: generatedPosts.id,
        title: generatedPosts.title,
        externalPostUrl: generatedPosts.externalPostUrl,
        publishedAt: generatedPosts.publishedAt,
      })
      .from(generatedPosts)
      .where(
        and(
          eq(generatedPosts.blogId, blogId),
          eq(generatedPosts.status, "published"),
          isNotNull(generatedPosts.externalPostUrl),
          isNotNull(generatedPosts.publishedAt),
        ),
      );

    const cutoff = shiftDate(today, -DEAD_MIN_HISTORY_DAYS);
    const candidates = posts.filter((p) => {
      if (!p.externalPostUrl || !p.publishedAt) return false;
      return new Date(p.publishedAt).getTime() <= new Date(`${cutoff}T00:00:00Z`).getTime();
    });
    if (!candidates.length) return [];

    // FULL retained window (no date floor — the table's own 16-month ceiling is
    // the horizon): per-page totals in one pass, matched on normalizeForMatch.
    const pageTotals = (await db.execute(sql`
      SELECT page, SUM(impressions)::int AS total_impressions
      FROM search_performance
      WHERE blog_id = ${blogId}
        AND impressions > 0
      GROUP BY page
    `)) as unknown as Array<{ page: string; total_impressions: number | string }>;

    const totalsByNormPage = new Map<string, number>();
    for (const row of pageTotals) {
      const norm = normalizeForMatch(String(row.page ?? ""));
      if (!norm) continue;
      totalsByNormPage.set(
        norm,
        (totalsByNormPage.get(norm) ?? 0) + (Number(row.total_impressions) || 0),
      );
    }

    const blogHistoryDays = Math.max(
      0,
      Math.round((Date.now() - new Date(blog.gscBackfilledAt).getTime()) / 86400000),
    );

    interface DeadCandidate {
      finding: HygieneFinding;
      postId: string;
      postTitle: string | null;
    }
    const deadCandidates: DeadCandidate[] = [];
    for (const p of candidates) {
      const totalImpressions = totalsByNormPage.get(normalizeForMatch(p.externalPostUrl!)) ?? 0;
      if (totalImpressions >= DEAD_MAX_TOTAL_IMPRESSIONS) continue; // real demand — not dead

      const key = deadIssueKey(p.externalPostUrl!);
      if (!key) continue;
      const postAgeDays = Math.max(
        0,
        Math.round((Date.now() - new Date(p.publishedAt!).getTime()) / 86400000),
      );

      deadCandidates.push({
        finding: {
          family: "dead",
          category: "content",
          severity: "notice",
          issueKey: key,
          pageUrl: p.externalPostUrl!,
          title: `Dead weight: ${p.title ?? p.externalPostUrl} (${totalImpressions} imp in full history)`.slice(0, 500),
          description:
            `Published ${postAgeDays} days ago on a blog with ${blogHistoryDays} days of complete GSC history — and the page has earned only ` +
            `${totalImpressions} impressions across the ENTIRE retained window (< ${DEAD_MAX_TOTAL_IMPRESSIONS}). No measurable search demand: ` +
            `the index keeps it, but readers never arrive. A decision (merge / retarget / delete) beats another month of hope.`,
          suggestedFix: null, // filled below with option trade-offs + inbound links
          fixPayload: {
            kind: "dead_weight",
            postId: p.id,
            totalImpressions,
            postAgeDays,
            blogHistoryDays,
          },
          autoFixable: false, // humans decide merge/retarget/delete (F2)
          rankImpressions: totalImpressions,
        },
        postId: p.id,
        postTitle: p.title,
      });
    }

    if (!deadCandidates.length) return [];

    // Best-first by volume, capped — the ledger is a queue, not a dump.
    deadCandidates.sort((a, b) => b.finding.rankImpressions - a.finding.rankImpressions);
    const kept = deadCandidates.slice(0, DEAD_MAX_FINDINGS_PER_RUN);

    for (let i = 0; i < kept.length; i++) {
      const candidate = kept[i];
      let inboundLinks: string[] = [];
      if (i < DEAD_LINK_RESEARCH_CAP && blog.domain) {
        try {
          // Same exporter the generator uses for inline anchors — "what links
          // INTO this topic" is exactly what a merge/delete must preserve.
          const refs = await findTopicalLinkRefs({
            blogId,
            canonicalDomain: blog.domain,
            topic: candidate.postTitle ?? candidate.finding.pageUrl,
            limit: 5,
            excludePostId: candidate.postId,
          });
          inboundLinks = refs.map((r) => `${r.url} ("${r.title}")`);
        } catch {
          // findTopicalLinkRefs never throws; belt and braces for the cost path.
        }
      }

      const options = [
        "1. MERGE — fold its useful content into the strongest sibling on the same topic, then 301 it away (keeps any equity the page has).",
        "2. RETARGET — rewrite it for a query this blog can actually win; dead pages usually just chose losing queries.",
        "3. DELETE — remove and let it 404/redirect to the section index; safe when inbound links below are empty or trivial.",
      ];
      candidate.finding.suggestedFix =
        options.join("\n") +
        `\nInbound semantic links on this blog: ${inboundLinks.length ? inboundLinks.join("; ") : "none found"} — preserve these if you delete.`;
    }

    return kept.map((c) => c.finding);
  } catch (err) {
    console.warn(
      `[query-hygiene] dead-weight detection failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

// ── Per-blog orchestrator (called from the GSC cron) ─────────────────────────

/**
 * This run's seo_scans row — scores are 0 by design for non-hygiene passes
 * ("score ints 0, real metadata in rawData jsonb", compact spec §B); the family
 * counts live in rawData so the scan purge and the ops surfaces can tell a
 * hygiene pass from an S1 rescue pass.
 */
async function createHygieneScanRow(
  blogId: string,
  clientId: string,
  findings: HygieneFinding[],
): Promise<string> {
  const criticalIssues = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const notices = findings.filter((f) => f.severity === "notice").length;
  const families: Record<HygieneFamily, number> = { split: 0, folded: 0, pin: 0, dead: 0 };
  for (const f of findings) families[f.family] += 1;

  const [scan] = await db
    .insert(seoScans)
    .values({
      blogId,
      clientId,
      overallScore: 0,
      metaScore: 0,
      contentScore: 0,
      technicalScore: 0,
      linkScore: 0,
      imageScore: 0,
      pagesCrawled: 0,
      issuesFound: findings.length,
      criticalIssues,
      warnings,
      notices,
      rawData: { kind: "query_hygiene", families },
    })
    .returning({ id: seoScans.id });
  return scan.id;
}

/**
 * The per-blog hygiene pass — called from the GSC cron for each connected blog,
 * in the same run as S1 (one detector pass over fresh data). Four families, one
 * scan row. APPLY semantics by family:
 *   pin    → 'queued' + autoFixable: drains through S1's query_rescue branch on
 *            the next drain (same budgets, same live verify, same outcome loop)
 *   others → 'detected': recommendation rows a human approves/dismisses at /review
 */
export async function runQueryHygieneForBlog(
  blog: QueryHygieneBlogInput,
): Promise<QueryHygieneMetrics> {
  const metrics: QueryHygieneMetrics = {
    split: 0,
    folded: 0,
    pin: 0,
    dead: 0,
    opened: 0,
    skippedExisting: 0,
    generated: 0,
  };

  // One detector pass (spec §S2/§S8): four independent families in parallel —
  // each is fail-safe to [], so a broken family never blocks the others.
  const [splits, foldedFindings, pins, dead] = await Promise.all([
    detectQuerySplits(blog.id),
    detectFoldedCanonicals(blog.id),
    detectAccidentalRankers(blog.id),
    detectDeadWeightPages(blog.id),
  ]);

  metrics.split = splits.length;
  metrics.folded = foldedFindings.length;
  metrics.pin = pins.length;
  metrics.dead = dead.length;

  const findings: HygieneFinding[] = [...splits, ...foldedFindings, ...pins, ...dead];
  if (!findings.length) return metrics; // nothing to say — no writes at all

  // Upsert guard in ONE query (F4): any row already holding this key+page — in
  // ANY status, resolved included — wins. The partial unique index covers every
  // keyed row; the guard is what makes daily runs idempotent.
  const existingRows = await db
    .select({ issueKey: seoIssues.issueKey, pageUrl: seoIssues.pageUrl })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.blogId, blog.id),
        sql`(issue_key LIKE 'split:%' OR issue_key LIKE 'folded:%' OR issue_key LIKE 'pin:%' OR issue_key LIKE 'dead:%')`,
      ),
    );
  const existing = new Set(
    existingRows.map((r) => `${r.issueKey}\u0000${normalizeForMatch(r.pageUrl ?? "")}`),
  );

  // Best-first by volume so the generation budget spends on the biggest pins.
  findings.sort((a, b) => b.rankImpressions - a.rankImpressions);
  const toOpen = findings.filter((f) => {
    const hit = existing.has(`${f.issueKey}\u0000${normalizeForMatch(f.pageUrl)}`);
    if (hit) metrics.skippedExisting += 1;
    return !hit;
  });
  if (!toOpen.length) return metrics; // everything already in the ledger

  const scanId = await createHygieneScanRow(blog.id, blog.clientId, toOpen);

  // S6 dossier fetched ONCE per run — the single facts source (F3). A failure
  // degrades to "no dossier" text in the prompt; it never crashes a shard.
  const clientDossier = await getDossierForClient(blog.clientId).catch(() => null);
  let dossierBlock = "";
  if (clientDossier) {
    try {
      dossierBlock = buildDossierContextBlock(clientDossier);
    } catch {
      dossierBlock = "";
    }
  }

  // F7 shared generation budget, stateless + shard-safe: proposals this client
  // already opened TODAY across BOTH meta-generating families (page2:% and pin:)
  // — one cap on LLM meta spend per client-day. S1's own pass widens its count
  // identically, so the two passes can never double-spend.
  const [{ generatedToday }] = await db
    .select({ generatedToday: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, blog.clientId),
        sql`(issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')`,
        sql`${seoIssues.fixPayload}->>'proposedTitle' IS NOT NULL`,
        gte(seoIssues.detectedAt, sql`${gscToday()}::timestamp`),
      ),
    );

  for (const f of toOpen) {
    // Pin proposals happen at DETECTION time with S1's generator verbatim —
    // same prompt, same dossier grounding ("two detectors, one machine").
    if (f.family === "pin" && generatedToday + metrics.generated < RESCUE_MAX_GENERATED_PER_RUN) {
      metrics.generated += 1; // an attempt counts even when it fails
      const rescueFinding = {
        blogId: blog.id,
        query: String(f.fixPayload.targetQuery ?? ""),
        page: f.pageUrl,
        impressions90d: f.rankImpressions,
        clicks90d: Number(f.preSnapshot?.clicks90dBefore ?? 0),
        avgPosition:
          typeof f.preSnapshot?.avgPositionBefore === "number" ? f.preSnapshot.avgPositionBefore : 0,
        managed: true, // pin findings are managed by construction (F1)
        canonicalUrl: f.pageUrl,
        postId: null as string | null,
        severity: "warning" as const,
      };
      const proposal = await generateProposalForFinding(rescueFinding, dossierBlock, null);
      if (proposal) {
        f.fixPayload.proposedTitle = proposal.proposedTitle;
        f.fixPayload.proposedDescription = proposal.proposedDescription;
      }
    }

    await db.insert(seoIssues).values({
      scanId,
      blogId: blog.id,
      clientId: blog.clientId,
      pageUrl: f.pageUrl,
      category: f.category,
      severity: f.severity,
      title: f.title.slice(0, 500),
      description: f.description,
      suggestedFix: f.suggestedFix,
      fixPayload: f.fixPayload,
      status: f.autoFixable ? "queued" : "detected",
      autoFixable: f.autoFixable,
      issueKey: f.issueKey,
      preSnapshot: f.preSnapshot ?? null,
    });
    metrics.opened += 1;
  }

  console.log(
    `[query-hygiene] blog ${blog.id}: split=${metrics.split} folded=${metrics.folded} ` +
      `pin=${metrics.pin} dead=${metrics.dead} opened=${metrics.opened} ` +
      `skipped=${metrics.skippedExisting} generated=${metrics.generated}`,
  );
  return metrics;
}

// ─── §E rollout rows — client-facing ledger counts (under the sprint notes) ──

export interface HygieneOpenCounts {
  split: number;
  folded: number;
  pin: number;
  dead: number;
}

/** Open (undecided) hygiene rows for one client, by family. "Open" = the F4
 * lifecycle's pre-decision statuses only — a row the operator approved,
 * dismissed or applied never reappears in a client-facing count. */
export async function openHygieneCountsForClient(
  clientId: string,
): Promise<HygieneOpenCounts> {
  const rows = await db
    .select({ issueKey: seoIssues.issueKey })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        isNotNull(seoIssues.issueKey),
        inArray(seoIssues.status, ["detected", "queued"]),
      ),
    );
  const counts: HygieneOpenCounts = { split: 0, folded: 0, pin: 0, dead: 0 };
  for (const r of rows) {
    const k = String(r.issueKey ?? "");
    if (k.startsWith("split:")) counts.split += 1;
    else if (k.startsWith("folded:")) counts.folded += 1;
    else if (k.startsWith("pin:")) counts.pin += 1;
    else if (k.startsWith("dead:")) counts.dead += 1;
  }
  return counts;
}

/** The "consolidated under sprint notes" PDF line (§E rows for S2/S8).
 * All-zero → null: the PDF omits silence rather than printing an empty
 * promise (F8). Pure. */
export function hygieneNoteLine(counts: HygieneOpenCounts): string | null {
  const parts: string[] = [];
  if (counts.split > 0)
    parts.push(`${counts.split} keyword-split candidate${counts.split === 1 ? "" : "s"}`);
  if (counts.folded > 0)
    parts.push(`${counts.folded} folded page${counts.folded === 1 ? "" : "s"}`);
  if (counts.pin > 0)
    parts.push(`${counts.pin} accidental page-1 ranker${counts.pin === 1 ? "" : "s"}`);
  if (counts.dead > 0)
    parts.push(`${counts.dead} zero-traction page${counts.dead === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  return `Search items awaiting a decision: ${parts.join(" · ")}. Your account manager brings the recommendations to your next call.`;
}

// ─── §E S8 telemetry + the v1 hygiene ledger read (R5) ──────────────────────

/** F4 lifecycle: these are the PRE-decision statuses. Everything else in the
 * enum (approved / applied / verified / dismissed / failed) means the row was
 * decided — by a human, or honestly by a failed apply. */
const OPEN_STATUSES = ["detected", "queued"] as const;

/** Family from a keyed issue_key — null for keys outside the four hygiene
 * namespaces (S1's page2: rows belong to the rescue counts, never hygiene's). */
export function hygieneFamilyFromKey(
  issueKey: string | null,
): HygieneFamily | null {
  if (!issueKey) return null;
  const prefix = issueKey.split(":", 1)[0];
  if (prefix === "split" || prefix === "folded" || prefix === "pin" || prefix === "dead") {
    return prefix;
  }
  return null;
}

export interface HygieneLedgerTelemetry {
  open: HygieneOpenCounts;
  decided: HygieneOpenCounts;
}

/**
 * §E S8 telemetry row — per-family OPEN-vs-DECIDED counts over the existing
 * ledger (F4, pure counts; no new tables, no payload material). Network-wide
 * when `clientIds` is omitted (the gsc-sync cron response and the /review
 * card's detected-vs-decided line both read this), or scoped to the given
 * clients. Decided = every lifecycle state outside detected/queued, including
 * honestly-failed applies.
 */
export async function hygieneLedgerTelemetry(
  clientIds?: string[],
): Promise<HygieneLedgerTelemetry> {
  const rows = await db
    .select({ issueKey: seoIssues.issueKey, status: seoIssues.status })
    .from(seoIssues)
    .where(
      and(
        isNotNull(seoIssues.issueKey),
        inArray(seoIssues.status, [
          ...OPEN_STATUSES,
          "approved",
          "applied",
          "verified",
          "dismissed",
          "failed",
        ]),
        clientIds && clientIds.length > 0
          ? inArray(seoIssues.clientId, clientIds)
          : undefined,
      ),
    );

  const telemetry: HygieneLedgerTelemetry = {
    open: { split: 0, folded: 0, pin: 0, dead: 0 },
    decided: { split: 0, folded: 0, pin: 0, dead: 0 },
  };
  for (const r of rows) {
    const family = hygieneFamilyFromKey(r.issueKey ?? null);
    if (!family) continue;
    const bucket = (OPEN_STATUSES as readonly string[]).includes(r.status ?? "")
      ? telemetry.open
      : telemetry.decided;
    bucket[family] += 1;
  }
  return telemetry;
}

/** One-line renderer for the detected-vs-decided telemetry (the /review card).
 * Families with zero open AND zero decided are omitted; all-zero → null
 * (F8: no empty promise). Pure. */
export function hygieneDecisionLine(
  telemetry: HygieneLedgerTelemetry,
): string | null {
  const families: HygieneFamily[] = ["split", "folded", "pin", "dead"];
  const parts: string[] = [];
  for (const f of families) {
    const open = telemetry.open[f];
    const decided = telemetry.decided[f];
    if (open === 0 && decided === 0) continue;
    parts.push(`${f} ${open} open / ${decided} decided`);
  }
  if (parts.length === 0) return null;
  return `Detected vs decided — ${parts.join(" · ")}.`;
}

export interface HygieneLedgerRow {
  issueId: string;
  family: HygieneFamily;
  title: string;
  pageUrl: string | null;
  severity: string;
  /** Current F4 lifecycle state — the row is exposed WITH its decision state,
   * never its fixPayload or other internals. */
  status: string;
  autoFixable: boolean;
  /** ISO. The cursor field: stamped once at detection, never mutated, so
   * ?since= paging is stable. */
  detectedAt: string;
  /** First available decision stamp (resolvedAt → approvedAt → appliedAt →
   * verifiedAt, earliest wins), null while the row is still open. */
  decidedAt: string | null;
}

export interface HygieneLedgerQueryOptions {
  /** Strict lower bound on detectedAt (cursor / "since" reads). */
  since?: Date;
  limit?: number; // default 200, hard cap 500 — same clamps as rescues=1
}

/**
 * One client's hygiene ledger (split/folded/pin/dead only — S1's page2: rows
 * surface through rescues=1) for the v1 API's ?hygiene=1 cursor mode. Open
 * AND decided rows both appear (the §E parity rule: every ledger writer is
 * readable through the API), limited to public fields — no fixPayload, no
 * descriptions, no internals or secrets. Ordered by detectedAt asc so
 * ?since= is a stable forward cursor, identical conventions to rescues=1.
 */
export async function listHygieneIssues(
  clientId: string,
  opts: HygieneLedgerQueryOptions = {},
): Promise<HygieneLedgerRow[]> {
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 200)));
  const rows = await db
    .select({
      id: seoIssues.id,
      issueKey: seoIssues.issueKey,
      title: seoIssues.title,
      pageUrl: seoIssues.pageUrl,
      severity: seoIssues.severity,
      status: seoIssues.status,
      autoFixable: seoIssues.autoFixable,
      detectedAt: seoIssues.detectedAt,
      approvedAt: seoIssues.approvedAt,
      appliedAt: seoIssues.appliedAt,
      verifiedAt: seoIssues.verifiedAt,
      resolvedAt: seoIssues.resolvedAt,
    })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        isNotNull(seoIssues.issueKey),
        or(
          like(seoIssues.issueKey, "split:%"),
          like(seoIssues.issueKey, "folded:%"),
          like(seoIssues.issueKey, "pin:%"),
          like(seoIssues.issueKey, "dead:%"),
        ),
        opts.since ? gt(seoIssues.detectedAt, opts.since) : undefined,
      ),
    )
    .orderBy(asc(seoIssues.detectedAt), asc(seoIssues.id))
    .limit(limit);

  return rows.map((r) => {
    const stamps = [r.resolvedAt, r.approvedAt, r.appliedAt, r.verifiedAt]
      .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    const detected = r.detectedAt instanceof Date ? r.detectedAt : new Date(String(r.detectedAt));
    return {
      issueId: r.id,
      family: hygieneFamilyFromKey(r.issueKey ?? null) ?? "split",
      title: r.title,
      pageUrl: r.pageUrl,
      severity: r.severity,
      status: r.status ?? "detected",
      autoFixable: Boolean(r.autoFixable),
      detectedAt: Number.isNaN(detected.getTime()) ? "" : detected.toISOString(),
      decidedAt: stamps.length > 0 ? stamps[0].toISOString() : null,
    };
  });
}
