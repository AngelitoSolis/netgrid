"use server";

// S3 (SEO-loop build) — location matrix operator actions. The builder itself is
// a deterministic, idempotent service; these are its authenticated entry points.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/helpers";
import { buildLocationMatrixForClient } from "@/lib/services/location-matrix";

/** Build/refresh the client's service × place matrix (idempotent — re-running
 * adds 0 new rows, only refreshes pending/skipped decisions). */
export async function buildClientLocationMatrix(
  clientId: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  try {
    const summary = await buildLocationMatrixForClient(clientId);
    revalidatePath(`/locations/${clientId}`);
    revalidatePath("/locations");
    if (summary.rowsPlanned === 0) {
      return { ok: true, error: "Nothing to build yet — no commercial service terms or real places found for this client." };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "matrix build failed";
    console.error(`[locations] build failed for ${clientId}:`, message);
    return { ok: false, error: message };
  }
}
