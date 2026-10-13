import Link from "next/link";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs, clients } from "@/lib/db/schema";
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

export const dynamic = "force-dynamic";

/**
 * Fleet index for Search Console data already in Postgres.
 * Per-client detail is /search/[clientId]. This page does not call Google.
 */
export default async function SearchIndexPage() {
  await requireAdmin();

  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      sites: sql<number>`count(${blogs.id})::int`,
    })
    .from(clients)
    .leftJoin(blogs, eq(blogs.clientId, clients.id))
    .groupBy(clients.id, clients.name)
    .orderBy(desc(sql`count(${blogs.id})`))
    .limit(200);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Search</h1>
        <p className="text-muted-foreground">
          Clicks, impressions and position already synced from Search Console.
          Open a client to see the queries. Nothing here calls Google.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
          <CardDescription>
            A client with no rows on the next page has not been synced, or the
            property is unverified. That is not a ranking of zero.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Sites</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/search/${row.id}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{row.sites}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
