"use server";

import { db } from "@/lib/db";
import { blogs, siteProfiles, storyUses } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { eq, gte } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  cleanFactList,
  gateLocalProfile,
  type SiteProfileInput,
} from "@/lib/content/site-profile";
import {
  decideStoryReuse,
  normalizeStoryQuery,
  STORY_REUSE_WINDOW_DAYS,
  type StoryUse,
} from "@/lib/content/story-reuse";

export async function getSiteProfile(blogId: string) {
  await requireAdmin();
  const [row] = await db
    .select()
    .from(siteProfiles)
    .where(eq(siteProfiles.blogId, blogId))
    .limit(1);
  return row ?? null;
}

export async function saveSiteProfile(
  blogId: string,
  input: SiteProfileInput,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const [blog] = await db
    .select({ id: blogs.id, clientId: blogs.clientId })
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);
  if (!blog) return { success: false, message: "Blog not found" };

  const signatureFacts = cleanFactList(input.signatureFacts);
  const doesNot = cleanFactList(input.doesNot, 8);
  const neighborhood = (input.neighborhood ?? "").trim() || null;
  const placeNote = (input.placeNote ?? "").trim() || null;

  await db
    .insert(siteProfiles)
    .values({
      blogId,
      clientId: blog.clientId,
      neighborhood,
      signatureFacts,
      doesNot,
      placeNote,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: siteProfiles.blogId,
      set: {
        neighborhood,
        signatureFacts,
        doesNot,
        placeNote,
        updatedAt: new Date(),
      },
    });

  revalidatePath(`/blogs/${blogId}`);
  const gate = gateLocalProfile({ neighborhood, signatureFacts, doesNot, placeNote });
  return {
    success: true,
    message: gate.ok
      ? "Profile saved. Local pages for this site can use these facts."
      : `Profile saved, but a local page will still be skipped: ${gate.reason}`,
  };
}

/**
 * Attach a sourced story to one blog and one query, or refuse.
 * Refusing is the feature. Callers must not generate the local angle anyway.
 */
export async function attachStoryUse(
  blogId: string,
  sourceUrl: string,
  query: string,
): Promise<{ allow: boolean; reason?: string; storyKey?: string }> {
  await requireAdmin();
  const url = sourceUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { allow: false, reason: "A story needs a real http(s) source URL." };
  }
  const since = new Date(Date.now() - STORY_REUSE_WINDOW_DAYS * 864e5);
  const prior = await db
    .select({
      storyKey: storyUses.storyKey,
      queryNorm: storyUses.queryNorm,
      createdAt: storyUses.createdAt,
    })
    .from(storyUses)
    .where(gte(storyUses.createdAt, since));

  const decision = decideStoryReuse(url, query, prior as StoryUse[]);
  if (!decision.allow) return { allow: false, reason: decision.reason, storyKey: decision.storyKey };

  await db.insert(storyUses).values({
    storyKey: decision.storyKey,
    blogId,
    queryNorm: normalizeStoryQuery(query),
    sourceUrl: url,
  });
  return { allow: true, storyKey: decision.storyKey };
}
