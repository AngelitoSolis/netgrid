import { db } from "@/lib/db";
import { blogs, clients, generatedPosts, seoIssues } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { scrubberSummary } from "@/lib/content/scrubber";
import type { ScrubberReport } from "@/lib/content/scrubber";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
import { ReviewRowActions } from "@/components/review/review-row-actions";
import { ReviewIssueActions } from "@/components/review/gsc-issue-actions";
import {
  hygieneDecisionLine,
  hygieneLedgerTelemetry,
} from "@/lib/services/query-hygiene";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * The review queue T07's comments refer to and the UI never had.
 *
 * A hold is not a status. Enforcement parks the row at status "generated"
 * with flagged_for_review = true and a failure_reason prefixed by the
 * scrubber hold string. "Ready to publish" on /all-posts therefore mixes
 * holds with drafts an operator meant to ship. This page is that filter.
 *
 * Release goes through publishGeneratedPost (ungated on purpose). Dismiss
 * marks the row failed so it leaves the queue. Neither path adds a publisher.
 */

function ageLabel(updatedAt: Date | null): string {
  if (!updatedAt) return "—";
  const hours = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 36e5));
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export default async function ReviewQueuePage() {
  await requireAdmin();

  const [heldCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.flaggedForReview, true),
        eq(generatedPosts.status, "generated"),
      ),
    );

  const rows = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      domain: blogs.domain,
      clientName: clients.name,
      topic: generatedPosts.topic,
      title: generatedPosts.title,
      failureReason: generatedPosts.failureReason,
      scrubberReport: generatedPosts.scrubberReport,
      updatedAt: generatedPosts.updatedAt,
    })
    .from(generatedPosts)
    .leftJoin(blogs, eq(generatedPosts.blogId, blogs.id))
    .leftJoin(clients, eq(generatedPosts.clientId, clients.id))
    .where(
      and(
        eq(generatedPosts.flaggedForReview, true),
        eq(generatedPosts.status, "generated"),
      ),
    )
    .orderBy(desc(generatedPosts.updatedAt))
    .limit(200);

  const count = heldCount?.count ?? 0;

  // GSC loop queue — S1 page-2 rescues and the S2/S8 hygiene families (split /
  // folded / pin / dead) land here as keyed issues. Open = detected or queued:
  // auto-safe rows also drain on the next cron run, but an operator can approve
  // one immediately; recommendation rows wait for a human decision (F2).
  const gscIssues = await db
    .select({
      id: seoIssues.id,
      issueKey: seoIssues.issueKey,
      category: seoIssues.category,
      severity: seoIssues.severity,
      title: seoIssues.title,
      pageUrl: seoIssues.pageUrl,
      status: seoIssues.status,
      autoFixable: seoIssues.autoFixable,
      clientName: clients.name,
      domain: blogs.domain,
      detectedAt: seoIssues.detectedAt,
    })
    .from(seoIssues)
    .leftJoin(blogs, eq(seoIssues.blogId, blogs.id))
    .leftJoin(clients, eq(seoIssues.clientId, clients.id))
    .where(and(isNotNull(seoIssues.issueKey), inArray(seoIssues.status, ["detected", "queued"])))
    .orderBy(desc(seoIssues.detectedAt))
    .limit(100);

  // §E S8 telemetry — one line of detected-vs-decided context above the queue
  // (pure counts; the line omits entirely while the ledger is empty, F8).
  const hygieneTelemetryLine = hygieneDecisionLine(await hygieneLedgerTelemetry());

  function issueFamily(key: string | null): string {
    if (!key) return "issue";
    const prefix = key.split(":")[0];
    if (prefix === "page2") return "rescue";
    if (prefix === "pin" || prefix === "split" || prefix === "folded" || prefix === "dead") {
      return prefix;
    }
    return "issue";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Review queue</h1>
          <p className="text-muted-foreground">
            Posts the scrubber held instead of publishing. Release ships the
            existing draft. Dismiss keeps it off the site.
          </p>
        </div>
        <Badge variant={count > 0 ? "destructive" : "secondary"}>{count} held</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Held drafts</CardTitle>
          <CardDescription>
            {rows.length === 200
              ? "Showing the 200 most recently updated holds."
              : `${rows.length} post${rows.length === 1 ? "" : "s"} waiting.`}
            {" "}
            Holds only exist when SCRUBBER_ENFORCEMENT=enforce. In shadow mode
            this page stays empty and flagged posts still publish.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing held.{" "}
              <Link href="/all-posts?status=ready" className="underline">
                Ready to publish
              </Link>{" "}
              is the unflagged draft list.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Post</TableHead>
                  <TableHead>Blog</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Why it was held</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const summary = scrubberSummary(
                    row.scrubberReport as ScrubberReport | null,
                  );
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="max-w-[240px]">
                        <Link
                          href={`/blogs/${row.blogId}/posts`}
                          className="font-medium hover:underline"
                        >
                          {row.title || row.topic}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{row.domain ?? "—"}</TableCell>
                      <TableCell className="text-sm">{row.clientName ?? "—"}</TableCell>
                      <TableCell className="max-w-[360px] text-xs text-muted-foreground">
                        {row.failureReason || summary}
                      </TableCell>
                      <TableCell className="text-sm">{ageLabel(row.updatedAt)}</TableCell>
                      <TableCell>
                        <ReviewRowActions postId={row.id} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {/* GSC loop queue — S1 page-2 rescues + S2/S8 hygiene (split / folded /
          pin / dead). One-click Approve runs the family's action; Dismiss holds
          the key so the detector never re-opens it. */}
      <Card>
        <CardHeader>
          <CardTitle>GSC loop issues</CardTitle>
          <CardDescription>
            Keyed findings from the daily Search Console pass: page-2 rescues, query
            splits, Google-folded canonicals, accidental rankers and dead-weight pages.
            Approve on an auto-safe row applies it through the shared pipeline right now;
            approve on a recommendation records your decision (redirects/merges/deletes
            stay human work). Unmanaged page-2 rows: apply the recommended meta by hand,
            then Approve.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hygieneTelemetryLine && (
            <p className="mb-3 text-xs text-muted-foreground">{hygieneTelemetryLine}</p>
          )}
          {gscIssues.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No open GSC-loop issues — the daily sync pass has nothing queued for a human.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Family</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gscIssues.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Badge
                        variant={
                          row.severity === "critical" ? "destructive" : "secondary"
                        }
                      >
                        {issueFamily(row.issueKey)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[420px]">
                      <p className="truncate text-sm font-medium">{row.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {row.pageUrl ?? "—"}
                      </p>
                      {!row.autoFixable && (issueFamily(row.issueKey) === "rescue") && (
                        <p className="text-xs text-amber-600">
                          Unmanaged URL — apply the recommended meta on the site, then Approve.
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[140px] text-sm">
                      <span className="block truncate">{row.clientName ?? "—"}</span>
                      {row.domain && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.domain}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.autoFixable ? row.status : "needs decision"}
                    </TableCell>
                    <TableCell className="text-sm">{ageLabel(row.detectedAt)}</TableCell>
                    <TableCell>
                      <ReviewIssueActions issueId={row.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
