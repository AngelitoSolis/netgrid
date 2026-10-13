/**
 * lib/services/post-seo-runner.ts
 *
 * Core per-post SEO scan: fetch the live page (best effort), run the focused
 * scanner, and persist the result. Kept OUT of the "use server" action file so
 * it can be called two ways:
 *
 *   - scanGeneratedPost()  (post-seo-actions.ts) — admin-gated, manual button
 *   - scanPostAfterPublishFireAndForget() — fired right after a post publishes,
 *     so every newly-published post is scanned automatically. Mirrors the
 *     index-now fire-and-forget pattern: never blocks or fails the publish.
 */

import axios from "axios";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { generatedPosts, blogs, seoScans, seoIssues } from "@/lib/db/schema";
import { logActivity } from "@/lib/services/activity-logger";
import {
  recordPipelineError,
  trackBackground,
} from "@/lib/services/run-telemetry";
import { CRAWLER_DEFAULTS } from "@/lib/constants";
import { scanPost, type PostScanInput } from "@/lib/services/post-seo-scanner";
import { computeAndPersistPostQuality } from "@/lib/services/post-quality-score";

export interface ScanPostResult {
  success: boolean;
  message: string;
  /**
   * Tag-hygiene overall from the scanner (0-100). This is a DIAGNOSTIC number
   * for the fix queue, not the post's quality score — see qualityScore.
   */
  score?: number;
  /**
   * The composite quality score persisted on the post (0-100), or null when we
   * decline to publish one. Undefined only when scoring itself failed.
   */
  qualityScore?: number | null;
  /** One-line explanation, set whenever qualityScore is null or 0. */
  qualityReason?: string | null;
  issues?: number;
  metaSource?: "live" | "stored";
  /** Set on success — used by the action wrapper to revalidate the right paths. */
  blogId?: string;
  clientId?: string;
}

/**
 * Best-effort fetch of the live published page. Many destination stores are
 * password-walled dev shops that return 401/403 (or the request is blocked
 * outright) — in that case we return null and the scanner falls back to the
 * stored content, which is still a useful per-post audit.
 */
async function fetchLiveHtml(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: CRAWLER_DEFAULTS.requestTimeoutMs,
      headers: { "User-Agent": CRAWLER_DEFAULTS.userAgent },
      maxRedirects: 3,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === "string") {
      return res.data;
    }
    return null;
  } catch (err) {
    // Expected for password-walled dev shops; only interesting as a rate.
    recordPipelineError({
      site: "post-seo-runner.fetchLiveHtml",
      code: "LIVE_HTML_UNREACHABLE",
      severity: "warn",
      message: `Live page fetch failed, falling back to stored content: ${
        err instanceof Error ? err.message : String(err)
      }`,
      context: { url },
    });
    return null;
  }
}

/**
 * Scan a single GENERATED post for SEO issues and persist the result.
 *
 * Per-post replacement for the whole-site crawl: runs only against the one
 * post's stored content (and its live rendered <head> when reachable), writes
 * a seo_scans row for the post, and replaces any prior OPEN issues for that
 * exact page URL so re-scanning is idempotent.
 *
 * No auth check here — callers are trusted (an admin action, or the publish
 * pipeline). The admin gate lives in scanGeneratedPost().
 */
export async function runPostSeoScan(
  postId: string,
  opts: { userId?: string } = {},
): Promise<ScanPostResult> {
  const [post] = await db
    .select()
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);
  if (!post) return { success: false, message: "Post not found" };
  if (post.status !== "published") {
    return {
      success: false,
      message: "SEO is only scanned once a post is published.",
    };
  }

  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, post.blogId))
    .limit(1);
  if (!blog) return { success: false, message: "Blog not found" };

  const pageUrl = post.externalPostUrl?.trim() || null;
  if (!pageUrl) {
    return {
      success: false,
      message: "This post has no published URL to scan yet.",
    };
  }

  const liveHtml = await fetchLiveHtml(pageUrl);

  const input: PostScanInput = {
    platform: blog.platform,
    pageUrl,
    articleId: post.externalPostId,
    articleTitle: post.title,
    body: post.body,
    metaTitle: post.metaTitle,
    metaDescription: post.metaDescription,
    liveHtml,
  };

  const result = scanPost(input);

  // ── Composite quality score ──
  // ORDER IS LOAD-BEARING. The hygiene component reads THIS scan's issue
  // counts, so it must be computed before any issue this step produces is
  // appended below — otherwise a near-duplicate post is penalised twice, once
  // through the duplication component and again through hygiene.
  //
  // Never allowed to fail the scan: this runs from the publish path via
  // scanPostAfterPublishFireAndForget.
  let quality: Awaited<ReturnType<typeof computeAndPersistPostQuality>> | null = null;
  try {
    quality = await computeAndPersistPostQuality({
      postId: post.id,
      blogId: blog.id,
      pageUrl,
      publishedAt: post.publishedAt,
      hygiene: {
        criticalIssues: result.criticalIssues,
        warnings: result.warnings,
        notices: result.notices,
      },
    });
  } catch (err) {
    console.error(`[post-seo] quality scoring failed for post ${post.id}:`, err);
  }

  // Issues from the scanner plus anything scoring discovered (near-duplicates).
  const allIssues = [...result.issues, ...(quality?.extraIssues ?? [])];
  const criticalIssues = allIssues.filter((i) => i.severity === "critical").length;

  const [scan] = await db
    .insert(seoScans)
    .values({
      blogId: blog.id,
      clientId: blog.clientId,
      // Tag hygiene only. Kept so the historical trend in seo_scans stays a
      // like-for-like series; the post's quality score lives on the post row.
      overallScore: result.overallScore,
      metaScore: result.metaScore,
      contentScore: result.contentScore,
      technicalScore: result.technicalScore,
      linkScore: result.linkScore,
      imageScore: result.imageScore,
      pagesCrawled: 1,
      issuesFound: allIssues.length,
      criticalIssues,
      warnings: result.warnings,
      notices: result.notices,
      rawData: {
        kind: "post_scan",
        postId: post.id,
        pageUrl,
        metaSource: result.metaSource,
        qualityScore: quality?.breakdown.score ?? null,
        qualityReason: quality?.breakdown.reason ?? null,
        qualityCoverage: quality?.breakdown.coverage ?? null,
        indexation: quality?.breakdown.indexation ?? "unknown",
      },
      scanDurationMs: result.scanDurationMs,
    })
    .returning();

  // Idempotent re-scan: clear prior OPEN issues for this exact post URL so the
  // queue reflects the latest state instead of stacking duplicates. Applied /
  // failed / dismissed history is preserved.
  //
  // REGRESSION TRAP (migration 0056, S1): GSC-loop detectors (page-2 rescue,
  // query hygiene) write issues WITH a stable issue_key for the same post URL.
  // Without this guard this delete would wipe their detected/queued rows on the
  // next per-post scan of that page — the loop's memory would reset to zero
  // every time the post was republished or re-scanned. The scanner therefore
  // only manages legacy keyless rows; keyed rows are owned by their detector.
  await db
    .delete(seoIssues)
    .where(
      and(
        eq(seoIssues.blogId, blog.id),
        eq(seoIssues.pageUrl, pageUrl),
        inArray(seoIssues.status, ["detected", "queued"]),
        sql`issue_key IS NULL`,
      ),
    );

  if (allIssues.length > 0) {
    await db.insert(seoIssues).values(
      allIssues.map((issue) => ({
        scanId: scan.id,
        blogId: blog.id,
        clientId: blog.clientId,
        pageUrl: issue.pageUrl,
        category: issue.category,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        fixPayload: issue.fixPayload ?? null,
        autoFixable: issue.autoFixable,
        status: "detected" as const,
      })),
    );
  }

  // NOTE: generated_posts.seo_score is NOT written here any more. It used to
  // receive the tag-hygiene overall, which meant one column held a hygiene
  // number for scanned posts and the constant 70 for everything else. The
  // composite score is written by computeAndPersistPostQuality above, and it
  // is the only writer.

  await logActivity({
    userId: opts.userId,
    clientId: blog.clientId,
    action: "seo_post_scanned",
    entityType: "generated_post",
    entityId: post.id,
    details: {
      hygieneScore: result.overallScore,
      qualityScore: quality?.breakdown.score ?? null,
      qualityReason: quality?.breakdown.reason ?? null,
      indexation: quality?.breakdown.indexation ?? "unknown",
      issues: allIssues.length,
      metaSource: result.metaSource,
    },
  });

  const qualityText =
    quality === null
      ? "quality scoring failed"
      : quality.breakdown.score === null
        ? "quality n/a"
        : `quality ${quality.breakdown.score}`;

  return {
    success: true,
    message:
      allIssues.length === 0
        ? `Scan complete — no issues found (${qualityText}).`
        : `Scan complete — ${allIssues.length} issue${
            allIssues.length > 1 ? "s" : ""
          } found (${qualityText}).`,
    score: result.overallScore,
    qualityScore: quality ? quality.breakdown.score : undefined,
    qualityReason: quality?.breakdown.reason ?? null,
    issues: allIssues.length,
    metaSource: result.metaSource,
    blogId: blog.id,
    clientId: blog.clientId,
  };
}

/**
 * Fire-and-forget per-post scan, invoked right after a publish succeeds.
 * Never blocks or rejects into the publish path — failures are logged only.
 */
export function scanPostAfterPublishFireAndForget(postId: string): void {
  const task = runPostSeoScan(postId).catch((err) => {
    recordPipelineError({
      site: "post-seo-runner.autoScan",
      code: "POST_SCAN_FAILED",
      severity: "error",
      message: `auto-scan failed for post ${postId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      postId,
    });
  });
  // Bounded wait at run flush time only — this never delays an individual
  // publish, which is what the original fire-and-forget guaranteed.
  trackBackground(task);
}
