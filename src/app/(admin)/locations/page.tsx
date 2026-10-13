import Link from "next/link";
import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { desc, sql } from "drizzle-orm";
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
 * Fleet index for the S3 service × location matrix. Per-client detail is
 * /locations/[clientId] — services × places grid with status chips, coverage %,
 * Build-matrix action and the live drip counter (pending → generating → generated).
 */
export default async function LocationsIndexPage() {
  await requireAdmin();

  // Correlated scalar subqueries, NOT joins: joining blogs AND matrix rows in
  // one aggregate multiplies counts (every blog row × every matrix row of the
  // client), inflating both "Sites" and "Matrix rows" by each other's size.
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      sites: sql<number>`(SELECT count(*)::int FROM blogs b WHERE b.client_id = ${clients.id})`,
      matrixRows: sql<number>`(SELECT count(*)::int FROM location_page_targets t WHERE t.client_id = ${clients.id})`,
    })
    .from(clients)
    .orderBy(desc(clients.name))
    .limit(200);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Locations</h1>
        <p className="text-muted-foreground">
          Service × location page matrix — one page per [service]+[place], built on real data only.
          Open a client to see its grid and build the matrix; the drip then pages through it at the
          client&rsquo;s daily budget.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
          <CardDescription>
            Matrix rows appear after &ldquo;Build matrix&rdquo; on the client page. A client with no
            commercial-intent keywords or blog cities has nothing to build yet — that is an empty
            state, not a failure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Sites</TableHead>
                <TableHead className="text-right">Matrix rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link href={`/locations/${row.id}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{row.sites}</TableCell>
                  <TableCell className="text-right">{row.matrixRows ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
