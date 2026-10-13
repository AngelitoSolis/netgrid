/**
 * lib/services/post-quality-score.ts
 *
 * Computes and persists the composite quality score for one published post.
 *
 * Kept OUT of the "use server" action files so it can be called from the
 * per-post scan runner, the SEO cron, and any backfill script, following the
 * same split as post-seo-runner.ts.
 *
 * Never throws into a publish path: the caller is fire-and-forget, and a
 * Search Console outage or a slow vector query must not be able to fail a
 * publish. Anything unexpected degrades to a null score with a reason.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs, generatedPosts } from "@/lib/db/schema";
import type { RawIssue } from "@/lib/seo/scanner";
import {
  computeQualityScore,
  duplicateFlagSimilarity,
  type HygieneCounts,
  type QualityBreakdown,
  type QualitySignals,
} from "@/lib/services/quality/score";
import {
  getDuplicationSignal,
  getVitalsSignal,
} from "@/lib/services/quality/signals";
import {
  getIndexationVerdict,
  getSearchRollup,
} from "@/lib/services/quality/gsc-signals";

export interface PostQualityResult {
  breakdown: QualityBreakdown;
  /**
   * Issues discovered while scoring that belong in the fix queue. Returned
   * rather than inserted here so the caller can write them in the same batch
   * as the scanner's own issues, under the same scan id.
   */
  extraIssues: RawIssue[];
}

const MS_PER_DAY = 86_400_000;

export async function computeAndPersistPostQuality(opts: {
  postId: string;
  blogId: string;
  pageUrl: string;
  publishedAt: Date | null;
  hygiene: HygieneCounts;
}): Promise<PostQualityResult> {
  const ageDays = opts.publishedAt
    ? Math.floor((Date.now() - opts.publishedAt.getTime()) / MS_PER_DAY)
    : null;

  // All four signals are independent reads — fetch them concurrently. Each one
  // already degrades to "unavailable with a reason" rather than throwing, so
  // Promise.all is safe here and a failure of one does not lose the others.
  const [indexation, search, duplication, vitals] = await Promise.all([
    getIndexationVerdict(opts.postId),
    getSearchRollup(opts.pageUrl, opts.blogId),
    getDuplicationSignal(opts.postId, opts.blogId),
    getVitalsSignal(opts.blogId),
  ]);

  const signals: QualitySignals = {
    indexation,
    search,
    duplication,
    vitals,
    hygiene: opts.hygiene,
  };

  const breakdown = computeQualityScore(signals, { ageDays });
  const maxSimilarity = duplication.available ? duplication.maxSimilarity : null;

  await db
    .update(generatedPosts)
    .set({
      // THE score column. Null is a legitimate, intended value.
      seoScore: breakdown.score,
      qualityBreakdown: breakdown,
      qualityScoredAt: new Date(),
      // decimal() columns take a string in Drizzle — same convention as
      // costUsd elsewhere in this codebase.
      maxSiblingSimilarity:
        maxSimilarity === null ? null : maxSimilarity.toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(generatedPosts.id, opts.postId));

  const extraIssues: RawIssue[] = [];
  const flagAt = duplicateFlagSimilarity();
  if (duplication.available && duplication.maxSimilarity >= flagAt) {
    extraIssues.push({
      pageUrl: opts.pageUrl,
      category: "content",
      severity: "critical",
      title: duplication.nearestIsSameBlog
        ? "Near-duplicate of another post on this blog"
        : "Near-duplicate of a post on another network blog",
      description:
        `Cosine similarity ${duplication.maxSimilarity.toFixed(3)} (flag threshold ${flagAt}) ` +
        `against "${duplication.nearestPostTitle ?? "untitled"}" (post ${duplication.nearestPostId}` +
        `${duplication.nearestIsSameBlog ? "" : `, blog ${duplication.nearestBlogId}`}). ` +
        `Two pages this similar compete for the same queries; search engines pick one and ` +
        `suppress the other. Rewrite the angle, merge them, or canonicalise one to the other.`,
      autoFixable: false,
    });
  }

  await recomputeBlogQualityScore(opts.blogId);

  return { breakdown, extraIssues };
}

/**
 * Refresh blogs.current_seo_score as the mean of the blog's PUBLISHED posts
 * that currently have a score.
 *
 * Null when the blog has no scored posts — never 0, and never a leftover from
 * a previous engine. This is the only writer of current_seo_score after T19;
 * every other path that used to set it has been removed.
 */
export async function recomputeBlogQualityScore(
  blogId: string,
): Promise<number | null> {
  const [row] = await db
    .select({
      scored: sql<number>`count(${generatedPosts.seoScore})::int`,
      avgScore: sql<number | null>`avg(${generatedPosts.seoScore})::int`,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, blogId),
        eq(generatedPosts.status, "published"),
      ),
    );

  const newScore = row && row.scored > 0 ? (row.avgScore ?? null) : null;

  await db
    .update(blogs)
    .set({
      currentSeoScore: newScore,
      lastSeoScanAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(blogs.id, blogId));

  return newScore;
}
