"use server";

// S4 (SEO loop) — GBP pack operator actions. Netgrid NEVER touches a Google
// Business Profile (F2): these are the authenticated entry points for (a)
// storing a competitor paste into the dossier and (b) regenerating the packs.
// Pack generation is INSERT-ONLY — see services/gbp-packs.ts.

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientSeoDossiers, gbpAssets, gbpDescriptionVersions } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import {
  buildGbpPacks,
  mergeCompetitorProfile,
  parseCompetitorPaste,
} from "@/lib/services/gbp-packs";
import { parseReviewDates } from "@/lib/services/review-velocity";

/** Store one competitor paste (the gbp tab textarea) into
 * client_seo_dossiers.competitorProfiles. Parsing never invents: an unnamed
 * paste is rejected, missing fields stay null/[] (F3). Re-saving the same name
 * REPLACES that competitor's facts — the paste is the operator's correction. */
export async function saveCompetitorPaste(
  clientId: string,
  pasteText: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const parsed = parseCompetitorPaste(pasteText);
  if (!parsed) {
    return {
      success: false,
      message: 'The paste needs a "name:" line — nothing was saved.',
    };
  }

  const [existing] = await db
    .select({ competitorProfiles: clientSeoDossiers.competitorProfiles })
    .from(clientSeoDossiers)
    .where(eq(clientSeoDossiers.clientId, clientId))
    .limit(1);

  const merged = mergeCompetitorProfile(
    (existing?.competitorProfiles ?? []) as unknown[],
    parsed,
  );

  if (existing) {
    await db
      .update(clientSeoDossiers)
      .set({ competitorProfiles: merged, lastVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(clientSeoDossiers.clientId, clientId));
  } else {
    await db.insert(clientSeoDossiers).values({
      clientId,
      competitorProfiles: merged,
      lastVerifiedAt: new Date(),
    });
  }

  revalidatePath(`/clients/${clientId}/gbp`);
  return {
    success: true,
    message: `Saved competitor "${parsed.name}". Rebuild the packs to fold it in.`,
  };
}

/** Rebuild the seven packs. INSERT-ONLY: old gbp_assets rows are never
 * touched (the audit trail of what was promised), and description versions
 * continue at max(version)+1. */
export async function buildClientGbpPacks(
  clientId: string,
): Promise<{ ok: boolean; error?: string; assets?: number; versionsFrom?: number }> {
  await requireAdmin();
  try {
    const summary = await buildGbpPacks(clientId);
    revalidatePath(`/clients/${clientId}/gbp`);
    return {
      ok: true,
      assets: summary.assetsInserted,
      versionsFrom: summary.descriptionVersionsFrom ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "GBP pack build failed";
    console.error(`[gbp-packs] build failed for ${clientId}:`, message);
    return { ok: false, error: message };
  }
}

/** Operator confirms a description version went live on the GBP (F2 — humans
 * do all GBP actions; this only records the fact). */
export async function markDescriptionApplied(
  clientId: string,
  versionId: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const updated = await db
    .update(gbpDescriptionVersions)
    .set({ appliedAt: new Date() })
    .where(
      and(eq(gbpDescriptionVersions.id, versionId), eq(gbpDescriptionVersions.clientId, clientId)),
    )
    .returning({ version: gbpDescriptionVersions.version });
  if (updated.length === 0) return { success: false, message: "Version not found." };
  revalidatePath(`/clients/${clientId}/gbp`);
  return { success: true, message: `Version ${updated[0].version} marked applied.` };
}

/** S5 — store OUR side's review-date history (the other half of the parity
 * math). One paste per call; the newest row wins (gbp_assets is insert-only). */
export async function saveOurReviewHistory(
  clientId: string,
  pasteText: string,
  totalCountRaw: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const candidates = pasteText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const { ok, bad } = parseReviewDates(candidates);
  if (ok.length === 0) {
    return {
      success: false,
      message: "No YYYY-MM-DD dates found in the paste — nothing saved.",
    };
  }
  const totalCount = Number(totalCountRaw.replace(/[^0-9]/g, ""));
  await db.insert(gbpAssets).values({
    clientId,
    assetType: "reviews",
    payload: {
      kind: "review_history",
      side: "ours",
      dates: ok,
      totalCount: Number.isFinite(totalCount) && totalCount > 0 ? totalCount : null,
      unparseable: bad,
    },
  });
  revalidatePath(`/clients/${clientId}`);
  return {
    success: true,
    message: `Saved ${ok.length} dated review${ok.length === 1 ? "" : "s"}${
      bad.length > 0 ? ` (${bad.length} line${bad.length === 1 ? "" : "s"} could not be parsed and were kept aside)` : ""
    }.`,
  };
}

/** S5 — one row in the response SLA log. The reviewRef is the operator's own
 * label for the review (its text/date on the profile); the ≤24h standard is
 * measured only when a review date is included as YYYY-MM-DD. */
export async function logReviewResponse(
  clientId: string,
  reviewRef: string,
  respondedAt: string,
  notes: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const ref = reviewRef.trim();
  if (ref.length < 3) return { success: false, message: "A review reference is required." };
  const when = new Date(respondedAt);
  if (Number.isNaN(when.getTime())) {
    return { success: false, message: "Responded-at must be a valid date." };
  }
  await db.insert(gbpAssets).values({
    clientId,
    assetType: "reviews",
    payload: {
      kind: "response_log",
      reviewRef: ref.slice(0, 300),
      respondedAt: when.toISOString(),
      notes: notes.trim().slice(0, 2000),
    },
  });
  revalidatePath(`/clients/${clientId}`);
  return { success: true, message: "Response logged." };
}