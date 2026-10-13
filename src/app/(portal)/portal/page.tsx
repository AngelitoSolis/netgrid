import { getSession } from "@/lib/auth/helpers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { clients, blogs, reports, messages, clientSeoDossiers } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/messages/auto-refresh";
import Link from "next/link";
import { gscToday } from "@/lib/services/gsc-sync";
import { rescueOutcomeSummaryForClient } from "@/lib/services/page2-rescue";
// S7 — sprint momentum line: the client sees "N of M actions taken", never the
// item mechanics (those stay operator-side on /search/[clientId]/sprint).
import { getSprintProgress, type SprintProgress } from "@/lib/services/sprint-planner";
// S3 — "N service-area pages this month": direct counts from the location
// ledger; the matrix itself stays operator-side.
import {
  locationPagesSummaryForClient,
  type LocationPagesSummary,
} from "@/lib/services/location-matrix";
import { gbpSummaryForClient } from "@/lib/services/gbp-packs";

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function scoreColorClass(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 80) return "text-green-600";
  if (score >= 60) return "text-yellow-600";
  return "text-red-600";
}

export default async function PortalDashboard() {
  const session = await getSession();
  if (!session || session.user.role !== "client") redirect("/login");

  const clientId = session.user.clientId;
  if (!clientId) redirect("/login");

  const [[client], [blogStats], latestReport, [unreadMessages], [dossier], rescueSummary, sprintProgress, locationSummary, gbpSummary] =
    await Promise.all([
    db.select().from(clients).where(eq(clients.id, clientId)).limit(1),

    // Avg only across blogs that actually have a score; null if none scanned —
    // so the card shows "—" instead of a misleading 0.
    db
      .select({
        totalBlogs: sql<number>`count(*)::int`,
        scoredBlogs: sql<number>`count(${blogs.currentSeoScore})::int`,
        avgScore: sql<number | null>`avg(${blogs.currentSeoScore})::int`,
      })
      .from(blogs)
      .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active"))),

    db
      .select()
      .from(reports)
      .where(and(eq(reports.clientId, clientId), eq(reports.visibleToClient, true)))
      .orderBy(desc(reports.generatedAt))
      .limit(1),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.clientId, clientId),
          eq(messages.readByClient, false),
          eq(messages.isInternal, false),
        ),
      ),

    // S6 dossier freshness — a read-only summary line for the client; the full
    // fact sheet stays operator-side.
    db
      .select({ lastVerifiedAt: clientSeoDossiers.lastVerifiedAt })
      .from(clientSeoDossiers)
      .where(eq(clientSeoDossiers.clientId, clientId))
      .limit(1),

    // S1/S2 proof layer — "Search improvements this month": rescues/pins whose
    // outcome was MEASURED (both before/after present) as resolved-or-stable since
    // the 1st of the current month in LA time. A delta never shows without both
    // measurements (F8); zero rows renders an honest "not yet" line.
    rescueOutcomeSummaryForClient(
      clientId,
      `${gscToday().slice(0, 8)}01T00:00:00Z`,
    ),

    // S7 — active sprint progress for the momentum line. Fail-safe null → the
    // card simply does not render (no plan yet is an expected state).
    getSprintProgress(clientId).catch((): SprintProgress | null => null),

    // S3 — service-area pages generated this month + the actionable row total
    // behind them. Fail-safe null → the card omits (no matrix yet is an
    // expected state, never a failure).
    locationPagesSummaryForClient(
      clientId,
      `${gscToday().slice(0, 8)}01T00:00:00Z`,
    ).catch((): LocationPagesSummary | null => null),

    // S4 — "GBP action plan: N items ready", counts only; the packs themselves
    // stay operator-side until sent.
    gbpSummaryForClient(clientId).catch(() => ({ readyCount: 0 })),
  ]);

  if (!client) redirect("/login");

  const avgScore =
    blogStats.scoredBlogs > 0 && blogStats.avgScore !== null ? blogStats.avgScore : null;
  const unreadCount = unreadMessages?.count ?? 0;

  return (
    <div className="space-y-6">
      {/* Auto-refresh every 20s so new admin replies / reports show up
          without a manual reload */}
      <AutoRefresh intervalMs={20000} />

      <div>
        <h1 className="text-2xl font-bold">
          Welcome back, {client.contactName || client.name}
        </h1>
        <p className="text-muted-foreground">
          {client.niche
            ? `Your ${client.niche} blog network overview`
            : "Your blog network overview"}
        </p>
        {/* S6 — dossier freshness (read-only; details stay operator-side). */}
        <p className="mt-1 text-xs text-muted-foreground">
          {dossier?.lastVerifiedAt
            ? `We have your business profile verified ${formatDate(dossier.lastVerifiedAt)} — it grounds everything we write for you.`
            : "We're still building your business profile — our team will confirm the details with you."}
        </p>
      </div>

      {/* Stat cards — clickable links to their drill-in pages */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/portal/seo">
          <Card className="hover:bg-muted/50 transition-colors">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Network SEO Score</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-3xl font-bold ${scoreColorClass(avgScore)}`}>
                {avgScore ?? "—"}
              </p>
              {avgScore === null && (
                <p className="text-xs text-muted-foreground mt-1">No scans yet</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/portal/blogs">
          <Card className="hover:bg-muted/50 transition-colors">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Active Blogs</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{blogStats.totalBlogs}</p>
            </CardContent>
          </Card>
        </Link>

        <Link href="/portal/messages">
          <Card className="hover:bg-muted/50 transition-colors">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Unread Messages</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-3xl font-bold ${unreadCount > 0 ? "text-blue-600" : ""}`}>
                {unreadCount}
              </p>
              {unreadCount > 0 && (
                <p className="text-xs text-muted-foreground mt-1">Click to read</p>
              )}
            </CardContent>
          </Card>
        </Link>

        {/* S1/S2 — the renewal-conversation number, straight from the outcome rows. */}
        <Card className="hover:bg-muted/50 transition-colors">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Search improvements this month
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rescueSummary.rescuedCount > 0 ? (
              <>
                <p className="text-3xl font-bold">{rescueSummary.rescuedCount}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  queries rescued (avg Δ{rescueSummary.avgDeltaPositions ?? "—"} positions)
                </p>
              </>
            ) : (
              <>
                <p className="text-3xl font-bold">0</p>
                <p className="text-xs text-muted-foreground mt-1">
                  No rescued queries measured yet this month — outcomes land 28 days after apply.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* S7 — sprint momentum: counts only; the plan itself stays operator-side. */}
      {sprintProgress && sprintProgress.totalCount > 0 ? (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium">This month</p>
            <p className="text-xs text-muted-foreground">
              {sprintProgress.doneCount} of {sprintProgress.totalCount} actions taken on your
              search plan — the full schedule is in your next monthly report.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* S3 — service-area pages this month: ledger counts only; the matrix
          itself stays operator-side. No matrix yet → the card omits (an
          expected state, never a failure). */}
      {locationSummary && locationSummary.actionableTotal > 0 ? (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium">Local visibility</p>
            <p className="text-xs text-muted-foreground">
              {locationSummary.publishedSince} service-area page
              {locationSummary.publishedSince === 1 ? "" : "s"} generated this month, of{" "}
              {locationSummary.actionableTotal} planned in total. Details in your monthly
              report.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* S4 — one honest counts-only line; pack details stay operator-side. */}
      {gbpSummary.readyCount > 0 ? (
        <Card>
          <CardContent className="py-4">
            <p className="text-sm font-medium">GBP action plan: {gbpSummary.readyCount} items ready</p>
            <p className="text-xs text-muted-foreground">
              Your account manager will walk you through these on the next call.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* Latest Report */}
      <Card>
        <CardHeader>
          <CardTitle>Latest Report</CardTitle>
        </CardHeader>
        <CardContent>
          {latestReport.length > 0 ? (
            <div className="space-y-2">
              <p className="font-medium">{latestReport[0].title || "Monthly Report"}</p>
              <p className="text-sm text-muted-foreground">
                {formatDate(latestReport[0].periodStart)} —{" "}
                {formatDate(latestReport[0].periodEnd)}
              </p>
              {latestReport[0].overallSeoTrend && (
                <Badge
                  variant={
                    latestReport[0].overallSeoTrend === "improving"
                      ? "default"
                      : latestReport[0].overallSeoTrend === "declining"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {latestReport[0].overallSeoTrend}
                </Badge>
              )}
              <Link
                href="/portal/reports"
                className="block pt-2 text-sm text-primary hover:underline"
              >
                Read Full Report →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground">No reports available yet.</p>
              <Link
                href="/portal/reports"
                className="block text-sm text-primary hover:underline"
              >
                View Reports →
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
