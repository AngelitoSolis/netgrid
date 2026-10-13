"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { setBlogActive } from "@/lib/actions/blog-actions";

/**
 * Deactivate / Activate toggle for a single blog. Only offered for "active"
 * and "paused" blogs — "setup" and "decommissioned" are changed from the
 * edit form, since flipping those on needs a deliberate config review.
 */
export function BlogActivationButton({
  blogId,
  status,
}: {
  blogId: string;
  status: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (status !== "active" && status !== "paused") return null;
  const activating = status === "paused";

  const handleClick = () => {
    if (
      !activating &&
      !window.confirm(
        "Deactivate this blog? No content will be generated or posted for it (including scheduled cron posts) until you activate it again.",
      )
    ) {
      return;
    }
    start(async () => {
      try {
        const res = await setBlogActive(blogId, activating);
        if (!res.success) {
          toast.error(res.message);
          return;
        }
        toast.success(res.message);
        router.refresh();
      } catch {
        toast.error(activating ? "Failed to activate blog" : "Failed to deactivate blog");
      }
    });
  };

  return (
    <Button variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
      ) : activating ? (
        <Play className="size-4" data-icon="inline-start" />
      ) : (
        <Pause className="size-4" data-icon="inline-start" />
      )}
      {activating ? "Activate" : "Deactivate"}
    </Button>
  );
}
