import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs, clients, locationPageTargets } from "@/lib/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft } from "lucide-react";
import { titleCasePhrase } from "@/lib/content/keyword-targeting";
import { locationCoveragePct } from "@/lib/services/location-matrix";
import { BuildMatrixButton } from "@/components/locations/build-matrix-button";
import { SkipPendingRows } from "@/components/locations/skip-pending-rows";

export const dynamic = "force-dynamic";

/** Chip look per ledger status (the shared keyword_target_status vocabulary). */
const statusChipVariant: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  generating: "outline",
  generated: "default",
  failed: "destructive",
  skipped: "outline",
};

interface MatrixRowView {
  id: string;
  blogId: string;
  serviceKey: string;
  placeName: string;
  combinedQuery: string;
  status: string;
  priority: number;
  error: string | null;
}

/**
 * Per-client S3 matrix: one services × places grid per carrying blog, status
 * chips (with the skip/failed reason on hover), coverage % and the live drip
 * counter (pending → generating → generated at the client's daily budget).
 * Read-only plus one idempotent action (Build matrix) — the drip itself claims
 * rows inside auto-publish; this page only shows.
 */
export default async function ClientLocationsPage({
  params,
}: {
  params: { clientId: string };
}) {
  await requireAdmin();

  const [client] = await db
    .select({
      id: clients.id,
      name: clients.name,
      locationCampaignEnabled: clients.locationCampaignEnabled,
      locationPagesPerDay: clients.locationPagesPerDay,
      localPresence: clients.localPresence,
    })
    .from(clients)
    .where(eq(clients.id, params.clientId))
    .limit(1);
  if (!client) notFound();

  const rows = (await db
    .select({
      id: locationPageTargets.id,
      blogId: locationPageTargets.blogId,
      serviceKey: locationPageTargets.serviceKey,
      placeName: locationPageTargets.placeName,
      combinedQuery: locationPageTargets.combinedQuery,
      status: locationPageTargets.status,
      priority: locationPageTargets.priority,
      error: locationPageTargets.error,
    })
    .from(locationPageTargets)
    .where(eq(locationPageTargets.clientId, client.id))
    .orderBy(
      asc(locationPageTargets.priority),
      asc(locationPageTargets.serviceKey),
    )) as MatrixRowView[];

  const blogRows = await db
    .select({ id: blogs.id, domain: blogs.domain, city: blogs.city })
    .from(blogs)
    .where(and(eq(blogs.clientId, client.id), eq(blogs.status, "active")))
    .orderBy(asc(blogs.domain));

  // Today's drip usage per blog — the SAME measurement the claimer's budget
  // gate counts (EVERY row attempted in the last 24h, failures included — a
  // failed attempt is requeued to 'pending' but keeps its fresh
  // last_attempt_at, so it still burned the day-slot), so the number on this
  // page can never disagree with what gates the drip (F8).
  const budgetRows = (await db.execute(sql`
    SELECT blog_id AS blogId, count(*)::int AS n
    FROM location_page_targets
    WHERE client_id = ${client.id}
      AND last_attempt_at >= now() - interval '24 hours'
    GROUP BY blog_id
  `)) as unknown as Array<{ blogId: string; n: number | string }>;
  const usedTodayByBlog = new Map(
    budgetRows.map((r) => [r.blogId, Number(r.n) || 0]),
  );

  // Client-wide drip counter + coverage. Skipped rows are informational-only
  // and stay OUT of the coverage denominator (F3).
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const pendingCount = count("pending");
  const generatingCount = count("generating");
  const generatedCount = count("generated");
  const skippedCount = count("skipped");
  const failedCount = count("failed");
  const actionableTotal = pendingCount + generatingCount + generatedCount;
  const coveragePct = locationCoveragePct(generatedCount, actionableTotal);

  // Group rows per blog for the per-site grids (the ledger's real dimension).
  const rowsByBlog = new Map<string, MatrixRowView[]>();
  for (const r of rows) {
    const list = rowsByBlog.get(r.blogId);
    if (list) list.push(r);
    else rowsByBlog.set(r.blogId, [r]);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/locations"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> All clients
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{client.name}</h1>
          <Badge variant={client.locationCampaignEnabled ? "default" : "outline"}>
            {client.locationCampaignEnabled ? "Campaign on" : "Campaign off"}
          </Badge>
          <Badge variant={client.localPresence ? "default" : "outline"}>
            {client.localPresence ? "Local presence confirmed" : "No local presence"}
          </Badge>
          <Badge variant="secondary">{client.locationPagesPerDay} pages/site/day</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          One page per [service]+[place], built on real data only — the drip claims one row per
          due blog per run, rotating neighborhoods by priority then oldest-attempt.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Drip status</CardTitle>
            <CardDescription>
              Coverage counts actionable rows only — skipped rows are informational and never
              count toward it.
            </CardDescription>
          </div>
          <BuildMatrixButton clientId={client.id} />
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No matrix rows yet. Click <strong>Build matrix</strong> — a client with no
              commercial-intent keywords or real blog places has nothing to build; that is an
              empty state, not a failure.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <span>
                  <span className="text-2xl font-bold">{generatedCount}</span>{" "}
                  <span className="text-muted-foreground">generated</span>
                </span>
                <span className="text-muted-foreground">
                  {generatingCount} generating · {pendingCount} pending
                  {failedCount > 0 ? ` · ${failedCount} failed (cooling off)` : ""}
                  {skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}
                </span>
                <span className="font-medium">
                  Coverage: {coveragePct === null ? "—" : `${coveragePct}%`} of{" "}
                  {actionableTotal} actionable
                </span>
              </div>
              {!client.locationCampaignEnabled && (
                <p className="mt-2 text-sm text-amber-600">
                  Campaign is off — the drip will not claim rows until the client&apos;s location
                  campaign is enabled.
                </p>
              )}
              {!client.localPresence && (
                <p className="mt-2 text-sm text-muted-foreground">
                  No local presence confirmed — every planned row is skipped
                  (&ldquo;no_local_presence&rdquo;) and nothing generates until it is confirmed.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {blogRows
        .filter((b) => (rowsByBlog.get(b.id)?.length ?? 0) > 0)
        .map((blog) => {
          const blogRowsList = rowsByBlog.get(blog.id)!;
          const places = Array.from(new Set(blogRowsList.map((r) => r.placeName))).sort((a, b) =>
            a.localeCompare(b),
          );
          const services = Array.from(
            new Map(blogRowsList.map((r) => [r.serviceKey, r.priority])).entries(),
          )
            .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
            .map(([key]) => key);
          const cell = new Map(
            blogRowsList.map((r) => [`${r.serviceKey}\u0000${r.placeName}`, r] as const),
          );
          const usedToday = usedTodayByBlog.get(blog.id) ?? 0;

          return (
            <Card key={blog.id}>
              <CardHeader>
                <CardTitle className="text-base">{blog.domain}</CardTitle>
                <CardDescription>
                  {blog.city ? `City: ${blog.city} · ` : ""}
                  {usedToday}/{client.locationPagesPerDay} of today&apos;s drip budget used
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Service</TableHead>
                      {places.map((p) => (
                        <TableHead key={p}>{p}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {services.map((serviceKey) => (
                      <TableRow key={serviceKey}>
                        <TableCell className="font-medium">
                          {titleCasePhrase(serviceKey)}
                        </TableCell>
                        {places.map((place) => {
                          const r = cell.get(`${serviceKey}\u0000${place}`);
                          if (!r) return <TableCell key={place}>—</TableCell>;
                          return (
                            <TableCell key={place}>
                              <Badge
                                variant={statusChipVariant[r.status] ?? "secondary"}
                                className={r.status === "skipped" ? "opacity-60" : undefined}
                                title={r.error ?? r.combinedQuery}
                              >
                                {r.status}
                              </Badge>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="mt-4">
                  <SkipPendingRows
                    rows={blogRowsList
                      .filter((r) => r.status === "pending")
                      .map((r) => ({
                        id: r.id,
                        combinedQuery: r.combinedQuery,
                        placeName: r.placeName,
                        serviceKey: r.serviceKey,
                      }))}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}

      {rows.length > 0 &&
        blogRows.every((b) => (rowsByBlog.get(b.id)?.length ?? 0) === 0) && (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Matrix rows exist but none belong to an active site — rebuild after the site set
              changes.
            </CardContent>
          </Card>
        )}
    </div>
  );
}