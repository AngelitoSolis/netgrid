"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { markDescriptionApplied } from "@/lib/actions/gbp-actions";

/** Records the operator's confirmation that a description version is live on
 * the client's GBP (F2 — humans do every GBP action; this only logs it). */
export function GbpApplyVersionButton({
  clientId,
  versionId,
  applied,
}: {
  clientId: string;
  versionId: string;
  applied: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (applied) {
    return (
      <Button size="sm" variant="ghost" disabled>
        <Check className="mr-1 size-3.5" /> Applied
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await markDescriptionApplied(clientId, versionId);
          if (res.success) {
            toast.success(res.message);
            router.refresh();
          } else {
            toast.error(res.message);
          }
        })
      }
    >
      {pending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
      Mark live
    </Button>
  );
}