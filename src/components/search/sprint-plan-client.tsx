"use client";

// S7 sprint-tab interactive bits: rebuild form + manual-item completion ticks.
// All state lives in reports.raw_data.sprint (server side); these components
// just fire the server actions and let revalidation repaint the page.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toggleManualSprintItem, rebuildClientSprint } from "@/lib/actions/sprint-actions";

export function RebuildSprintButton({ clientId }: { clientId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <form
      action={async () => {
        setBusy(true);
        try {
          await rebuildClientSprint(clientId);
        } finally {
          // Revalidation re-renders the page; busy state resets with it.
        }
      }}
    >
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? "Rebuilding…" : "Rebuild sprint"}
      </Button>
    </form>
  );
}

export function ManualItemToggle({
  clientId,
  itemId,
  done,
}: {
  clientId: string;
  itemId: string;
  done: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          void toggleManualSprintItem(clientId, itemId, e.target.checked).finally(() => setBusy(false));
        }}
      />
      <span className="text-muted-foreground">{done ? "Done (operator)" : "Mark done"}</span>
    </label>
  );
}
