import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Blog activation gate. A blog that an operator deactivated ("paused") or
 * retired ("decommissioned") must not generate or publish anything — manual
 * or cron — until it is reactivated. The auto-publish cron already selects
 * only status='active' blogs; this is the same rule for every other entry
 * point (Generate post, Publish, Retry, Regenerate, Suggest, bulk triggers).
 *
 * "setup" is deliberately NOT blocked: operators test-generate on new blogs
 * before flipping them live, and the cron already ignores them.
 */
const INACTIVE_STATUSES = new Set(["paused", "decommissioned"]);

export function isBlogDeactivated(status: string | null | undefined): boolean {
  return INACTIVE_STATUSES.has(status ?? "");
}

export function blogDeactivatedMessage(domain: string, status: string | null | undefined): string {
  return status === "decommissioned"
    ? `${domain} is decommissioned — content generation and publishing are disabled.`
    : `${domain} is deactivated — content generation and publishing are disabled until it's activated again.`;
}

/** Null when the blog may generate/publish; otherwise the refusal message. */
export async function checkBlogActive(blogId: string): Promise<string | null> {
  const [row] = await db
    .select({ domain: blogs.domain, status: blogs.status })
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);
  if (!row) return null; // callers already report "not found" their own way
  return isBlogDeactivated(row.status) ? blogDeactivatedMessage(row.domain, row.status) : null;
}
