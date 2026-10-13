"use server";

import { db } from "@/lib/db";
import { blogKeywordTargets, generatedPosts, seoIssues } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { SCRUBBER_REJECT_REASON } from "@/lib/content/scrubber";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { autoFixIssue } from "@/lib/services/seo-autofix";
import { normalizeForMatch } from "@/lib/services/page2-rescue";
import { revalidatePath } from "next/cache";

export interface GscIssueActionResult {
  success: boolean;
  message: string;
}

/**
 * Dismiss a scrubber hold without publishing.
 *
 * publishGeneratedPost stays the release path and is intentionally not
 * duplicated here — it is ungated so a reviewer can ship a held draft.
 * This action is the other half: the post was generated, a human looked,
 * and it should not go live. Status becomes "failed" with the canonical
 * reject reason so it shows up under All Posts → Failed, not under Ready.
 */
export async function dismissHeldPost(
  generatedPostId: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  const [post] = await db
    .select({
      id: generatedPosts.id,
      status: generatedPosts.status,
      flaggedForReview: generatedPosts.flaggedForReview,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, generatedPostId))
    .limit(1);

  if (!post) return { success: false, message: "Post not found" };
  if (post.status === "published") {
    return { success: false, message: "Already published — cannot dismiss" };
  }
  if (post.status === "publishing") {
    return { success: false, message: "Publish in progress — try again" };
  }

  await db
    .update(generatedPosts)
    .set({
      status: "failed",
      flaggedForReview: false,
      failureReason: SCRUBBER_REJECT_REASON,
      updatedAt: new Date(),
    })
    .where(eq(generatedPosts.id, generatedPostId));

  revalidatePath("/review");
  revalidatePath("/all-posts");
  return { success: true, message: "Hold dismissed. Post will not publish." };
}


// ─── GSC loop issues: S1 page-2 + S2/S8 hygiene families ─────────────────────
// The review queue's second half (mega-prompt §S1 surfaces / §S2 DoD): every
// keyed issue lands here with a one-click decision. Approve semantics follow
// the family — auto-safe rows run the shared pipeline NOW, recommendation rows
// record a human decision after their deterministic ledger step (F2).

/** Family from the issue_key namespace: rescue = page2:/pin: (auto-safe meta),
 * split/folded/dead are human-decision recommendations. */
function gscIssueFamily(issueKey: string | null): "rescue" | "split" | "folded" | "dead" {
  if (!issueKey) return "rescue"; // defensive — keyed issues always carry a prefix
  if (issueKey.startsWith("pin:") || issueKey.startsWith("page2:")) return "rescue";
  const prefix = issueKey.split(":")[0];
  if (prefix === "split" || prefix === "folded" || prefix === "dead") return prefix;
  return "rescue";
}

/**
 * Split approve — LEDGER-ONLY consolidation (spec §S2, F2): mark the losing
 * pages' PENDING keyword-target rows 'skipped' with reason
 * 'query-split:<winnerUrl>' and let the winner's rows keep building. Published
 * content is never touched here; the redirect itself stays a human decision.
 */
async function consolidateSplitTargets(
  blogId: string,
  payload: unknown,
): Promise<{ consolidated: number; winnerUrl: string | null }> {
  const p = (payload ?? {}) as { winnerUrl?: unknown; pages?: Array<{ url?: unknown }> };
  const winnerUrl = typeof p.winnerUrl === "string" ? p.winnerUrl : "";
  const pages = Array.isArray(p.pages) ? p.pages : [];
  if (!winnerUrl || !pages.length) return { consolidated: 0, winnerUrl: winnerUrl || null };

  const loserUrls = pages
    .filter(
      (pg) =>
        typeof pg.url === "string" &&
        normalizeForMatch(String(pg.url)) !== normalizeForMatch(winnerUrl),
    )
    .map((pg) => String(pg.url));
  if (!loserUrls.length) return { consolidated: 0, winnerUrl };

  // Losing pages → the posts WE published there (F1 boundary: ledger rows only
  // ever exist for our own content).
  const posts = await db
    .select({ id: generatedPosts.id, url: generatedPosts.externalPostUrl })
    .from(generatedPosts)
    .where(and(eq(generatedPosts.blogId, blogId), isNotNull(generatedPosts.externalPostUrl)));

  const loserNorms = new Set(loserUrls.map((u) => normalizeForMatch(u)).filter(Boolean));
  const loserPostIds = new Set<string>();
  for (const post of posts) {
    if (!post.url) continue;
    if (loserNorms.has(normalizeForMatch(post.url))) loserPostIds.add(post.id);
  }
  if (!loserPostIds.size) return { consolidated: 0, winnerUrl };

  const updated = await db
    .update(blogKeywordTargets)
    .set({
      status: "skipped",
      failureReason: `query-split:${winnerUrl}`.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(blogKeywordTargets.blogId, blogId),
        inArray(blogKeywordTargets.generatedPostId, [...loserPostIds]),
        eq(blogKeywordTargets.status, "pending"),
      ),
    )
    .returning({ id: blogKeywordTargets.id });

  return { consolidated: updated.length, winnerUrl };
}



/**
 * One-click Approve for a GSC-loop issue at /review. Family-aware (F2/F4):
 *   page2:/pin: auto-safe → run the shared apply pipeline right now (the
 *     stateless daily budgets still bound live writes; "stays queued" is an
 *     honest outcome, not an error)
 *   page2:/pin: unmanaged → operator attestation that they applied the
 *     recommended meta manually on WP (outcome loop measures via GSC either way)
 *   split       → ledger consolidation of pending targets onto the winner, then resolved
 *   folded/dead → decision recorded; suggestedFix already lists the options
 */
export async function approveGscIssue(issueId: string): Promise<GscIssueActionResult> {
  const session = await requireAdmin();

  const [issue] = await db.select().from(seoIssues).where(eq(seoIssues.id, issueId)).limit(1);
  if (!issue) return { success: false, message: "Issue not found" };
  // Lifecycle enum (F4): detected→queued→approved→applied→verified / dismissed / failed.
  // A recommendation row that a human has already decided is 'approved' — approving
  // it twice would just re-run the consolidation, so guard on every closed state.
  if (["approved", "applied", "verified", "dismissed"].includes(issue.status ?? "")) {
    return { success: false, message: `Already ${issue.status}` };
  }

  const family = gscIssueFamily(issue.issueKey ?? null);
  const now = new Date();

  // Auto-safe meta families — the SAME deterministic pipeline the cron drains.
  if (family === "rescue" && issue.autoFixable) {
    const res = await autoFixIssue(issueId);
    revalidatePath("/review");
    return { success: res.applied, message: res.message };
  }

  // Unmanaged page-2 rows — the operator applied the copy-paste meta by hand.
  if (family === "rescue") {
    await db
      .update(seoIssues)
      .set({ status: "applied", appliedAt: now, approvedBy: session.user.id, approvedAt: now })
      .where(eq(seoIssues.id, issueId));
    revalidatePath("/review");
    return {
      success: true,
      message: "Marked applied (manual) — the outcome loop will measure this pair at day ≥ 28.",
    };
  }

  // split — ledger consolidation first (deterministic, reversible), then decide.
  if (family === "split") {
    let consolidated = 0;
    try {
      consolidated = (await consolidateSplitTargets(issue.blogId, issue.fixPayload)).consolidated;
    } catch (err) {
      console.warn(
        `[review] split consolidation failed for ${issueId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await db
      .update(seoIssues)
      .set({ status: "approved", resolvedAt: now, approvedBy: session.user.id, approvedAt: now })
      .where(eq(seoIssues.id, issueId));
    revalidatePath("/review");
    return {
      success: true,
      message: `Consolidated ${consolidated} pending keyword target(s) onto the winner; decision recorded.`,
    };
  }

  // folded / dead — recommendation-only families; approve records the decision.
  await db
    .update(seoIssues)
    .set({ status: "approved", resolvedAt: now, approvedBy: session.user.id, approvedAt: now })
    .where(eq(seoIssues.id, issueId));
  revalidatePath("/review");
  return { success: true, message: "Decision recorded — the suggested fix stays on the row." };
}

/** One-click Dismiss for a GSC-loop issue — parks it out of every queue. The
 * upsert guard (F4) keeps the key held, so the detector will not re-open it. */
export async function dismissGscIssue(issueId: string): Promise<GscIssueActionResult> {
  await requireAdmin();

  const [issue] = await db.select().from(seoIssues).where(eq(seoIssues.id, issueId)).limit(1);
  if (!issue) return { success: false, message: "Issue not found" };
  if (["approved", "applied", "verified", "dismissed"].includes(issue.status ?? "")) {
    return { success: false, message: `Already ${issue.status}` };
  }

  await db.update(seoIssues).set({ status: "dismissed" }).where(eq(seoIssues.id, issueId));
  revalidatePath("/review");
  return { success: true, message: "Dismissed — the detector will not re-open this key." };
}
