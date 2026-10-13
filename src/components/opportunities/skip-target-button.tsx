"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { skipKeywordTargetAsAdmin } from "@/lib/actions/keyword-target-actions";

export function SkipTargetButton({ targetId }: { targetId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  function skip() {
    start(async () => {
      const result = await skipKeywordTargetAsAdmin(targetId, reason);
      if (result.success) {
        toast.success(result.message);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Skip
      </Button>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why skip"
        className="h-8 w-40 rounded-md border bg-background px-2 text-xs"
      />
      <Button size="sm" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <Button size="sm" disabled={pending || reason.trim().length < 3} onClick={skip}>
        Confirm
      </Button>
    </div>
  );
}
