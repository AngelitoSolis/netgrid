"use server";

import { db } from "@/lib/db";
import {
  reports,
  clients,
  blogs,
  seoIssues,
  postVerifications,
  generatedPosts,
  users,
} from "@/lib/db/schema";
import { eq, and, desc, sql, gte, lte, lt } from "drizzle-orm";
import { requireAdmin, getClientScope } from "@/lib/auth/helpers";
import { generateMonthlyReport } from "@/lib/services/claude-client";
import { logActivity } from "@/lib/services/activity-logger";
// PDF renderer is dynamically imported inside emailReportPdfInternal()
// so pages that read reports don't pay the @react-pdf/renderer
// compile + bundle cost at request time. Keeps the type import only
// (erased at runtime).
import type { ReportPdfData, QueryMoveRow } from "@/lib/services/pdf-renderer";
import { sendReportPdfEmail } from "@/lib/services/email";
import { listRescueOutcomes } from "@/lib/services/page2-rescue";
import { locationCoverageForPeriod } from "@/lib/services/location-matrix";
// S6 — the SAME merged dossier view prompts get, condensed for the PDF's
// "What we know about your business" first page (§E).
import { getDossierForClient } from "@/lib/services/client-dossier";
// S4 — sent-pack summary for the PDF appendix ("appendix page when packs sent").
import {
  latestGbpPacksForClient,
  summarizeGbpPacksForAppendix,
} from "@/lib/services/gbp-packs";
// S5 — the renewal one-liner; S2/S8 — open ledger counts under the sprint notes.
import {
  renewalParityLine,
  reviewVelocityForClient,
} from "@/lib/services/review-velocity";
import {
  hygieneNoteLine,
  openHygieneCountsForClient,
} from "@/lib/services/query-hygiene";
// S7 — sprint plans are stored as report-period artifacts and scored against
// live machine state; the PDF reads the STORED artifact, never a recompute.
import {
  buildMonthlySprint,
  priorPeriodKey,
  readStoredSprint,
  scoreStoredSprint,
  type MonthlySprintPlan,
} from "@/lib/services/sprint-planner";
import type { EmailReportResult } from "@/lib/types/news";

export async function getReports(params?: {
  clientId?: string;
  page?: number;
  pageSize?: number;
}) {
  const { clientId, page = 1, pageSize = 25 } = params || {};

  const conditions = [];
  const clientScope = await getClientScope();

  if (clientScope) {
    conditions.push(eq(reports.clientId, clientScope));
    conditions.push(eq(reports.visibleToClient, true));
  } else if (clientId) {
    conditions.push(eq(reports.clientId, clientId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [result, [{ total }]] = await Promise.all([
    db.select({
      report: reports,
      clientName: clients.name,
    })
      .from(reports)
      .innerJoin(clients, eq(reports.clientId, clients.id))
      .where(where)
      .orderBy(desc(reports.generatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` })
      .from(reports)
      .where(where),
  ]);

  return { reports: result, total, page, pageSize };
}

export async function getReport(id: string) {
  const [report] = await db.select({
    report: reports,
    clientName: clients.name,
  })
    .from(reports)
    .innerJoin(clients, eq(reports.clientId, clients.id))
    .where(eq(reports.id, id))
    .limit(1);

  return report || null;
}

// ─── Cost analytics ───────────────────────────────────────────────────────────

export interface CostAnalytics {
  /** Total generation spend (text + image) recorded on generated posts. */
  totalCostUsd: number;
  /** Number of generated posts the cost is spread across. */
  postCount: number;
  /** Distinct blogs that have generated at least one post. */
  blogCount: number;
  avgCostPerBlog: number;
  avgCostPerPost: number;
}

/** Time windows for cost aggregation. */
export type CostWindow = "all" | "30d" | "month";

/** Start instant for a cost window (null = no lower bound / all time). */
function costWindowStart(window: CostWindow): Date | null {
  const now = new Date();
  if (window === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (window === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return null;
}

/**
 * Aggregate generation cost from `generated_posts.cost_usd`. Cost is incurred
 * at generation time regardless of publish status, so this sums every row in
 * the window. Pass a clientId to scope to one client; omit for the whole
 * network. `window` bounds by `created_at` ("all" | "30d" | "month").
 */
export async function getCostAnalytics(
  params: { clientId?: string; window?: CostWindow } = {},
): Promise<CostAnalytics> {
  await requireAdmin();
  const { clientId, window = "all" } = params;

  const start = costWindowStart(window);
  const conds = [];
  if (clientId) conds.push(eq(generatedPosts.clientId, clientId));
  if (start) conds.push(gte(generatedPosts.createdAt, start));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [row] = await db
    .select({
      totalCost: sql<string>`COALESCE(SUM(${generatedPosts.costUsd}), 0)`,
      postCount: sql<number>`count(*)::int`,
      blogCount: sql<number>`count(distinct ${generatedPosts.blogId})::int`,
    })
    .from(generatedPosts)
    .where(where);

  const totalCostUsd = Number(row?.totalCost ?? 0);
  const postCount = row?.postCount ?? 0;
  const blogCount = row?.blogCount ?? 0;

  return {
    totalCostUsd,
    postCount,
    blogCount,
    avgCostPerBlog: blogCount > 0 ? totalCostUsd / blogCount : 0,
    avgCostPerPost: postCount > 0 ? totalCostUsd / postCount : 0,
  };
}

export interface ClientReportSummary {
  clientId: string;
  clientName: string;
  reportCount: number;
  publishedCount: number;
  latestReportAt: Date | null;
  latestTrend: "improving" | "stable" | "declining" | null;
  /** Posts shipped, summed from the client's reports. */
  totalPostsPublished: number;
  totalCostUsd: number;
  postCount: number;
  blogCount: number;
  avgCostPerBlog: number;
  avgCostPerPost: number;
}

/**
 * Per-client rollup powering the "By client" cards on the Reports page: report
 * counts + latest trend from `reports`, and generation cost from
 * `generated_posts`. Includes any client that has at least one report or one
 * generated post. Sorted by total spend (desc).
 */
export async function getClientReportSummaries(
  window: CostWindow = "all",
): Promise<ClientReportSummary[]> {
  await requireAdmin();

  const start = costWindowStart(window);
  const costWhere = start ? gte(generatedPosts.createdAt, start) : undefined;

  const [clientRows, reportRows, costRows] = await Promise.all([
    db.select({ id: clients.id, name: clients.name }).from(clients),
    db
      .select({
        clientId: reports.clientId,
        generatedAt: reports.generatedAt,
        trend: reports.overallSeoTrend,
        visible: reports.visibleToClient,
        posts: reports.totalPostsPublished,
      })
      .from(reports)
      .orderBy(desc(reports.generatedAt)),
    db
      .select({
        clientId: generatedPosts.clientId,
        totalCost: sql<string>`COALESCE(SUM(${generatedPosts.costUsd}), 0)`,
        postCount: sql<number>`count(*)::int`,
        blogCount: sql<number>`count(distinct ${generatedPosts.blogId})::int`,
      })
      .from(generatedPosts)
      .where(costWhere)
      .groupBy(generatedPosts.clientId),
  ]);

  const nameById = new Map(clientRows.map((c) => [c.id, c.name]));
  const costById = new Map(costRows.map((r) => [r.clientId, r]));

  // reportRows are newest-first, so the first row seen per client is the latest.
  const repAgg = new Map<
    string,
    {
      count: number;
      published: number;
      latestAt: Date | null;
      latestTrend: ClientReportSummary["latestTrend"];
      posts: number;
    }
  >();
  for (const r of reportRows) {
    const cur =
      repAgg.get(r.clientId) ??
      { count: 0, published: 0, latestAt: null, latestTrend: null, posts: 0 };
    cur.count++;
    if (r.visible) cur.published++;
    cur.posts += r.posts ?? 0;
    if (cur.latestAt === null) {
      cur.latestAt = r.generatedAt;
      cur.latestTrend = r.trend ?? null;
    }
    repAgg.set(r.clientId, cur);
  }

  const ids = new Set<string>([...repAgg.keys(), ...costById.keys()]);
  const out: ClientReportSummary[] = [];
  for (const id of ids) {
    const clientName = nameById.get(id);
    if (!clientName) continue; // orphaned row — client deleted
    const rep = repAgg.get(id);
    const cost = costById.get(id);
    const totalCostUsd = Number(cost?.totalCost ?? 0);
    const postCount = cost?.postCount ?? 0;
    const blogCount = cost?.blogCount ?? 0;
    out.push({
      clientId: id,
      clientName,
      reportCount: rep?.count ?? 0,
      publishedCount: rep?.published ?? 0,
      latestReportAt: rep?.latestAt ?? null,
      latestTrend: rep?.latestTrend ?? null,
      totalPostsPublished: rep?.posts ?? 0,
      totalCostUsd,
      postCount,
      blogCount,
      avgCostPerBlog: blogCount > 0 ? totalCostUsd / blogCount : 0,
      avgCostPerPost: postCount > 0 ? totalCostUsd / postCount : 0,
    });
  }

  out.sort(
    (a, b) =>
      b.totalCostUsd - a.totalCostUsd || a.clientName.localeCompare(b.clientName),
  );
  return out;
}

async function generateReportInternal(
  clientId: string,
  periodStart: string,
  periodEnd: string,
  actorUserId?: string,
) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error("Client not found");

  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);

  const [blogCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));

  // No coalesce — see T19. A client with no measured blogs must produce null
  // so the PDF prints "—" rather than a headline zero.
  const [avgScore] = await db
    .select({
      avg: sql<number | null>`avg(${blogs.currentSeoScore})::int`,
      scored: sql<number>`count(${blogs.currentSeoScore})::int`,
    })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));

  const [issuesFixed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        eq(seoIssues.status, "verified"),
        gte(seoIssues.resolvedAt, startDate),
        lte(seoIssues.resolvedAt, endDate),
      ),
    );

  const [criticalRemaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, clientId),
        eq(seoIssues.severity, "critical"),
        sql`${seoIssues.status} NOT IN ('verified', 'dismissed')`,
      ),
    );

  const [onScheduleBlogs] = await db
    .select({ count: sql<number>`count(DISTINCT ${postVerifications.blogId})::int` })
    .from(postVerifications)
    .where(
      and(
        eq(postVerifications.clientId, clientId),
        eq(postVerifications.onSchedule, true),
        gte(postVerifications.checkedAt, startDate),
      ),
    );

  const currentScore =
    avgScore && avgScore.scored > 0 ? (avgScore.avg ?? null) : null;

  // Previous-period average, read from the previous REPORT rather than from
  // seo_scans.overall_score.
  //
  // seo_scans stores the TAG-HYGIENE score; reports.avg_seo_score stores the
  // composite quality score. Subtracting one from the other produced a trend
  // arrow with no meaning — it compared two different measurements.
  // The previous report's own figure is the same metric by construction.
  const [prevReport] = await db
    .select({ avg: reports.avgSeoScore })
    .from(reports)
    .where(and(eq(reports.clientId, clientId), lt(reports.periodEnd, periodStart)))
    .orderBy(desc(reports.periodEnd))
    .limit(1);
  const prevScore = prevReport?.avg ?? null;

  // A trend needs two measured endpoints. With either side missing the honest
  // answer is "no trend" — "stable" is a claim, null is a blank. The PDF's
  // trendLabel() already renders null as "—".
  const trend: "improving" | "stable" | "declining" | null =
    currentScore === null || prevScore === null
      ? null
      : currentScore - prevScore >= 3
        ? "improving"
        : currentScore - prevScore <= -3
          ? "declining"
          : "stable";

  // Real posts-published count for the period (was hardcoded to 0).
  const [postsPublished] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.clientId, clientId),
        eq(generatedPosts.status, "published"),
        gte(generatedPosts.publishedAt, startDate),
        lte(generatedPosts.publishedAt, endDate),
      ),
    );
  const totalPosts = postsPublished?.count ?? 0;

  // Generation cost (text + images) for everything generated during the
  // period — captures drafts/failed too, not just published, so it reflects
  // actual spend. Stored on the report for the Reports UI.
  const [periodCost] = await db
    .select({ total: sql<string>`COALESCE(SUM(${generatedPosts.costUsd}), 0)` })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.clientId, clientId),
        gte(generatedPosts.createdAt, startDate),
        lte(generatedPosts.createdAt, endDate),
      ),
    );
  const totalCostUsd = periodCost?.total ?? "0";

  const summaryHtml = await generateMonthlyReport({
    clientName: client.name,
    clientNiche: client.niche || "general",
    periodStart,
    periodEnd,
    totalBlogs: blogCount?.count || 0,
    avgScore: currentScore,
    prevAvgScore: prevScore,
    trendDirection: trend ?? "not yet measured",
    totalPosts,
    onSchedule: onScheduleBlogs?.count || 0,
    issuesFixed: issuesFixed?.count || 0,
    criticalRemaining: criticalRemaining?.count || 0,
  });

  const title = `${new Date(periodStart).toLocaleString("default", {
    month: "long",
    year: "numeric",
  })} Network Performance Report`;

  // S7 — store the current month's plan as this report period's artifact. The
  // monthly PDF shows it ("This month's sprint") and next month's report scores
  // it against live machine state. Fail-safe: planning must never block a
  // report, so any failure degrades to "section omitted".
  let sprintPlan: MonthlySprintPlan | null = null;
  try {
    sprintPlan = await buildMonthlySprint(clientId);
  } catch (err) {
    console.warn(
      "[report] sprint plan failed for",
      clientId,
      ":",
      err instanceof Error ? err.message : err,
    );
  }

  const [report] = await db
    .insert(reports)
    .values({
      clientId,
      periodStart,
      periodEnd,
      title,
      summaryHtml,
      overallSeoTrend: trend,
      avgSeoScore: currentScore,
      totalPostsPublished: totalPosts,
      totalIssuesFixed: issuesFixed?.count || 0,
      blogsOnSchedule: onScheduleBlogs?.count || 0,
      blogsOffSchedule: (blogCount?.count || 0) - (onScheduleBlogs?.count || 0),
      totalCostUsd,
      visibleToClient: false,
      rawData: sprintPlan ? { sprint: sprintPlan } : undefined,
    })
    .returning();

  await logActivity({
    userId: actorUserId,
    clientId,
    action: "report_generated",
    entityType: "report",
    entityId: report.id,
  });

  return report;
}

export async function triggerMonthlyReportsManual(
  options: {
    period?: "last_month" | "last_30_days" | "month_to_date";
    /** When false, only generate the report row; skip the PDF email send. */
    sendEmail?: boolean;
  } = {},
): Promise<{
  considered: number;
  generated: number;
  failed: number;
  emailed: number;
  emailFailed: number;
  period: { start: string; end: string };
  results: Array<{
    clientId: string;
    clientName: string;
    status: "generated" | "failed";
    message: string;
    email?: { success: boolean; message: string };
  }>;
}> {
  await requireAdmin();

  const eligibleClients = await db
    .select()
    .from(clients)
    .where(sql`${clients.status} IN ('active', 'onboarding')`);

  // Period selection — admin can pick whichever window is useful right now.
  // Cron stays on last_month; manual usually wants last_30_days while testing.
  const periodKind = options.period ?? "last_30_days";
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();

  let periodStart: Date;
  let periodEnd: Date;
  if (periodKind === "last_month") {
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, 0));
    periodStart = new Date(Date.UTC(utcYear, utcMonth - 1, 1));
  } else if (periodKind === "month_to_date") {
    periodStart = new Date(Date.UTC(utcYear, utcMonth, 1));
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, utcDay));
  } else {
    // last_30_days — rolling window ending today
    periodEnd = new Date(Date.UTC(utcYear, utcMonth, utcDay));
    periodStart = new Date(periodEnd.getTime() - 29 * 24 * 60 * 60 * 1000);
  }

  const startStr = periodStart.toISOString().split("T")[0];
  const endStr = periodEnd.toISOString().split("T")[0];
  const sendEmail = options.sendEmail ?? true;

  let generated = 0;
  let failed = 0;
  let emailed = 0;
  let emailFailed = 0;
  const results: Array<{
    clientId: string;
    clientName: string;
    status: "generated" | "failed";
    message: string;
    email?: { success: boolean; message: string };
  }> = [];

  for (const client of eligibleClients) {
    try {
      await generateReportForCron(client.id, startStr, endStr);
      generated++;

      // Email send happens after generation — non-fatal so one bad
      // recipient or Resend hiccup doesn't roll back the whole batch.
      let emailResult: { success: boolean; message: string } | undefined;
      if (sendEmail) {
        const latest = await getLatestReportForClientPeriod(
          client.id,
          startStr,
        );
        if (latest) {
          emailResult = await emailReportPdfInternal(latest.id);
          if (emailResult.success) emailed++;
          else emailFailed++;
        } else {
          emailResult = {
            success: false,
            message: "Could not locate just-generated report row",
          };
          emailFailed++;
        }
      }

      results.push({
        clientId: client.id,
        clientName: client.name,
        status: "generated",
        message: `Report for ${startStr} → ${endStr} generated`,
        email: emailResult,
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        clientId: client.id,
        clientName: client.name,
        status: "failed",
        message,
      });
    }
  }

  return {
    considered: eligibleClients.length,
    generated,
    failed,
    emailed,
    emailFailed,
    period: { start: startStr, end: endStr },
    results,
  };
}

/**
 * Look up the most-recently-generated report row for a client/period.
 * Used by the manual trigger + the cron to grab the row id after
 * generateReportForCron returns void.
 */
async function getLatestReportForClientPeriod(
  clientId: string,
  periodStart: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.clientId, clientId), eq(reports.periodStart, periodStart)))
    .orderBy(desc(reports.generatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Admin-callable: generate a monthly report for one client. Requires an admin
 * session — redirects to /login otherwise. For cron / system-triggered runs
 * use `generateReportForCron()` below.
 *
 * Also emails the PDF to the client after generation. Set
 * options.sendEmail = false to skip — useful when previewing the report
 * before delivery.
 */
export async function generateReport(
  clientId: string,
  periodStart: string,
  periodEnd: string,
  options: { sendEmail?: boolean } = {},
) {
  const session = await requireAdmin();
  const report = await generateReportInternal(
    clientId,
    periodStart,
    periodEnd,
    session.user.id,
  );

  const sendEmail = options.sendEmail ?? true;
  let email: EmailReportResult | undefined;
  if (sendEmail && report?.id) {
    // Non-fatal: a delivery failure shouldn't roll back the report row.
    email = await emailReportPdfInternal(report.id);
  }

  return { ...report, email };
}

export async function unpublishReport(reportId: string) {
  await requireAdmin();
  await db.update(reports).set({
    visibleToClient: false,
    publishedAt: null,
  }).where(eq(reports.id, reportId));
}
/**
 * Cron-callable variant: skips the NextAuth session check. Only call this
 * from a route that has already verified `CRON_SECRET` itself.
 */
export async function generateReportForCron(
  clientId: string,
  periodStart: string,
  periodEnd: string,
) {
  return generateReportInternal(clientId, periodStart, periodEnd);
}

export async function publishReport(reportId: string) {
  const session = await requireAdmin();

  await db.update(reports).set({
    visibleToClient: true,
    publishedAt: new Date(),
  }).where(eq(reports.id, reportId));

  await logActivity({
    userId: session.user.id,
    action: "report_published",
    entityType: "report",
    entityId: reportId,
  });
}

export async function updateReportContent(reportId: string, summaryHtml: string) {
  await requireAdmin();

  await db.update(reports).set({ summaryHtml }).where(eq(reports.id, reportId));
}

// ─── PDF + Email delivery ───────────────────────────────────────────────────

/**
 * Resolve the best email address to send a report to for a given client.
 *
 *   1. clients.contact_email  (primary contact set during onboarding)
 *   2. first client-role user with non-null email
 *
 * Returns null when neither is available — the caller decides whether
 * to skip silently or log.
 */
async function resolveRecipientEmail(clientId: string): Promise<{
  email: string;
  clientName: string;
} | null> {
  const [client] = await db
    .select({
      name: clients.name,
      contactEmail: clients.contactEmail,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return null;

  if (client.contactEmail && client.contactEmail.trim().length > 0) {
    return { email: client.contactEmail.trim(), clientName: client.name };
  }

  // Fall back to the first client-role user linked to this client.
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.clientId, clientId), eq(users.role, "client")))
    .limit(1);
  if (user?.email) {
    return { email: user.email, clientName: client.name };
  }

  return null;
}

function periodLabel(periodStart: string): string {
  try {
    const d = new Date(periodStart);
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  } catch {
    return periodStart;
  }
}

// EmailReportResult lives in src/lib/types/news.ts so this "use server"
// file only exports async functions (Next 14 rejects non-async exports
// in server action files).

/**
 * S1/S2 proof layer for the monthly PDF — "Queries that moved": one row per
 * rescue/pin whose outcome was MEASURED as resolved-or-stable inside this report
 * period (F8: a delta is only shown when both measurements exist). Fail-safe to
 * null so the section simply omits; the PDF must never fail because of it.
 */
async function queriesThatMovedForPeriod(row: {
  clientId: string;
  periodStart: unknown;
  periodEnd: unknown;
}): Promise<QueryMoveRow[] | null> {
  try {
    const since = new Date(`${String(row.periodStart).slice(0, 10)}T00:00:00Z`);
    const endExclusive = new Date(`${String(row.periodEnd).slice(0, 10)}T23:59:59.999Z`);
    if (Number.isNaN(since.getTime()) || Number.isNaN(endExclusive.getTime())) {
      return null; // malformed period — omit the section rather than guess
    }
    const measured = await listRescueOutcomes(row.clientId, {
      since,
      limit: 50,
      onlyResolved: true,
    });
    return measured
      .filter((m) => new Date(m.measuredAt).getTime() <= endExclusive.getTime())
      .map((m) => ({
        query: m.query,
        pageUrl: m.pageUrl,
        beforePosition: m.beforePosition,
        afterPosition: m.afterPosition,
        deltaPositions: m.deltaPositions,
        appliedAt: m.appliedAt,
      }));
  } catch (err) {
    console.warn(
      "[report] queries-that-moved fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Build a PDF from the persisted report row and email it to the client.
 *
 * Cron-bypass internal version. Safe to call from a route that has
 * already verified CRON_SECRET — does NOT call requireAdmin.
 */
export async function emailReportPdfInternal(
  reportId: string,
): Promise<EmailReportResult> {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!row) {
    return { success: false, message: "Report not found" };
  }

  const recipient = await resolveRecipientEmail(row.clientId);
  if (!recipient) {
    return {
      success: false,
      message:
        "No recipient email — set clients.contact_email or attach a client-role user",
    };
  }

  // S7 — "This month's sprint": rendered from the STORED artifact on this row
  // (never a live recompute), plus last month's completed-vs-planned score
  // evaluated against current machine state. Both fail-safe to null/omit.
  const sprintPlan = readStoredSprint(row.rawData);
  let lastMonthSprintScore: { period: string; done: number; total: number } | null = null;
  try {
    const priorKey = priorPeriodKey(new Date(`${String(row.periodStart).slice(0, 10)}T00:00:00Z`));
    lastMonthSprintScore = await scoreStoredSprint(row.clientId, priorKey);
  } catch (err) {
    console.warn(
      "[report] last-month sprint score failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const pdfData: ReportPdfData = {
    clientName: recipient.clientName,
    periodStart: String(row.periodStart),
    periodEnd: String(row.periodEnd),
    title: row.title,
    summaryHtml: row.summaryHtml,
    overallSeoTrend: row.overallSeoTrend,
    avgSeoScore: row.avgSeoScore,
    totalPostsPublished: row.totalPostsPublished,
    totalIssuesFixed: row.totalIssuesFixed,
    blogsOnSchedule: row.blogsOnSchedule,
    blogsOffSchedule: row.blogsOffSchedule,
    highlights: row.highlights,
    concerns: row.concerns,
    queriesThatMoved: await queriesThatMovedForPeriod(row),
    // S3 — service-area coverage line from the location ledger (fail-safe null
    // → the line omits; the PDF must never fail because of it).
    locationCoverage: await locationCoverageForPeriod(
      row.clientId,
      `${String(row.periodStart).slice(0, 10)}T00:00:00Z`,
      `${String(row.periodEnd).slice(0, 10)}T23:59:59.999Z`,
    ),
    sprintPlan: sprintPlan ?? null,
    lastMonthSprintScore,
    // S6 — "What we know about your business" (first page): the merged
    // dossier view condensed for the client. Fail-safe null → section omits.
    dossierSummary: await (async () => {
      try {
        const d = await getDossierForClient(row.clientId);
        return {
          verifiedOn: d.lastVerifiedAt ? d.lastVerifiedAt.slice(0, 10) : null,
          staleWarning: d.staleWarning,
          businessModel: d.businessModel,
          serviceArea: d.serviceArea.slice(0, 8),
          differentiators: d.differentiators.slice(0, 6),
          audience: d.audience,
          recentWins: d.recentWins.slice(0, 4),
          gaps: d.gaps ? d.gaps.slice(0, 300) : null,
        };
      } catch (err) {
        console.warn(
          "[report] dossier summary failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    })(),
    // S5 — one renewal line, only when real parity data exists (F8).
    reviewParityLine: await (async () => {
      try {
        return renewalParityLine(await reviewVelocityForClient(row.clientId));
      } catch (err) {
        console.warn(
          "[report] review parity line failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    })(),
    // S2/S8 — open ledger counts, consolidated under the sprint notes (§E).
    hygieneNote: await (async () => {
      try {
        return hygieneNoteLine(await openHygieneCountsForClient(row.clientId));
      } catch (err) {
        console.warn(
          "[report] hygiene note failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    })(),
    // S4 — appendix page ONLY when packs were sent to the client; ready-but-
    // unsent packs never reach the client PDF.
    gbpAppendix: await (async () => {
      try {
        const packs = await latestGbpPacksForClient(row.clientId);
        const sent = summarizeGbpPacksForAppendix(packs);
        return sent.packs.length > 0 ? { sentOn: sent.latestSentOn, packs: sent.packs } : null;
      } catch (err) {
        console.warn(
          "[report] GBP appendix failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    })(),
  };

  // Lazy import — keeps @react-pdf/renderer (~2 MB) out of the bundle
  // for any page that imports this action file but doesn't actually
  // generate a PDF (e.g. the reports list page, the trigger button).
  let pdfBuffer: Buffer;
  let pdfFilename: string;
  try {
    const { renderReportPdf, reportPdfFilename } = await import(
      "@/lib/services/pdf-renderer"
    );
    pdfBuffer = await renderReportPdf(pdfData);
    pdfFilename = reportPdfFilename(pdfData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "PDF render failed";
    return { success: false, message };
  }

  try {
    const result = await sendReportPdfEmail({
      to: recipient.email,
      clientName: recipient.clientName,
      periodLabel: periodLabel(pdfData.periodStart),
      pdfFilename,
      pdfBuffer,
    });
    return {
      success: true,
      message: `Sent to ${recipient.email}`,
      emailId: result?.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Email send failed";
    return { success: false, message };
  }
}

/**
 * Admin-callable variant. Used by a "Resend Report" button in the
 * reports admin page.
 */
export async function emailReportPdf(
  reportId: string,
): Promise<EmailReportResult> {
  const session = await requireAdmin();
  const result = await emailReportPdfInternal(reportId);
  if (result.success) {
    await logActivity({
      userId: session.user.id,
      action: "report_pdf_emailed",
      entityType: "report",
      entityId: reportId,
      details: { emailId: result.emailId },
    });
  }
  return result;
}
