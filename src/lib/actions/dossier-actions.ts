"use server";

// S6 (SEO-loop build) — dossier editor actions. The dossier is the ONE place a
// client's business facts live; every edit stamps last_verified_at, which is
// what makes the context block's staleness warning honest (F8).

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientSeoDossiers, clients } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { getDossierForClient, type DossierView } from "@/lib/services/client-dossier";

/** What the v1 editor can write. competitor_profiles is managed by S4's GBP tab
 * (paste → structured rows); it is deliberately NOT editable here so the two
 * surfaces never fight over one column. */
export interface SaveDossierInput {
  businessModel: string | null;
  serviceArea: string[];
  differentiators: string[];
  audience: string | null;
  recentWins: string[];
  gaps: string | null;
}

/** Trim, dedupe and bound an operator-pasted list. The context block renders a
 * subset anyway, but the stored row should never carry 500 duplicate lines. */
function cleanList(v: string[] | null | undefined): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = String(item ?? "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s.slice(0, 300));
    }
  }
  return out.slice(0, 50);
}

/**
 * Upsert the operator-verified fields and stamp last_verified_at = now() on
 * EVERY save (the spec's freshness contract: "every edit stamps it"). The
 * neon-http driver has no transactions; an admin-only surface with a PK
 * backstop makes check-then-write acceptable here.
 */
export async function saveClientDossier(
  clientId: string,
  input: SaveDossierInput,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();

  const values = {
    businessModel: input.businessModel?.trim() || null,
    serviceArea: cleanList(input.serviceArea),
    differentiators: cleanList(input.differentiators),
    audience: input.audience?.trim() || null,
    recentWins: cleanList(input.recentWins),
    gaps: input.gaps?.trim() || null,
  };

  try {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) return { ok: false, error: "Client not found." };

    const now = new Date();
    const [existing] = await db
      .select({ clientId: clientSeoDossiers.clientId })
      .from(clientSeoDossiers)
      .where(eq(clientSeoDossiers.clientId, clientId))
      .limit(1);

    if (existing) {
      await db
        .update(clientSeoDossiers)
        .set({ ...values, lastVerifiedAt: now, updatedAt: now })
        .where(eq(clientSeoDossiers.clientId, clientId));
    } else {
      // competitorProfiles starts empty; S4's GBP tab fills it from pastes.
      await db.insert(clientSeoDossiers).values({
        clientId,
        ...values,
        lastVerifiedAt: now,
      });
    }

    revalidatePath(`/clients/${clientId}`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save dossier";
    console.error(`[dossier] save failed for client ${clientId}:`, message);
    return { ok: false, error: message };
  }
}

/** Read path for admin surfaces — the SAME merged view prompt consumers get. */
export async function getDossierForAdmin(clientId: string): Promise<DossierView> {
  await requireAdmin();
  return getDossierForClient(clientId);
}