import { db } from "@/lib/db";
import { siteProfiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { gateLocalProfile, type ReadySiteProfile } from "@/lib/content/site-profile";

/**
 * A city-framed target may not be written unless this blog has a ready
 * profile. Returns the profile to hand to the prompt, or a reason to skip.
 *
 * City-free targets do not call this. A missing table (migration 0054 not
 * applied yet) fails closed: skip the local page, do not invent the facts.
 */
export async function requireReadyLocalProfile(
  blogId: string,
): Promise<{ ok: true; profile: ReadySiteProfile } | { ok: false; reason: string }> {
  try {
    const [row] = await db
      .select({
        neighborhood: siteProfiles.neighborhood,
        signatureFacts: siteProfiles.signatureFacts,
        doesNot: siteProfiles.doesNot,
        placeNote: siteProfiles.placeNote,
      })
      .from(siteProfiles)
      .where(eq(siteProfiles.blogId, blogId))
      .limit(1);
    if (!row) {
      return gateLocalProfile(null);
    }
    return gateLocalProfile({
      neighborhood: row.neighborhood,
      signatureFacts: (row.signatureFacts as string[]) ?? [],
      doesNot: (row.doesNot as string[]) ?? [],
      placeNote: row.placeNote,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "profile lookup failed";
    return {
      ok: false,
      reason: `Site profile could not be read (${message}). Local page skipped rather than invented.`,
    };
  }
}
