"use server";

// S7 (SEO-loop build) — sprint plan operator actions. The planner itself is a
// deterministic service; these are just its authenticated entry points, each
// revalidating the one surface that shows the result.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/helpers";
import { rebuildCurrentSprint, setManualItemDone } from "@/lib/services/sprint-planner";

/** Rebuild the current-month plan from live data and persist it as this
 * period's artifact. Idempotent on period: same live inputs → same item ids. */
export async function rebuildClientSprint(clientId: string): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const result = await rebuildCurrentSprint(clientId);
  revalidatePath(`/search/${clientId}/sprint`);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Operator tick for a manual plan item — the only completion path that family
 * has (rescues/reviews/locations resolve through their own machines). */
export async function toggleManualSprintItem(
  clientId: string,
  itemId: string,
  done: boolean,
): Promise<{ ok: boolean }> {
  await requireAdmin();
  const result = await setManualItemDone(clientId, itemId, done);
  revalidatePath(`/search/${clientId}/sprint`);
  return result;
}
