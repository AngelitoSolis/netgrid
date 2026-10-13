import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SearchWindowSummary } from "@/lib/search/performance-summary";

function fmtPos(n: number | null): string {
  if (n === null) return "—";
  return n.toFixed(1);
}

/**
 * Renders a rollup that was already read from search_performance.
 * Empty is "no rows", never a fake zero ranking.
 */
export function SearchSummaryTable({ summary }: { summary: SearchWindowSummary }) {
  if (summary.impressions === 0 && summary.clicks === 0) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        No Search Console rows in the last {summary.windowDays} days.
        {summary.blogsInScope > summary.blogsWithData
          ? ` ${summary.blogsInScope - summary.blogsWithData} of ${summary.blogsInScope} active sites have no rows in this window — that is "not synced" or "not matched", not a position of zero.`
          : ""}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-6 text-sm">
        <div>
          <p className="text-muted-foreground">Clicks</p>
          <p className="text-xl font-semibold">{summary.clicks.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Impressions</p>
          <p className="text-xl font-semibold">{summary.impressions.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Avg position</p>
          <p className="text-xl font-semibold">{fmtPos(summary.position)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Sites with data</p>
          <p className="text-xl font-semibold">
            {summary.blogsWithData}
            <span className="text-sm font-normal text-muted-foreground">
              {" "}
              / {summary.blogsInScope}
            </span>
          </p>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Query</TableHead>
            <TableHead className="text-right">Clicks</TableHead>
            <TableHead className="text-right">Impressions</TableHead>
            <TableHead className="text-right">Position</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.queries.map((q) => (
            <TableRow key={q.query}>
              <TableCell className="max-w-[420px] truncate">{q.query}</TableCell>
              <TableCell className="text-right">{q.clicks.toLocaleString()}</TableCell>
              <TableCell className="text-right">{q.impressions.toLocaleString()}</TableCell>
              <TableCell className="text-right">{fmtPos(q.position)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
