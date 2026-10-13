"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { logReviewResponse } from "@/lib/actions/gbp-actions";

/** S5 SLA log — one row per review response. The ≤24h standard is only ever
 * counted when the review itself is dated (honest measurement, F8). */
export function GbpLogResponseForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [ref, setRef] = useState("");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-56"
          placeholder="Review ref (e.g. 'Google · 2026-09-20 · 5 stars')"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        />
        <Input
          className="h-8 w-44"
          placeholder="Responded at (YYYY-MM-DD)"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending || ref.trim().length < 3}
          onClick={() =>
            start(async () => {
              const res = await logReviewResponse(clientId, ref, when, notes);
              if (res.success) {
                toast.success(res.message);
                setRef("");
                setWhen("");
                setNotes("");
                router.refresh();
              } else {
                toast.error(res.message);
              }
            })
          }
        >
          {pending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
          Log response
        </Button>
      </div>
      <Input
        className="h-8"
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
    </div>
  );
}