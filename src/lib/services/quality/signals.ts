/**
 * lib/services/quality/signals.ts
 *
 * DB-side signal gathering for the composite quality score. Every function
 * returns a discriminated "available / unavailable with a reason" union — a
 * signal we could not measure is never silently replaced with a number, and
 * the reason is persisted in the breakdown so an n/a can be explained without
 * re-running anything.
 */

import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogVitals, generatedPosts } from "@/lib/db/schema";
import type { DuplicationSignal, VitalsSignal } from "./score";

/** A vitals sample older than this is treated as no sample at all. */
export const VITALS_MAX_AGE_DAYS = 90;

/**
 * How many neighbours to pull from the ANN index network-wide. Over-fetched
 * on purpose: pgvector applies post-filters AFTER the index scan, so asking
 * for 1 and then filtering could legitimately return nothing.
 */
const ANN_CANDIDATES = 20;

interface NeighbourRow {
  id: string;
  blogId: string;
  title: string | null;
  status: string;
  similarity: number | string | null;
}

/**
 * Highest cosine similarity between this post and any OTHER published post.
 *
 * Returns the same-blog maximum (exact) and the network-wide maximum
 * (approximate, HNSW), plus the larger of the two as `maxSimilarity` — the
 * value the score actually penalises on. Both are reported because they mean
 * different things operationally: a same-blog duplicate is one client's
 * calendar repeating itself, a network duplicate is the template problem.
 *
 * Two queries on purpose. Same-blog similarity is computed EXACTLY: a blog has
 * tens to low hundreds of published posts, so a scan restricted by blog_id is
 * cheap and has no recall risk. Network-wide similarity runs against the whole
 * table and must use the HNSW index (generated_posts_embedding_idx,
 * vector_cosine_ops), so it is an APPROXIMATE nearest-neighbour search. That
 * distinction is recorded in the breakdown rather than hidden.
 *
 * Note the network query carries no status filter in SQL: pgvector applies
 * WHERE clauses AFTER the index returns its candidates, so filtering there can
 * return fewer rows than the LIMIT. It is filtered in JS over the over-fetched
 * candidate list instead.
 */
export async function getDuplicationSignal(
  postId: string,
  blogId: string,
): Promise<DuplicationSignal> {
  // Uncorrelated scalar subquery: Postgres evaluates it once as an InitPlan,
  // so the 1536-float vector never travels to the application. Same idiom as
  // findRelated() in lib/services/semantic-linking.ts.
  const targetEmbedding = sql`(select ${generatedPosts.embedding} from ${generatedPosts} where ${generatedPosts.id} = ${postId})`;
  const distance = sql`${generatedPosts.embedding} <=> ${targetEmbedding}`;
  const similarity = sql<number>`1 - (${generatedPosts.embedding} <=> ${targetEmbedding})`;

  const [self] = await db
    .select({ hasEmbedding: sql<boolean>`${generatedPosts.embedding} is not null` })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);

  if (!self?.hasEmbedding) {
    return {
      available: false,
      reason: "Post has no embedding yet (semantic-linking has not reached it)",
    };
  }

  // 1. Same blog — exact. Small candidate set, no ANN recall to worry about.
  const sameBlogRows = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      title: generatedPosts.title,
      status: sql<string>`${generatedPosts.status}::text`,
      similarity,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, blogId),
        ne(generatedPosts.id, postId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.embedding),
      ),
    )
    .orderBy(distance)
    .limit(1);

  // 2. Network-wide — approximate, via the HNSW index.
  const networkRows = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      title: generatedPosts.title,
      status: sql<string>`${generatedPosts.status}::text`,
      similarity,
    })
    .from(generatedPosts)
    .where(isNotNull(generatedPosts.embedding))
    .orderBy(distance)
    .limit(ANN_CANDIDATES);

  const norm = (rows: NeighbourRow[]) =>
    rows
      .filter((r) => r.id !== postId && r.status === "published")
      .map((r) => ({ ...r, sim: Number(r.similarity) }))
      .filter((r) => Number.isFinite(r.sim))
      .sort((a, b) => b.sim - a.sim);

  const sameBlogBest = norm(sameBlogRows as NeighbourRow[])[0] ?? null;
  const networkBest = norm(networkRows as NeighbourRow[])[0] ?? null;

  if (!sameBlogBest && !networkBest) {
    return {
      available: false,
      reason: "No other embedded published post to compare against",
    };
  }

  const best =
    !networkBest || (sameBlogBest && sameBlogBest.sim >= networkBest.sim)
      ? sameBlogBest!
      : networkBest;

  return {
    available: true,
    maxSimilarity: best.sim,
    sameBlogSimilarity: sameBlogBest ? sameBlogBest.sim : null,
    networkSimilarity: networkBest ? networkBest.sim : null,
    nearestPostId: best.id,
    nearestPostTitle: best.title,
    nearestBlogId: best.blogId,
    nearestIsSameBlog: best.blogId === blogId,
  };
}

/**
 * Newest usable Core Web Vitals sample for the blog's article template.
 * Per-blog, not per-post — see the blog_vitals comment in db/schema.ts.
 */
export async function getVitalsSignal(blogId: string): Promise<VitalsSignal> {
  const [row] = await db
    .select({
      lcpMs: blogVitals.lcpMs,
      clsX1000: blogVitals.clsX1000,
      tbtMs: blogVitals.tbtMs,
      sampledUrl: blogVitals.sampledUrl,
      error: blogVitals.error,
      fetchedAt: blogVitals.fetchedAt,
    })
    .from(blogVitals)
    .where(eq(blogVitals.blogId, blogId))
    .orderBy(desc(blogVitals.fetchedAt))
    .limit(1);

  if (!row) {
    return { available: false, reason: "No PageSpeed sample for this blog yet" };
  }

  const ageDays = Math.floor(
    (Date.now() - row.fetchedAt.getTime()) / 86_400_000,
  );
  if (ageDays > VITALS_MAX_AGE_DAYS) {
    return {
      available: false,
      reason: `PageSpeed sample is ${ageDays} days old (max ${VITALS_MAX_AGE_DAYS})`,
    };
  }

  if (row.lcpMs === null && row.clsX1000 === null && row.tbtMs === null) {
    return {
      available: false,
      reason: row.error ?? "PageSpeed returned no usable vitals",
    };
  }

  return {
    available: true,
    lcpMs: row.lcpMs,
    // Stored x1000; the scorer's thresholds are in real CLS units.
    cls: row.clsX1000 === null ? null : row.clsX1000 / 1000,
    tbtMs: row.tbtMs,
    sampledUrl: row.sampledUrl,
    sampleAgeDays: ageDays,
  };
}
