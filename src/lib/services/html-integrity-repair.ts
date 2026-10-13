import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs, generatedPosts } from "@/lib/db/schema";
import {
  backfillPostSeo,
  fetchLivePostBody,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "@/lib/services/platform-client";
import {
  forEachTextNode,
  htmlToPlainText,
  loadFragment,
  rootNode,
} from "@/lib/content/html-utils";

/**
 * Repair pass for the HTML damage T23 fixed at generation time, applied to the
 * posts that were already published with it (T23, section 6 of the SOP).
 *
 * This is a plain service module, not a "use server" action:
 * seo-backfill-actions.ts exposes backfillBlogSeo as an unauthenticated server
 * action reachable from the browser, and there is no reason to add a second
 * such surface when the only intended caller is a CRON_SECRET-guarded route.
 * The loop mirrors backfillBlogTracking: read the live body, compute, write
 * only on change, then sync our copy.
 */

export interface HtmlRepairPostResult {
  generatedPostId: string;
  externalPostId: string | null;
  fixedPunctuation: boolean;
  fixedStructure: boolean;
  /** Word-welds left by the old <br> strip. NOT repairable — regenerate. */
  suspectedBrWelds: number;
  status: "updated" | "skipped" | "failed" | "would-update";
  message?: string;
}

export interface HtmlRepairResult {
  blogId: string;
  platform: string;
  dryRun: boolean;
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Posts beyond this run's cap; re-run to process them. */
  remaining: number;
  /** Post ids carrying damage a repair cannot undo. */
  needsRegenerate: string[];
  posts: HtmlRepairPostResult[];
}

/** Tags whose open/close counts must match in a healthy body. */
const BALANCED_TAGS = [
  "p", "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "strong", "em", "a", "div", "span", "figure",
];

/**
 * Cheap structural smoke test. The lookahead on the opening pattern stops "p"
 * matching <picture>, "a" matching <article> and "li" matching <link>.
 */
export function hasUnbalancedTags(html: string): boolean {
  for (const tag of BALANCED_TAGS) {
    const open = html.match(new RegExp(`<${tag}(?=[\\s/>])`, "gi"))?.length ?? 0;
    const close = html.match(new RegExp(`<\\/${tag}\\s*>`, "gi"))?.length ?? 0;
    if (open !== close) return true;
  }
  return false;
}

const PUNCT_ARTIFACT = /\s,|,[ \t]{2,}/;

/**
 * Undo the " ,  " that the old em-dash auto-fix stamped into published bodies.
 * Text nodes only, so attribute values and <code>/<pre> are untouched.
 *
 * ONLY the comma is normalized. French typography legitimately puts a space
 * before ; : ! ? and this network publishes FR — widening these two regexes
 * would corrupt every French post on the network.
 */
export function repairPunctuationArtifacts(html: string): string {
  if (!PUNCT_ARTIFACT.test(html)) return html;
  const $ = loadFragment(html);
  let changed = false;
  forEachTextNode(rootNode($), (node) => {
    const before = node.data ?? "";
    const after = before.replace(/\s+,/g, ",").replace(/,[ \t]{2,}/g, ", ");
    if (after !== before) {
      node.data = after;
      changed = true;
    }
  });
  return changed ? $.html() : html;
}

/**
 * Re-serialize through the parser, which closes everything the old
 * capWordCount cut left open. Only runs when the body is actually unbalanced —
 * a blanket round-trip would rewrite every published post for nothing.
 */
export function repairStructure(html: string): string {
  if (!hasUnbalancedTags(html)) return html;
  return loadFragment(html).html();
}

/**
 * Heuristic count of lowercase→uppercase welds left where a <br> was deleted
 * with an empty replacement. The lost space cannot be recovered — this is a
 * DETECTION signal for regeneration, never a repair. Expect a low false
 * positive rate from brand names (e.g. "netGrid"); treat it as a ranking, not
 * a verdict.
 */
export function countSuspectedBrWelds(html: string): number {
  return (htmlToPlainText(html).match(/[a-z]{3}[A-Z][a-z]{2}/g) ?? []).length;
}

/**
 * Repair the HTML damage T23 fixed at generation time on a blog's already
 * published posts:
 *   - " ,  " punctuation artifact  → repaired in place
 *   - unbalanced block tags        → repaired by re-serializing
 *   - <br> word welds              → reported only (unrecoverable)
 *
 * Reads each post's LIVE body from the platform (so media URLs are intact) and
 * only writes when something actually changed. Safe to re-run; every step is
 * idempotent. Processes up to `limit` posts (newest first) per run.
 */
export async function repairBlogHtmlIntegrity(
  blogId: string,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<HtmlRepairResult> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 60));
  const dryRun = options.dryRun ?? false;

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, blogId)).limit(1);
  if (!blog) throw new Error(`Blog ${blogId} not found`);

  const platformBlog: PlatformBlog = {
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

  // Resolve the Shopify blog id ONCE for the whole run (no-op for WP).
  const shopifyCtx = await resolveShopifyBlogId(platformBlog);
  const shopifyBlogId = shopifyCtx?.blogId;

  // Fetch one more than the cap so we can tell whether any remain.
  const rows = await db
    .select({ id: generatedPosts.id, externalPostId: generatedPosts.externalPostId })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, blogId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(limit + 1);

  const remaining = Math.max(0, rows.length - limit);
  const batch = rows.slice(0, limit);

  const posts: HtmlRepairPostResult[] = [];
  const needsRegenerate: string[] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of batch) {
    const externalPostId = row.externalPostId;
    const result: HtmlRepairPostResult = {
      generatedPostId: row.id,
      externalPostId,
      fixedPunctuation: false,
      fixedStructure: false,
      suspectedBrWelds: 0,
      status: "skipped",
    };

    try {
      if (!externalPostId) {
        result.message = "no externalPostId";
        skipped++;
        posts.push(result);
        continue;
      }

      const body = await fetchLivePostBody(platformBlog, externalPostId, shopifyBlogId);
      if (body === null) {
        result.status = "failed";
        result.message = "could not read live body";
        failed++;
        posts.push(result);
        continue;
      }

      result.suspectedBrWelds = countSuspectedBrWelds(body);
      if (result.suspectedBrWelds > 0) needsRegenerate.push(row.id);

      const afterPunct = repairPunctuationArtifacts(body);
      result.fixedPunctuation = afterPunct !== body;
      const next = repairStructure(afterPunct);
      result.fixedStructure = next !== afterPunct;

      if (next === body) {
        result.message = "already clean";
        skipped++;
        posts.push(result);
        continue;
      }

      if (dryRun) {
        result.status = "would-update";
        updated++;
        posts.push(result);
        continue;
      }

      const push = await backfillPostSeo(
        platformBlog,
        externalPostId,
        { bodyHtml: next },
        shopifyBlogId,
      );
      if (!push.success) {
        result.status = "failed";
        result.message = push.message;
        failed++;
        posts.push(result);
        continue;
      }

      await db
        .update(generatedPosts)
        .set({ body: next, updatedAt: new Date() })
        .where(eq(generatedPosts.id, row.id));

      result.status = "updated";
      updated++;
      posts.push(result);
    } catch (err) {
      result.status = "failed";
      result.message = err instanceof Error ? err.message : String(err);
      failed++;
      posts.push(result);
    }
  }

  return {
    blogId,
    platform: blog.platform ?? "wordpress",
    dryRun,
    total: batch.length,
    updated,
    skipped,
    failed,
    remaining,
    needsRegenerate,
    posts,
  };
}