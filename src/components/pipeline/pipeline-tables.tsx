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

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function when(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PipelineTables({
  jobs,
  errors,
}: {
  jobs: Record<string, unknown>[];
  errors: Record<string, unknown>[];
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Cron runs</CardTitle>
          <CardDescription>One row per job name, last 24 hours.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No cron_runs in the last 24 hours.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead>Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={String(job.job)}>
                    <TableCell className="font-medium">{String(job.job)}</TableCell>
                    <TableCell className="text-right">{n(job.runs)}</TableCell>
                    <TableCell className="text-right">{n(job.failed_runs)}</TableCell>
                    <TableCell className="text-right">{n(job.errors)}</TableCell>
                    <TableCell>{when(job.last_run)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Error codes</CardTitle>
          <CardDescription>
            Distinct blogs, not raw events. One broken site must not look like a fleet failure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {errors.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No pipeline_errors in the last 24 hours.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">Blogs</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((err) => (
                  <TableRow key={`${err.code}-${err.severity}`}>
                    <TableCell className="font-mono text-xs">{String(err.code)}</TableCell>
                    <TableCell>
                      <Badge variant={err.severity === "critical" ? "destructive" : "secondary"}>
                        {String(err.severity)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{n(err.n)}</TableCell>
                    <TableCell className="text-right">{n(err.blogs)}</TableCell>
                    <TableCell>{when(err.last_seen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
