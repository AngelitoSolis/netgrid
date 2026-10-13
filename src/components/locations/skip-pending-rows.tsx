"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { skipLocationTargetAsAdmin } from "@/lib/actions/keyword-target-actions";

export interface PendingRowForSkip {
  id: string;
  combinedQuery: string;
  placeName: string;
  serviceKey: string;
}

/** S3 operator skip for /locations/[clientId] — pending rows only, reason
 * REQUIRED (checked here and again in the server action). 'skipped' is
 * terminal: the drip only claims status='pending' rows, so a skipped target is
 * never generated. */
export function SkipPendingRows({ rows }: { rows: PendingRowForSkip[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reasons, setReasons] = useState<Record<string, string>>({});

  if (rows.length === 0) return null;

  const skip = (row: PendingRowForSkip) => {
    const reason = (reasons[row.id] ?? "").trim();
    if (reason.length < 3) {
      toast.error("A reason is required (at least 3 characters).");
      return;
    }
    start(async () => {
      const res = await skipLocationTargetAsAdmin(row.id, reason);
      if (res.success) {
        toast.success(res.message);
        setReasons((r) => {
          const next = { ...r };
          delete next[row.id];
          return next;
        });
        router.refresh();
      } else {
        toast.error(res.message);
      }
    });
  };

  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm font-medium">Pending rows — operator skip</p>
      <p className="text-xs text-muted-foreground">
        Skipping requires a reason and is terminal: the drip never claims a skipped row.
      </p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm" title={row.combinedQuery}>
              {row.combinedQuery}
            </span>
            <Input
              className="h-8 w-56"
              placeholder="Reason (required)"
              value={reasons[row.id] ?? ""}
              onChange={(e) => setReasons((r) => ({ ...r, [row.id]: e.target.value }))}
              aria-label={`Reason for skipping ${row.combinedQuery}`}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => skip(row)}
              disabled={pending || (reasons[row.id] ?? "").trim().length < 3}
            >
              {pending ? (
                <Loader2 className="mr-2 size-3.5 animate-spin" />
              ) : (
                <SkipForward className="mr-2 size-3.5" />
              )}
              Skip
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}