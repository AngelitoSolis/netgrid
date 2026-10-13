"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { saveOurReviewHistory } from "@/lib/actions/gbp-actions";

/** S5 — paste OUR review dates (YYYY-MM-DD, one per line or comma-separated).
 * The dated sample is what drives the parity rate; the optional total is the
 * profile's headline count. */
export function GbpReviewHistoryForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [total, setTotal] = useState("");

  return (
    <div className="space-y-2">
      <textarea
        className="w-full rounded-md border bg-background p-3 font-mono text-xs min-h-24"
        placeholder={"2026-01-12\n2026-02-03\n2026-03-15"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Our review dates"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 w-44"
          placeholder="Total review count (optional)"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending || text.trim().length === 0}
          onClick={() =>
            start(async () => {
              const res = await saveOurReviewHistory(clientId, text, total);
              if (res.success) {
                toast.success(res.message);
                setText("");
                setTotal("");
                router.refresh();
              } else {
                toast.error(res.message);
              }
            })
          }
        >
          {pending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
          Save our review history
        </Button>
      </div>
    </div>
  );
}