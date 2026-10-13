"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { approveGscIssue, dismissGscIssue } from "@/lib/actions/review-actions";

/**
 * One-click decisions for GSC-loop issues on /review. Approve is family-aware
 * server-side (auto-safe rows run the shared apply pipeline; recommendation
 * rows record the human decision after their ledger step). Dismiss holds the
 * key in the ledger so the detector never re-opens it (F4).
 */
export function ReviewIssueActions({ issueId }: { issueId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function approve() {
    start(async () => {
      const result = await approveGscIssue(issueId);
      if (result.success) toast.success(result.message);
      else toast.error(result.message);
      router.refresh();
    });
  }

  function dismiss() {
    start(async () => {
      const result = await dismissGscIssue(issueId);
      if (result.success) toast.success(result.message);
      else toast.error(result.message);
      router.refresh();
    });
  }

  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={dismiss}>
        Dismiss
      </Button>
      <Button size="sm" disabled={pending} onClick={approve}>
        Approve
      </Button>
    </div>
  );
}
