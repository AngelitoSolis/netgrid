import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { searchSummaryForClient } from "@/lib/search/performance-summary";
import { queriesWeAlreadyRankFor } from "@/lib/content/gsc-pool";
import { SearchSummaryTable } from "@/components/search/search-summary-table";

export const dynamic = "force-dynamic";

export default async function ClientSearchPage({
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

  const summary = await searchSummaryForClient(client.id, 28);

  // S0-a ideation guard (build brief D.0): the live-ranked queries this client
  // has a page for — excluded from new-post ideation and owned by the rescue
  // loop instead. Fail-safe empty: no GSC data = nothing excluded, same as before.
  const rankedGuard = await queriesWeAlreadyRankFor(client.id);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/search">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{client.name}</h1>
          <p className="text-muted-foreground">
            Search Console, last {summary.windowDays} days. Read from the sync
            tables. Not a live Google call.
          </p>
        </div>
      </div>
      {/* Tabs — Overview (this page) / Goldmine (top pairs + loop status chips). */}
      <div className="flex gap-1 border-b">
        <Link
          href={`/search/${client.id}`}
          className="-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground"
        >
          Overview
        </Link>
        <Link
          href={`/search/${client.id}/goldmine`}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Goldmine
        </Link>
        <Link
          href={`/search/${client.id}/sprint`}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Sprint
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Ideation guard (live GSC)</CardTitle>
          <CardDescription>
            S0 pool filter — queries this client already ranks on are excluded from
            new-post ideation and routed to the page-2 rescue loop instead.
            Trailing 90 days, positions 3–20.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {rankedGuard.size > 0 ? (
            <>
              <strong>{rankedGuard.size}</strong> live-ranked query
              {rankedGuard.size === 1 ? "" : "ies"} excluded from ideation for this
              client right now.
            </>
          ) : (
            "No live-ranked queries detected — nothing is being excluded from ideation at the moment."
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Top queries</CardTitle>
          <CardDescription>
            Impression-weighted position. Queries with no impressions are omitted
            because Search Console never emits them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SearchSummaryTable summary={summary} />
        </CardContent>
      </Card>
    </div>
  );
}
