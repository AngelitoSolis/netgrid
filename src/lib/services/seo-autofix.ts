import { db } from "@/lib/db";
import { seoIssues, blogs, clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateSeoFix, generateRescueMeta } from "@/lib/services/claude-client";
import * as wp from "@/lib/services/wp-client";
import { injectArticleSchema } from "@/lib/services/wp-seo-injector";
import {
  backfillPostSeo,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "@/lib/services/platform-client";
import { recomputeBlogQualityScore } from "@/lib/services/post-quality-score";
import {
  appendBrandToTitle,
  capMetaDescription,
} from "@/lib/seo/meta-suffix";
import { resolveBylineForBlog } from "@/lib/services/author-entity";
import { verifyLiveMeta } from "@/lib/services/wp-meta-verify";
import { rescueApplyBudgetLeft } from "./page2-rescue";
import {
  authorIdentityFrom,
  extractFaqFromHtml,
  siteIdentityForBlog,
} from "@/lib/seo/structured-data";

export interface AutoFixResult {
  issueId: string;
  applied: boolean;
  message: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First <img src> in an HTML string, if any. */
function firstImageSrc(html: string): string | null {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * Plugin-independent SEO for WordPress blogs with NO SEO plugin: inject an
 * idempotent JSON-LD Article block carrying the meta description into the post
 * body (Google reads JSON-LD anywhere). No-op for Yoast/RankMath sites, which
 * already emit schema. Returns a short note to append to the fix message, or
 * "" when nothing was done.
 */
/**
 * The blog's real author as a plain shape for structured-data's adapter, or
 * null when there is none on file. Never throws.
 */
async function resolvedAuthorForBlog(blogId: string) {
  try {
    const ctx = await resolveBylineForBlog(blogId);
    return ctx?.author ?? null;
  } catch {
    return null;
  }
}

async function injectSchemaForPluginlessWp(
  blog: typeof blogs.$inferSelect,
  post: wp.WpPost,
  description: string,
): Promise<string> {
  if (blog.seoPlugin !== "none") return "";
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) return "";

  const res = await injectArticleSchema(
    {
      wpUrl: blog.wpUrl,
      username: blog.wpUsername,
      appPassword: blog.wpAppPassword,
    },
    post.id,
    {
      url: post.link,
      headline: stripHtml(post.title?.rendered || ""),
      description,
      datePublished: post.date_gmt ? `${post.date_gmt}Z` : null,
      dateModified: post.modified_gmt ? `${post.modified_gmt}Z` : null,
      publisherName: blog.domain,
      imageUrl: firstImageSrc(post.content?.rendered || ""),
      // Full entity graph (T20). This is the ONLY structured data a
      // plugin-less WordPress page will ever have, so the Article node here is
      // enrichment rather than duplication — unlike the pre-publish body block,
      // which deliberately emits FAQPage + BreadcrumbList only.
      site: siteIdentityForBlog(blog),
      // Resolved author (T12). Null => Organization-as-author, which is honest.
      author: authorIdentityFrom(await resolvedAuthorForBlog(blog.id)),
      // Read back out of the LIVE body, so the markup can only ever claim
      // answers the reader can actually see.
      faq: extractFaqFromHtml(post.content?.rendered || ""),
    },
  );

  if (!res.ok) return ` · schema not injected: ${res.message}`;
  return res.persisted
    ? " · Article schema injected"
    : ` · ${res.message}`;
}

async function markApplied(issueId: string, fixSummary: string) {
  await db
    .update(seoIssues)
    .set({
      status: "applied",
      appliedAt: new Date(),
      suggestedFix: fixSummary,
    })
    .where(eq(seoIssues.id, issueId));
}

async function markFailed(issueId: string, reason: string) {
  await db
    .update(seoIssues)
    .set({ status: "failed", failureReason: reason })
    .where(eq(seoIssues.id, issueId));
}

/**
 * Resolve the value to write for a meta title/description fix. Prefers the
 * existing on-page text (a "too long" field just needs trimming — no LLM call,
 * so it also works when the model's credit is out); only generates when there's
 * no usable source text. Returns whitespace-collapsed text (still needs the
 * caller's pixel truncation).
 */
async function resolveMetaValue(opts: {
  source: string | null | undefined;
  generate: () => Promise<string>;
}): Promise<string> {
  const s = (opts.source ?? "").replace(/\s+/g, " ").trim();
  if (s) return s;
  return (await opts.generate()).replace(/\s+/g, " ").trim();
}

/**
 * Shortest value we will ever write to a live meta field. Anything shorter is
 * not a meta description or a title — it is a failed generation.
 */
const MIN_META_CHARS = 15;

/**
 * Refuse to write a meta value the model didn't actually produce.
 *
 * callFixModel returns "" (not a throw) when a provider returns no content —
 * DeepSeek with no choices, or an Anthropic response with no text block (see
 * claude-client.ts:69-83). Before T01 that empty string flowed into
 * appendRedditToTitle("") and wrote the literal word "Reddit" to live title
 * tags. Throwing here lands in the caller's catch, which marks the issue
 * failed and leaves it retryable.
 */
function assertUsableMeta(
  value: string,
  kind: "meta_title" | "meta_description",
): string {
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length < MIN_META_CHARS) {
    throw new Error(
      `Refusing to write a ${kind} of ${v.length} character(s) ("${v}") — ` +
        `the model returned nothing usable. Issue left unfixed for a retry.`,
    );
  }
  return v;
}

/**
 * Decide what kind of fix this issue calls for from its title text.
 * lib/seo/scanner and lib/services/post-seo-scanner generate titles like "Missing meta description" or
 * "Meta description too short (under 120 chars)".
 */
function classifyIssue(title: string):
  | "meta_description"
  | "meta_title"
  | "og_image"
  | "og_title"
  | "og_description"
  | "alt_text"
  | "unknown" {
  const lower = title.toLowerCase();
  if (lower.includes("meta description")) return "meta_description";
  if (lower.includes("title tag")) return "meta_title";
  if (lower.includes("open graph image") || lower.includes("og:image")) return "og_image";
  if (lower.includes("open graph title") || lower.includes("og:title")) return "og_title";
  if (lower.includes("open graph description") || lower.includes("og:description"))
    return "og_description";
  if (lower.includes("alt text")) return "alt_text";
  return "unknown";
}

/**
 * Resolve the fix kind from the stored fixPayload.type first (set by the
 * scanner), falling back to the title-text classifier. The Shopify scanner's
 * issue titles differ from WordPress's ("Missing article excerpt" vs "Missing
 * meta description"), so payload-type routing is what makes the queue
 * platform-agnostic.
 */
function classifyFix(
  issue: typeof seoIssues.$inferSelect,
): ReturnType<typeof classifyIssue> {
  const type = (issue.fixPayload as { type?: string } | null)?.type;
  if (type === "shopify_meta_description" || type === "wp_meta_description") {
    return "meta_description";
  }
  if (type === "shopify_meta_title" || type === "wp_meta_title") {
    return "meta_title";
  }
  return classifyIssue(issue.title);
}

/** Build the platform-router blog shape from a DB row. */
function blogToPlatformBlog(blog: typeof blogs.$inferSelect): PlatformBlog {
  return {
    platform: blog.platform,
    wpUrl: blog.wpUrl,
    wpUsername: blog.wpUsername,
    wpAppPassword: blog.wpAppPassword,
    seoPlugin: blog.seoPlugin,
    shopifyAuthMode: blog.shopifyAuthMode,
    shopifyStoreUrl: blog.shopifyStoreUrl,
    shopifyAdminApiToken: blog.shopifyAdminApiToken,
    shopifyClientId: blog.shopifyClientId,
    shopifyClientSecret: blog.shopifyClientSecret,
    shopifyBlogHandle: blog.shopifyBlogHandle,
  };
}

/**
 * Apply a Shopify SEO fix. Writes the global.title_tag / description_tag
 * metafields (the values the theme renders) via the platform router —
 * the same write path the bulk backfill uses, now reachable from the
 * per-issue fix queue. The article id comes from the scanner's fixPayload.
 */
async function autoFixShopifyIssue(
  issue: typeof seoIssues.$inferSelect,
  blog: typeof blogs.$inferSelect,
  niche: string,
): Promise<AutoFixResult> {
  const issueId = issue.id;
  const payload = (issue.fixPayload ?? {}) as {
    type?: string;
    articleId?: number | string;
    articleTitle?: string;
    excerpt?: string;
    pageUrl?: string;
  };
  const articleId = payload.articleId != null ? String(payload.articleId) : null;
  if (!articleId) {
    // These come from the sitemap crawler (products, collections, sitemap
    // files, anchors) which blanket-flags "missing meta description" as
    // auto-fixable. netgrid can only write a blog ARTICLE's metafields, so a
    // non-article page has no fix target. Demote it to manual (instead of a
    // cryptic error) so the Apply button stops offering an impossible fix.
    await db
      .update(seoIssues)
      .set({ autoFixable: false })
      .where(eq(seoIssues.id, issueId));
    return {
      issueId,
      applied: false,
      message:
        "This page isn't a blog article — product / collection / sitemap meta can't be auto-fixed here. Marked as manual.",
    };
  }

  const platformBlog = blogToPlatformBlog(blog);
  const kind = classifyFix(issue);
  const pageUrl = issue.pageUrl || payload.pageUrl || "";

  try {
    if (kind !== "meta_description" && kind !== "meta_title") {
      return {
        issueId,
        applied: false,
        message: `Auto-fix not implemented for Shopify: ${issue.title}`,
      };
    }

    const issueType = kind === "meta_title" ? "meta_title" : "meta_description";
    // Prefer a mechanical fix: a "too long" title/description just needs the
    // existing text trimmed to the pixel budget — no LLM call (which also fails
    // when the model's credit is out). Fall back to generating only when we
    // have no source text (e.g. a genuinely missing field with no body).
    const source =
      kind === "meta_title"
        ? (payload.articleTitle || "").trim()
        : (payload.excerpt || "").trim();
    let cleaned: string;
    if (source) {
      cleaned = source.replace(/\s+/g, " ").trim();
    } else {
      const generated = await generateSeoFix({
        niche,
        blogDomain: blog.domain,
        pageUrl,
        pageTitle: payload.articleTitle || "",
        pageContentExcerpt: payload.excerpt || "",
        issueType,
        issueDescription: issue.description || issue.title,
      });
      cleaned = generated.replace(/\s+/g, " ").trim();
    }
    // Never write a value the model didn't produce (see assertUsableMeta).
    const checked = assertUsableMeta(cleaned, issueType);
    // Brand suffix + pixel cap. Shopify writes go to the global.title_tag /
    // description_tag metafields, never to the visible article title. The
    // suffix is a no-op when blogs.brand_name is null — which is the correct
    // setting for a store whose theme already appends "– Store Name" to the
    // rendered <title> (see seo-backfill-actions.ts:71-74).
    const trimmed =
      kind === "meta_title"
        ? appendBrandToTitle(checked, blog.brandName)
        : capMetaDescription(checked);

    // Resolve the numeric blog id once so updateArticle hits the right blog.
    const shopifyBlogId = (await resolveShopifyBlogId(platformBlog))?.blogId;
    const push = await backfillPostSeo(
      platformBlog,
      articleId,
      kind === "meta_title"
        ? { metaTitle: trimmed }
        : // Write both the description_tag metafield (what renders) AND the
          // excerpt (summary_html) — the scanner flags a missing excerpt, so
          // setting it is what makes the fix clear on the next re-scan.
          { metaDescription: trimmed, excerptHtml: trimmed },
      shopifyBlogId,
    );
    if (!push.success) {
      await markFailed(issueId, push.message);
      return { issueId, applied: false, message: push.message };
    }
    await markApplied(issueId, `${issueType}: ${trimmed}`);
    return {
      issueId,
      applied: true,
      message: `${issueType} set on Shopify article ${articleId}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await markFailed(issueId, message);
    return { issueId, applied: false, message };
  }
}

/**
 * Refresh a blog's headline score after fixes were applied.
 *
 * Previously this ran a PageSpeed audit against the SITE ROOT and wrote
 * Lighthouse's "seo" category number — a binary on-page checklist that any
 * valid page passes, which returned 90-100 for every blog in the network and
 * could not fall when a site was deindexed. For Shopify it wrote the
 * tag-hygiene scan instead, so the same column held two different metrics
 * depending on platform, and the portal averaged the two together.
 *
 * It now recomputes the one composite score: the mean of the blog's published
 * posts' quality scores. No network call, no platform branch, same return
 * shape for the Apply / Apply All UI.
 *
 * IMPORTANT for whoever wires the UI copy: applying a meta fix moves this
 * number only via the 15%-weighted hygiene component, and only AFTER the
 * affected posts are re-scanned. An immediate delta of 0 here is correct
 * behaviour, not a bug — do not "fix" it by re-introducing a fast proxy metric.
 */
export async function rescanBlogScore(
  blogId: string,
): Promise<{ previousScore: number | null; newScore: number | null; delta: number | null; error?: string }> {
  const [blog] = await db.select().from(blogs).where(eq(blogs.id, blogId)).limit(1);
  if (!blog) {
    return { previousScore: null, newScore: null, delta: null, error: "Blog not found" };
  }

  const previousScore = blog.currentSeoScore;
  const newScore = await recomputeBlogQualityScore(blogId);

  if (newScore === null) {
    return {
      previousScore,
      newScore: null,
      delta: null,
      error:
        "No published post on this blog has a quality score yet — the blog score is n/a.",
    };
  }

  return {
    previousScore,
    newScore,
    delta: previousScore !== null ? newScore - previousScore : null,
  };
}

/**
 * Apply a single auto-fixable SEO issue end-to-end:
 *   1. Look up the WordPress post by URL (via slug)
 *   2. Generate the new value via Claude (using post title + excerpt as context)
 *   3. PATCH the post via REST — uses Yoast / RankMath / native excerpt depending
 *      on which SEO plugin the blog has configured
 *   4. Mark the issue applied (or failed with a reason)
 */
export async function autoFixIssue(issueId: string): Promise<AutoFixResult> {
  const [issue] = await db
    .select()
    .from(seoIssues)
    .where(eq(seoIssues.id, issueId))
    .limit(1);
  if (!issue) return { issueId, applied: false, message: "Issue not found" };
  if (!issue.autoFixable) return { issueId, applied: false, message: "Not auto-fixable" };
  if (issue.status === "applied" || issue.status === "verified") {
    return { issueId, applied: true, message: "Already applied" };
  }

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, issue.blogId)).limit(1);
  if (!blog) {
    await markFailed(issueId, "Blog not found");
    return { issueId, applied: false, message: "Blog not found" };
  }

  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, issue.clientId))
    .limit(1);
  const niche = client?.niche || "general";

  // Shopify fixes run through the platform router (writes the SEO metafields),
  // not the WordPress REST path below.
  if (blog.platform === "shopify") {
    return autoFixShopifyIssue(issue, blog, niche);
  }

  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    await markFailed(issueId, "Blog WP credentials missing");
    return { issueId, applied: false, message: "Blog credentials missing" };
  }

  const post = await wp.findPostByUrl(
    blog.wpUrl,
    blog.wpUsername,
    blog.wpAppPassword,
    issue.pageUrl || "",
  );
  if (!post) {
    await markFailed(issueId, `Could not find a WordPress post matching ${issue.pageUrl}`);
    return { issueId, applied: false, message: "Post not found" };
  }

  const kind = classifyFix(issue);
  const pageTitle = post.title?.rendered || "";
  const pageExcerpt = stripHtml(post.excerpt?.rendered || post.content?.rendered || "").slice(
    0,
    600,
  );

  try {
    // ── S1 page-2 rescue (GSC loop): deterministic apply of the detection-time
    // proposal. fixPayload.kind is the dispatch identity — classifyFix only ever
    // sees scanner-shaped titles, and a rescue row must never fall through to
    // the generic meta branches with their own LLM calls.
    const rescuePayload = (issue.fixPayload ?? null) as {
      kind?: string;
      targetQuery?: string;
      proposedTitle?: string | null;
      proposedDescription?: string | null;
    } | null;
    if (rescuePayload?.kind === "query_rescue") {
      const budget = await rescueApplyBudgetLeft(blog.id);
      if (budget.networkLeft <= 0 || budget.blogLeft <= 0) {
        // Stay 'queued' — the next run's drain picks it up. Not a failure: the
        // fix is ready, only today's live-write budget is spent.
        return {
          issueId,
          applied: false,
          message: "Page-2 rescue apply budget exhausted for today — stays queued",
        };
      }

      let rescueTitle = (rescuePayload.proposedTitle ?? "").replace(/\s+/g, " ").trim();
      let rescueDescription = (rescuePayload.proposedDescription ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!rescueTitle || !rescueDescription) {
        // Detection-time generation failed — retry ONCE here with the live post
        // as context. Still one call, still dossier-grounded (F3).
        const before = (issue.preSnapshot ?? {}) as Record<string, unknown>;
        const meta = await generateRescueMeta({
          query: rescuePayload.targetQuery || "",
          avgPosition:
            typeof before.avgPositionBefore === "number" ? before.avgPositionBefore : 0,
          impressions90d:
            typeof before.impressions90dBefore === "number" ? before.impressions90dBefore : 0,
          currentTitle: pageTitle || null,
          currentDescription: null,
          pageExcerpt,
          niche,
          dossierContext:
            "(no dossier fetched at apply time — rely on the post's own content and do not invent facts)",
        });
        rescueTitle = meta.title;
        rescueDescription = meta.description;
      }
      if (!rescueTitle || !rescueDescription) {
        await markFailed(
          issueId,
          "Rescue meta generation produced nothing usable (detection-time and apply-time retry both empty).",
        );
        return { issueId, applied: false, message: "Rescue meta generation returned nothing" };
      }

      // Same pixel caps + brand-suffix rules as every other title/description
      // write in this file — one style network-wide.
      const trimmedTitle = appendBrandToTitle(
        assertUsableMeta(rescueTitle, "meta_title"),
        blog.seoPlugin === "yoast" || blog.seoPlugin === "rankmath" ? blog.brandName : null,
      );
      const trimmedDescription = capMetaDescription(assertUsableMeta(rescueDescription, "meta_description"));

      await applyMetaTitle(blog, post.id, trimmedTitle);
      await applyMetaDescription(blog, post.id, trimmedDescription);
      let schemaNote = "";
      if (blog.seoPlugin === "none") {
        schemaNote = await injectSchemaForPluginlessWp(blog, post, trimmedDescription);
      }

      // LIVE VERIFY before marking applied — an HTTP 200 from WP is not proof
      // the meta rendered. verified===null (unreachable page) still counts as
      // applied: the outcome loop measures via GSC data either way.
      const verification = await verifyLiveMeta(issue.pageUrl || "", {
        title: trimmedTitle,
        description: trimmedDescription,
      });
      if (verification.verified === false) {
        await markFailed(
          issueId,
          `Live verification failed: ${verification.reason} — observed title "${verification.observed.title ?? "(none)"}"`,
        );
        return {
          issueId,
          applied: false,
          message: `Rescue write did not land live: ${verification.reason}`,
        };
      }

      const verifyNote = verification.verified
        ? " · live-verified"
        : " · live page unreachable — outcome loop will measure via GSC";
      await markApplied(
        issueId,
        `page2 rescue "${rescuePayload.targetQuery}": title → ${trimmedTitle} | description → ${trimmedDescription}${verifyNote}`,
      );
      return {
        issueId,
        applied: true,
        message: `Page-2 rescue for "${rescuePayload.targetQuery}" applied to post ${post.id}${schemaNote}${verifyNote}`,
      };
    }

    if (kind === "meta_description") {
      const cleaned = await resolveMetaValue({
        source: pageExcerpt,
        generate: () =>
          generateSeoFix({
            niche,
            blogDomain: blog.domain,
            pageUrl: issue.pageUrl || "",
            pageTitle,
            pageContentExcerpt: pageExcerpt,
            issueType: "meta_description",
            issueDescription: issue.description || issue.title,
          }),
      });
      const trimmed = capMetaDescription(
        assertUsableMeta(cleaned, "meta_description"),
      );
      await applyMetaDescription(blog, post.id, trimmed);
      // Plugin-less sites can't render a <meta name="description"> — also drop
      // the description into JSON-LD Article schema in the body so it counts.
      const schemaNote = await injectSchemaForPluginlessWp(blog, post, trimmed);
      await markApplied(issueId, `meta description: ${trimmed}`);
      return {
        issueId,
        applied: true,
        message: `Meta description set on post ${post.id}${schemaNote}`,
      };
    }

    if (kind === "meta_title") {
      const cleaned = await resolveMetaValue({
        source: pageTitle,
        generate: () =>
          generateSeoFix({
            niche,
            blogDomain: blog.domain,
            pageUrl: issue.pageUrl || "",
            pageTitle,
            pageContentExcerpt: pageExcerpt,
            issueType: "meta_title",
            issueDescription: issue.description || issue.title,
          }),
      });
      // Only Yoast / RankMath own a separate title tag. With seoPlugin
      // "none", applyMetaTitle below falls back to wp.updatePost({ title }),
      // which rewrites the reader-facing post title — so no brand suffix
      // there. Pixel capping still applies in both cases.
      const trimmed = appendBrandToTitle(
        assertUsableMeta(cleaned, "meta_title"),
        blog.seoPlugin === "yoast" || blog.seoPlugin === "rankmath"
          ? blog.brandName
          : null,
      );
      await applyMetaTitle(blog, post.id, trimmed);
      await markApplied(issueId, `meta title: ${trimmed}`);
      return { issueId, applied: true, message: `Meta title set on post ${post.id}` };
    }

    if (kind === "og_title" || kind === "og_description") {
      // Yoast/RankMath default OG fields to meta_title/meta_description when
      // OG-specific aren't set — so we set the regular meta and they cascade.
      const issueType = kind === "og_title" ? "meta_title" : "meta_description";
      const cleaned = await resolveMetaValue({
        source: kind === "og_title" ? pageTitle : pageExcerpt,
        generate: () =>
          generateSeoFix({
            niche,
            blogDomain: blog.domain,
            pageUrl: issue.pageUrl || "",
            pageTitle,
            pageContentExcerpt: pageExcerpt,
            issueType,
            issueDescription: issue.description || issue.title,
          }),
      });
      const checked = assertUsableMeta(
        cleaned,
        kind === "og_title" ? "meta_title" : "meta_description",
      );
      const trimmed =
        kind === "og_title"
          ? appendBrandToTitle(
              checked,
              blog.seoPlugin === "yoast" || blog.seoPlugin === "rankmath"
                ? blog.brandName
                : null,
            )
          : capMetaDescription(checked);
      if (kind === "og_title") {
        await applyMetaTitle(blog, post.id, trimmed);
      } else {
        await applyMetaDescription(blog, post.id, trimmed);
      }
      await markApplied(issueId, `${kind}: ${trimmed}`);
      return { issueId, applied: true, message: `${kind} set on post ${post.id}` };
    }

    // Image alt text and OG image require richer issue context (which image,
    // upload a new file). Skip for now — they stay in 'detected' for human
    // review on /seo/fix-queue.
    return {
      issueId,
      applied: false,
      message: `Auto-fix not implemented for: ${issue.title}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await markFailed(issueId, message);
    return { issueId, applied: false, message };
  }
}

// ─── Per-plugin appliers ────────────────────────────────────────────────────

async function applyMetaDescription(
  blog: typeof blogs.$inferSelect,
  postId: number,
  value: string,
) {
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    throw new Error("WP credentials missing");
  }
  if (blog.seoPlugin === "yoast") {
    await wp.updateYoastMeta(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      yoast_wpseo_metadesc: value,
    });
  } else if (blog.seoPlugin === "rankmath") {
    await wp.updateRankMathMeta(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      rank_math_description: value,
    });
  } else {
    // No SEO plugin — fall back to the native post excerpt, which most themes
    // surface as the meta description by default.
    await wp.updatePost(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      excerpt: value,
    });
  }
}

async function applyMetaTitle(
  blog: typeof blogs.$inferSelect,
  postId: number,
  value: string,
) {
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    throw new Error("WP credentials missing");
  }
  if (blog.seoPlugin === "yoast") {
    await wp.updateYoastMeta(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      yoast_wpseo_title: value,
    });
  } else if (blog.seoPlugin === "rankmath") {
    await wp.updateRankMathMeta(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      rank_math_title: value,
    });
  } else {
    await wp.updatePost(blog.wpUrl, blog.wpUsername, blog.wpAppPassword, postId, {
      title: value,
    });
  }
}

/**
 * Fan-out helper used by the Apply All button (and by the SEO scan cron if you
 * decide to re-enable inline auto-fix). Caps the number of fixes applied per
 * call so a noisy queue can't consume the cron's full duration budget. Failed
 * fixes don't stop the loop.
 */
export async function autoFixIssuesForScan(
  scanIssueIds: string[],
  maxToApply: number = 10,
): Promise<{ applied: number; failed: number; results: AutoFixResult[] }> {
  const results: AutoFixResult[] = [];
  let applied = 0;
  let failed = 0;
  for (const issueId of scanIssueIds.slice(0, maxToApply)) {
    const result = await autoFixIssue(issueId);
    results.push(result);
    if (result.applied) applied++;
    else failed++;
  }
  return { applied, failed, results };
}