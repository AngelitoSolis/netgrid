import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { clients, seoIssues } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { gscToday, shiftDate } from "@/lib/services/gsc-sync";
import { normalizeForMatch } from "@/lib/services/page2-rescue";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import { RESCUE_WINDOW_DAYS } from "@/lib/content/gsc-pool";

export const dynamic = "force-dynamic";

/**
 * Goldmine tab of the per-client GSC explorer (mega-prompt §S1 surfaces): the
 * top (query, page) pairs across ALL of a client's blogs over the trailing 90d
 * window — impressions-weighted position everywhere (F5) — with each pair's
 * issue-status chip from the shared ledger. This is the operator's "where is the
 * money" view; the daily cron decides what to do with it, this page only shows.
 */
export default async function ClientSearchGoldminePage({
  params,
}: {
  params: { clientId: string };
}) {
  await requireAdmin();

  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.id, params.clientId))
    .limit(1);
  if (!client) notFound();

  interface GoldmineRow {
    domain: string | null;
    query: string;
    page: string;
    impressions_90d: number | string;
    clicks_90d: number | string;
    avg_position: number | string;
  }
  const today = gscToday();
  const pairs = (await db.execute(sql`
    SELECT b.domain, sp.query, sp.page,
           SUM(sp.impressions)::int AS impressions_90d,
           COALESCE(SUM(sp.clicks), 0)::int AS clicks_90d,
           SUM(sp.position * sp.impressions) / NULLIF(SUM(sp.impressions), 0) AS avg_position
    FROM search_performance sp
    JOIN blogs b ON b.id = sp.blog_id
    WHERE b.client_id = ${client.id}
      AND b.status = 'active'
      AND sp.date >= ${shiftDate(today, -RESCUE_WINDOW_DAYS)}
      AND sp.date <= ${today}
      AND sp.impressions > 0
    GROUP BY b.domain, sp.query, sp.page
    ORDER BY impressions_90d DESC
    LIMIT 50
  `)) as unknown as GoldmineRow[];

  // Issue-status chips: every page2:/pin: row for this client (any status — the
  // chip shows where the pair stands in the loop), matched on the SAME identity
  // the detectors persist: issue_key + S1's normalizeForMatch(pageUrl).
  const issues = await db
    .select({ issueKey: seoIssues.issueKey, pageUrl: seoIssues.pageUrl, status: seoIssues.status })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, client.id),
        sql`(issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')`,
      ),
    );
  const statusByKey = new Map<string, string>();
  for (const i of issues) {
    if (!i.issueKey || !i.pageUrl) continue;
    const k = `${i.issueKey}\u0000${normalizeForMatch(i.pageUrl)}`;
    // If two rows ever collide on identity, the most-advanced status wins.
    const rank: Record<string, number> = {
      dismissed: 0,
      detected: 1,
      queued: 2,
      approved: 3,
      applied: 4,
      verified: 5,
      resolved: 6,
    };
    const status = i.status ?? "detected"; // column is nullable by definition
    if ((rank[status] ?? -1) >= (rank[statusByKey.get(k) ?? ""] ?? -2)) {
      statusByKey.set(k, status);
    }
  }

  function round1(n: number): string {
    const r = Math.round(n * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }

  // Exact-identity chip lookup — the same (issue_key, normalized page) pair the
  // detectors persist, so a chip appears only when the loop truly owns this row.
  function issueStatusFor(query: string, page: string): string | null {
    const normQuery = normalizeQueryKey(query);
    if (!normQuery) return null;
    const normPage = normalizeForMatch(page);
    return (
      statusByKey.get(`page2:${normQuery}\u0000${normPage}`) ??
      statusByKey.get(`pin:${normQuery}\u0000${normPage}`) ??
      null
    );
  }

  function pagePath(page: string): string {
    try {
      return new URL(page).pathname;
    } catch {
      return page;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/search/${client.id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{client.name} — Goldmine</h1>
          <p className="text-muted-foreground">
            Top query/page pairs across all of this client&apos;s blogs, trailing{" "}
            {RESCUE_WINDOW_DAYS} days. Impressions-weighted position. The daily cron works
            these; the chip shows each pair&apos;s state in the loop.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top pairs (by impressions)</CardTitle>
          <CardDescription>
            Pairs with no ledger row yet are candidates — the detector opens one when a
            pair clears its floor and position window. &ldquo;—&rdquo; means nothing in the loop
            owns that exact (query, page) identity right now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pairs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No Search Console volume for this client in the window yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Query</th>
                    <th className="py-2 pr-4 font-medium">Page</th>
                    <th className="py-2 pr-4 font-medium">Avg pos</th>
                    <th className="py-2 pr-4 font-medium">Impressions</th>
                    <th className="py-2 pr-4 font-medium">Clicks</th>
                    <th className="py-2 font-medium">Issue status</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((row) => {
                    const query = String(row.query ?? "");
                    const page = String(row.page ?? "");
                    const chipStatus = issueStatusFor(query, page);
                    return (
                      <tr key={`${query}\u0000${page}`} className="border-b last:border-0">
                        <td className="max-w-[220px] truncate py-2 pr-4 font-medium" title={query}>
                          {query}
                        </td>
                        <td
                          className="max-w-[300px] truncate py-2 pr-4 text-muted-foreground"
                          title={page}
                        >
                          {(row.domain ?? "") + pagePath(page)}
                        </td>
                        <td className="py-2 pr-4">{round1(Number(row.avg_position) || 0)}</td>
                        <td className="py-2 pr-4">{Number(row.impressions_90d) || 0}</td>
                        <td className="py-2 pr-4">{Number(row.clicks_90d) || 0}</td>
                        <td className="py-2">
                          {chipStatus ? (
                            <Badge variant={chipStatus === "resolved" ? "default" : "secondary"}>
                              {chipStatus}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

