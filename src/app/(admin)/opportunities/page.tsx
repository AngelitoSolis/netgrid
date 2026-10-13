import Link from "next/link";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs, blogKeywordTargets, clients } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkipTargetButton } from "@/components/opportunities/skip-target-button";

export const dynamic = "force-dynamic";

/**
 * Read of blog_keyword_targets where status = pending. This is the list the
 * cron will claim. Skip uses the existing terminal status; it does not
 * reorder the claim query and it does not add a keyword source.
 */
export default async function OpportunitiesPage() {
  await requireAdmin();

  const [pendingCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(blogKeywordTargets)
    .where(eq(blogKeywordTargets.status, "pending"));

  const rows = await db
    .select({
      id: blogKeywordTargets.id,
      keyword: blogKeywordTargets.keyword,
      city: blogKeywordTargets.city,
      localFraming: blogKeywordTargets.localFraming,
      priority: blogKeywordTargets.priority,
      winnability: blogKeywordTargets.winnability,
      searchVolume: blogKeywordTargets.searchVolume,
      difficulty: blogKeywordTargets.keywordDifficulty,
      domain: blogs.domain,
      blogId: blogs.id,
      clientName: clients.name,
    })
    .from(blogKeywordTargets)
    .innerJoin(blogs, eq(blogKeywordTargets.blogId, blogs.id))
    .innerJoin(clients, eq(blogKeywordTargets.clientId, clients.id))
    .where(eq(blogKeywordTargets.status, "pending"))
    .orderBy(desc(blogKeywordTargets.winnability), blogKeywordTargets.priority)
    .limit(100);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Opportunities</h1>
        <p className="text-muted-foreground">
          Pending keyword targets the publisher can claim. {pendingCount?.n ?? 0} pending
          network-wide. Showing 100, highest winnability first. Skipping a row
          stops the cron from generating it. It does not pick the next one.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Next targets</CardTitle>
          <CardDescription>
            Empty means the ledger has not been built for these blogs, not that
            the niche has no keywords. Build stays on the existing target job.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No pending targets.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Keyword</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                  <TableHead className="text-right">Difficulty</TableHead>
                  <TableHead className="text-right">Winnability</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-[280px]">
                      <p className="truncate font-medium">{row.keyword}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.localFraming ? row.city : "city-free"}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Link href={`/blogs/${row.blogId}`} className="text-sm hover:underline">
                        {row.domain}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{row.clientName}</TableCell>
                    <TableCell className="text-right text-sm">
                      {row.searchVolume ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {row.difficulty ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {row.winnability ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <SkipTargetButton targetId={row.id} />
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
