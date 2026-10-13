import { db } from "@/lib/db";
import { blogs, searchPerformance } from "@/lib/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Read-only rollups over search_performance. The cron already filled the
 * table (T04). These functions do not call Google.
 *
 * Position is an impression-weighted average. A row with impressions but a
 * page string that matches no generated_posts.external_post_url is still
 * counted here — this is the blog/query view, not the per-URL quality join.
 * "Not matched" is a property of that join (gsc-signals.ts), not of this
 * table, so it is not invented as a zero.
 */

export interface QueryRollup {
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface SearchWindowSummary {
  windowDays: number;
  clicks: number;
  impressions: number;
  position: number | null;
  queries: QueryRollup[];
  /** Blogs in scope with at least one row in the window. */
  blogsWithData: number;
  /** Active blogs in scope. Difference is "no Search Console rows", not a zero score. */
  blogsInScope: number;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pos(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function searchSummaryForClient(
  clientId: string,
  windowDays = 28,
): Promise<SearchWindowSummary> {
  const since = new Date(Date.now() - windowDays * 864e5).toISOString().slice(0, 10);

  const [scope] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));

  const [totals] = await db
    .select({
      clicks: sql<number>`coalesce(sum(${searchPerformance.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchPerformance.impressions}), 0)::int`,
      position: sql<string | null>`
        case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
          then sum(${searchPerformance.position} * ${searchPerformance.impressions})
               / sum(${searchPerformance.impressions})
          else null end`,
      blogs: sql<number>`count(distinct ${searchPerformance.blogId})::int`,
    })
    .from(searchPerformance)
    .where(
      and(eq(searchPerformance.clientId, clientId), gte(searchPerformance.date, since)),
    );

  const queries = await db
    .select({
      query: searchPerformance.query,
      clicks: sql<number>`coalesce(sum(${searchPerformance.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchPerformance.impressions}), 0)::int`,
      position: sql<string | null>`
        case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
          then sum(${searchPerformance.position} * ${searchPerformance.impressions})
               / sum(${searchPerformance.impressions})
          else null end`,
    })
    .from(searchPerformance)
    .where(
      and(eq(searchPerformance.clientId, clientId), gte(searchPerformance.date, since)),
    )
    .groupBy(searchPerformance.query)
    .orderBy(sql`sum(${searchPerformance.impressions}) desc`)
    .limit(25);

  return {
    windowDays,
    clicks: num(totals?.clicks),
    impressions: num(totals?.impressions),
    position: pos(totals?.position),
    blogsWithData: num(totals?.blogs),
    blogsInScope: num(scope?.n),
    queries: queries
      .filter((q) => q.query && q.query.trim().length > 0)
      .map((q) => ({
        query: q.query,
        clicks: num(q.clicks),
        impressions: num(q.impressions),
        position: pos(q.position),
      })),
  };
}

export async function searchSummaryForBlog(
  blogId: string,
  windowDays = 28,
): Promise<SearchWindowSummary> {
  const since = new Date(Date.now() - windowDays * 864e5).toISOString().slice(0, 10);

  const [totals] = await db
    .select({
      clicks: sql<number>`coalesce(sum(${searchPerformance.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchPerformance.impressions}), 0)::int`,
      position: sql<string | null>`
        case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
          then sum(${searchPerformance.position} * ${searchPerformance.impressions})
               / sum(${searchPerformance.impressions})
          else null end`,
    })
    .from(searchPerformance)
    .where(and(eq(searchPerformance.blogId, blogId), gte(searchPerformance.date, since)));

  const queries = await db
    .select({
      query: searchPerformance.query,
      clicks: sql<number>`coalesce(sum(${searchPerformance.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${searchPerformance.impressions}), 0)::int`,
      position: sql<string | null>`
        case when coalesce(sum(${searchPerformance.impressions}), 0) > 0
          then sum(${searchPerformance.position} * ${searchPerformance.impressions})
               / sum(${searchPerformance.impressions})
          else null end`,
    })
    .from(searchPerformance)
    .where(and(eq(searchPerformance.blogId, blogId), gte(searchPerformance.date, since)))
    .groupBy(searchPerformance.query)
    .orderBy(sql`sum(${searchPerformance.impressions}) desc`)
    .limit(25);

  const impressions = num(totals?.impressions);
  return {
    windowDays,
    clicks: num(totals?.clicks),
    impressions,
    position: pos(totals?.position),
    blogsWithData: impressions > 0 || num(totals?.clicks) > 0 ? 1 : 0,
    blogsInScope: 1,
    queries: queries
      .filter((q) => q.query && q.query.trim().length > 0)
      .map((q) => ({
        query: q.query,
        clicks: num(q.clicks),
        impressions: num(q.impressions),
        position: pos(q.position),
      })),
  };
}
