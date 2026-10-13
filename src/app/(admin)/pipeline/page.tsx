import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PipelineTables } from "@/components/pipeline/pipeline-tables";

export const dynamic = "force-dynamic";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] } | null;
  return r?.rows ?? [];
}

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

export default async function PipelinePage() {
  await requireAdmin();

  const jobsRes = await db.execute(sql`
    SELECT job,
           count(*) AS runs,
           count(*) FILTER (WHERE NOT ok) AS failed_runs,
           coalesce(sum(error_count), 0) AS errors,
           max(started_at) AS last_run
    FROM cron_runs
    WHERE started_at > now() - interval '24 hours'
    GROUP BY job
    ORDER BY job
  `);

  const errorsRes = await db.execute(sql`
    SELECT code, severity,
           count(*) AS n,
           count(DISTINCT blog_id) AS blogs,
           max(created_at) AS last_seen
    FROM pipeline_errors
    WHERE created_at > now() - interval '24 hours'
    GROUP BY code, severity
    ORDER BY n DESC
    LIMIT 20
  `);

  const heldRes = await db.execute(sql`
    SELECT count(*) AS n FROM generated_posts
    WHERE flagged_for_review = true AND status = 'generated'
  `);

  const staleGscRes = await db.execute(sql`
    SELECT count(*) AS n FROM blogs
    WHERE status = 'active'
      AND (gsc_last_synced_at IS NULL
           OR gsc_last_synced_at < now() - interval '48 hours')
  `);

  const jobs = rowsOf<Record<string, unknown>>(jobsRes);
  const errors = rowsOf<Record<string, unknown>>(errorsRes);
  const held = n(rowsOf<Record<string, unknown>>(heldRes)[0]?.n);
  const staleGsc = n(rowsOf<Record<string, unknown>>(staleGscRes)[0]?.n);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <p className="text-muted-foreground">
          Last 24 hours. Read from cron_runs and pipeline_errors. This page does not re-run anything.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Jobs in the last 24h</CardDescription>
            <CardTitle className="text-2xl">{jobs.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Scrubber holds</CardDescription>
            <CardTitle className="text-2xl">{held}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>GSC sync older than 48h</CardDescription>
            <CardTitle className="text-2xl">{staleGsc}</CardTitle>
          </CardHeader>
        </Card>
      </div>
      <PipelineTables jobs={jobs} errors={errors} />
    </div>
  );
}
