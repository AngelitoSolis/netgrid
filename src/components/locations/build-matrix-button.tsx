"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Grid3x3, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { buildClientLocationMatrix } from "@/lib/actions/location-actions";

/** S3 — "Build matrix" action for /locations/[clientId]. The builder is a
 * deterministic, idempotent service: re-running adds 0 new rows and only
 * refreshes pending/skipped decisions, so the button is safe to spam. */
export function BuildMatrixButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const handleBuild = () => {
    start(async () => {
      const t = toast.loading("Building the service × location matrix…", {
        description: "Idempotent — re-running only refreshes pending/skipped decisions.",
      });
      const res = await buildClientLocationMatrix(clientId);
      if (res.ok && !res.error) {
        toast.success("Matrix built.", { id: t, description: "The drip now pages through it at the client's daily budget." });
        router.refresh();
      } else if (res.ok && res.error) {
        // Nothing to build yet is an honest empty state, not a failure.
        toast.info(res.error, { id: t });
        router.refresh();
      } else {
        toast.error(res.error ?? "Matrix build failed", { id: t });
      }
    });
  };

  return (
    <Button size="sm" onClick={handleBuild} disabled={pending}>
      {pending ? (
        <Loader2 className="mr-2 size-3.5 animate-spin" />
      ) : (
        <Grid3x3 className="mr-2 size-3.5" />
      )}
      Build matrix
    </Button>
  );
}