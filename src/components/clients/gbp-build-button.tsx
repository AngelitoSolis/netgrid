"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { buildClientGbpPacks } from "@/lib/actions/gbp-actions";

/** S4 — rebuild the seven GBP packs. INSERT-ONLY: old pack rows are the audit
 * trail of what was promised and are never touched; description versions
 * continue at max(version)+1. Safe to run after every new paste. */
export function GbpBuildButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const t = toast.loading("Building the GBP packs…");
          const res = await buildClientGbpPacks(clientId);
          if (res.ok) {
            toast.success("Packs built.", {
              id: t,
              description: res.versionsFrom
                ? `${res.assets} new asset rows stored (old ones kept); description versions from v${res.versionsFrom}.`
                : `${res.assets} new asset rows stored.`,
            });
            router.refresh();
          } else {
            toast.error(res.error ?? "Build failed", { id: t });
          }
        })
      }
    >
      {pending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <RefreshCw className="mr-2 size-3.5" />}
      Build / refresh packs
    </Button>
  );
}