"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ClipboardPaste } from "lucide-react";
import { toast } from "sonner";
import { saveCompetitorPaste } from "@/lib/actions/gbp-actions";

const PLACEHOLDER = `name: Joe's Plumbing
category: Plumber
attributes: Wheelchair accessible, Online estimates, 24/7 service
services: Drain cleaning $120 | Water heater repair $300 | Leak detection
description: Family-run plumbing outfit serving the metro since 2009…
review count: 142
reviews:
2026-08-01, 5
2026-08-12, 4
photos: 38
photos per month: 3`;

/** S4 input surface — one paste per competitor, parsed into
 * client_seo_dossiers.competitorProfiles. Nothing is invented: an unnamed
 * paste is rejected; anything the operator skipped stays "not provided". */
export function GbpPasteForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");

  return (
    <div className="space-y-2">
      <textarea
        className="w-full rounded-md border bg-background p-3 font-mono text-xs min-h-40"
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Competitor GBP paste"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={pending || text.trim().length === 0}
        onClick={() =>
          start(async () => {
            const res = await saveCompetitorPaste(clientId, text);
            if (res.success) {
              toast.success(res.message);
              setText("");
              router.refresh();
            } else {
              toast.error(res.message);
            }
          })
        }
      >
        {pending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <ClipboardPaste className="mr-2 size-3.5" />}
        Save competitor paste
      </Button>
    </div>
  );
}