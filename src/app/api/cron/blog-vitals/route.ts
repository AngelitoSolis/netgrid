import { NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogVitals, blogs, generatedPosts } from "@/lib/db/schema";
import { runPageSpeedAudit } from "@/lib/services/pagespeed-client";

// PSI is slow by design (the client allows 60s per call). 60 blogs at
// concurrency 6 is ~10 sequential batches — budget accordingly.
export const maxDuration = 600;

/**
 * Core Web Vitals sampler.
 *
 * Runs one PageSpeed Insights mobile audit per blog against a REPRESENTATIVE
 * PUBLISHED ARTICLE (falling back to the site root only when the blog has no
 * published post with a URL), and stores the vitals in blog_vitals. The
 * quality score's CWV component reads the newest row per blog.
 *
 * Why per blog and not per post: LCP, CLS and TBT are properties of the theme,
 * the image pipeline and the host — all constant across a blog's articles.
 * Per-post sampling would multiply the PSI cost by ~1000 to measure the same
 * thing repeatedly.
 *
 * Why an article and not the homepage: the old rescanBlogScore audited
 * blog.wpUrl, the site root, and labelled the result "this blog's SEO score".
 * The homepage runs a different template from the article pages the network
 * actually publishes.
 *
 * Query params (cron-secret protected):
 *   ?limit=N        blogs per run        (default 60, 1..200)
 *   ?concurrency=N  parallel PSI calls   (default 6, 1..10)
 *   ?maxAgeDays=N   re-sample threshold  (default 30, 1..365)
 *   ?blogId=UUID    sample exactly one blog, ignoring the age filter
 */

interface VitalsOutcome {
  blogId: string;
  domain: string;
  url: string;
  ok: boolean;
  lcpMs?: number;
  clsX1000?: number;
  tbtMs?: number;
  performance?: number | null;
  error?: string;
}

function clampInt(
  v: string | undefined | null,
  min: number,
  max: number,
  def: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

async function runInParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results.push(await fn(items[i]));
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
      worker(),
    ),
  );
  return results;
}

/** Newest published article URL for a blog, or the site root as a fallback. */
async function sampleUrlFor(
  blog: typeof blogs.$inferSelect,
): Promise<string | null> {
  const [post] = await db
    .select({ url: generatedPosts.externalPostUrl })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, blog.id),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostUrl),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(1);

  if (post?.url) return post.url;
  if (blog.wpUrl) return blog.wpUrl;
  if (blog.shopifyStoreUrl) return blog.shopifyStoreUrl;
  return blog.domain ? `https://${blog.domain}` : null;
}

async function sampleBlog(
  blog: typeof blogs.$inferSelect,
): Promise<VitalsOutcome> {
  const url = await sampleUrlFor(blog);
  if (!url) {
    return {
      blogId: blog.id,
      domain: blog.domain,
      url: "",
      ok: false,
      error: "No URL to sample",
    };
  }

  const psi = await runPageSpeedAudit(url, "mobile");

  // A failed audit is still recorded, with its reason and null metrics. That
  // is deliberate: without a row the age filter would re-select this blog on
  // every single run, and a permanently unreachable site would starve the
  // queue for everyone else.
  await db.insert(blogVitals).values({
    blogId: blog.id,
    clientId: blog.clientId,
    strategy: "mobile",
    sampledUrl: url,
    lcpMs: psi.vitals.lcp ?? null,
    fcpMs: psi.vitals.fcp ?? null,
    clsX1000: psi.vitals.cls ?? null,
    tbtMs: psi.vitals.tbt ?? null,
    inpMs: psi.vitals.inp ?? null,
    speedIndexMs: psi.vitals.speedIndex ?? null,
    lighthousePerformance: psi.scores.performance,
    error: psi.error ?? null,
  });

  return {
    blogId: blog.id,
    domain: blog.domain,
    url,
    ok: !psi.error,
    lcpMs: psi.vitals.lcp,
    clsX1000: psi.vitals.cls,
    tbtMs: psi.vitals.tbt,
    performance: psi.scores.performance,
    error: psi.error,
  };
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = clampInt(
    url.searchParams.get("limit") ?? process.env.BLOG_VITALS_BATCH_SIZE ?? "60",
    1,
    200,
    60,
  );
  const concurrency = clampInt(
    url.searchParams.get("concurrency") ?? process.env.BLOG_VITALS_CONCURRENCY ?? "6",
    1,
    10,
    6,
  );
  const maxAgeDays = clampInt(url.searchParams.get("maxAgeDays"), 1, 365, 30);
  const onlyBlogId = url.searchParams.get("blogId");

  if (!process.env.GOOGLE_PAGESPEED_API_KEY) {
    // Without a key PSI allows roughly 50 requests per 100 seconds per IP,
    // so a batch of 60 would be throttled into mostly-failed rows — and those
    // rows would then suppress re-sampling for maxAgeDays. Refuse instead.
    return NextResponse.json(
      {
        error:
          "GOOGLE_PAGESPEED_API_KEY is not set. Refusing to run: unauthenticated " +
          "PSI would rate-limit this batch and persist failure rows.",
      },
      { status: 503 },
    );
  }

  try {
    const targets = onlyBlogId
      ? await db.select().from(blogs).where(eq(blogs.id, onlyBlogId)).limit(1)
      : await db
          .select()
          .from(blogs)
          .where(
            and(
              inArray(blogs.status, ["active", "setup"]),
              sql`NOT EXISTS (
                SELECT 1 FROM ${blogVitals}
                 WHERE ${blogVitals.blogId} = ${blogs.id}
                   AND ${blogVitals.fetchedAt} > now() - (${maxAgeDays}::int * interval '1 day')
              )`,
            ),
          )
          .orderBy(asc(blogs.createdAt))
          .limit(limit);

    if (targets.length === 0) {
      return NextResponse.json({
        message: `No blog is due for a vitals sample (all sampled within ${maxAgeDays} days).`,
        limit,
        concurrency,
      });
    }

    const startedAt = Date.now();
    const outcomes = await runInParallel(targets, concurrency, sampleBlog);
    const totalDurationMs = Date.now() - startedAt;

    const sampled = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - sampled;

    console.info(
      `[blog-vitals] ${outcomes.length} blog(s) in ${totalDurationMs}ms — ` +
        `sampled=${sampled} failed=${failed} (limit=${limit}, concurrency=${concurrency})`,
    );

    return NextResponse.json({
      considered: targets.length,
      sampled,
      failed,
      limit,
      concurrency,
      maxAgeDays,
      totalDurationMs,
      results: outcomes,
    });
  } catch (error) {
    console.error("blog-vitals cron error:", error);
    return NextResponse.json(
      {
        error: "Vitals batch failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
