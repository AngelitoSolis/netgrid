"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { publishGeneratedPost } from "@/lib/actions/blog-actions";
import { dismissHeldPost } from "@/lib/actions/review-actions";

/**
 * Release uses the existing ungated publish path. Dismiss parks the row
 * as failed with the canonical scrubber-reject reason. Neither action
 * invents a second publisher.
 */
export function ReviewRowActions({ postId }: { postId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function release() {
    start(async () => {
      const result = await publishGeneratedPost(postId);
      if (result.success) toast.success(result.message || "Published");
      else toast.error(result.message || "Publish failed");
      router.refresh();
    });
  }

  function dismiss() {
    start(async () => {
      const result = await dismissHeldPost(postId);
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
      <Button size="sm" disabled={pending} onClick={release}>
        Release
      </Button>
    </div>
  );
}
