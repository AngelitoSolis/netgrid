"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { authors, blogs } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { authorSlug } from "@/lib/services/author-entity";

/**
 * Admin server actions for author records (T12).
 *
 * HARD RULE, enforced here and not only documented: an author is only
 * publishable once consent is recorded. `activateAuthor` refuses without a
 * consent timestamp, so the "active" status cannot be set on a row that has
 * no evidence a real person agreed to be named. That refusal is the whole
 * point of the table — without it this is just a nicer place to store invented
 * names.
 */

export interface AuthorActionResult {
  success: boolean;
  message: string;
  authorId?: string;
}

export interface AuthorInput {
  clientId: string;
  /** Null/omitted => available to every blog of the client. */
  blogId?: string | null;
  name: string;
  bio: string;
  jobTitle?: string | null;
  photoUrl?: string | null;
  email?: string | null;
  /** Real qualifications only, each evidenced by credentialEvidenceUrl. */
  credentials?: string[];
  /** THIRD-PARTY corroborating URLs (LinkedIn, ORCID, a register). */
  sameAs?: string[];
  credentialEvidenceUrl?: string | null;
}

function cleanList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * A sameAs pointing at another netgrid property is worse than none — it makes
 * the network self-referential and corroborates nothing. Drop any URL whose
 * host matches a domain we operate.
 */
async function stripSelfReferentialSameAs(
  urls: string[],
): Promise<{ kept: string[]; dropped: string[] }> {
  if (urls.length === 0) return { kept: [], dropped: [] };
  let ownDomains = new Set<string>();
  try {
    const rows = await db.select({ domain: blogs.domain }).from(blogs);
    ownDomains = new Set(rows.map((r) => r.domain.toLowerCase().replace(/^www\./, "")));
  } catch {
    // Can't read the network — keep the URLs rather than silently dropping
    // evidence the operator entered on purpose.
    return { kept: urls, dropped: [] };
  }

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of urls) {
    let host = "";
    try {
      host = new URL(raw).host.toLowerCase().replace(/^www\./, "");
    } catch {
      // Not a parseable absolute URL — a sameAs must be one, so drop it.
      dropped.push(raw);
      continue;
    }
    if (ownDomains.has(host)) dropped.push(raw);
    else kept.push(raw);
  }
  return { kept, dropped };
}

/** Create an author in `draft`. It cannot be used for a byline until activated. */
export async function createAuthor(
  input: AuthorInput,
): Promise<AuthorActionResult> {
  await requireAdmin();

  const name = input.name.trim();
  const bio = input.bio.trim();
  if (!name) return { success: false, message: "Author name is required." };
  if (!bio) {
    return {
      success: false,
      message:
        "A bio is required. An author page with no bio corroborates nothing, " +
        "which defeats the purpose of having an author entity.",
    };
  }

  const { kept, dropped } = await stripSelfReferentialSameAs(cleanList(input.sameAs));

  try {
    const [row] = await db
      .insert(authors)
      .values({
        clientId: input.clientId,
        blogId: input.blogId ?? null,
        name,
        slug: authorSlug(name),
        bio,
        jobTitle: input.jobTitle?.trim() || null,
        photoUrl: input.photoUrl?.trim() || null,
        email: input.email?.trim() || null,
        credentials: cleanList(input.credentials),
        sameAs: kept,
        credentialEvidenceUrl: input.credentialEvidenceUrl?.trim() || null,
        status: "draft",
      })
      .returning({ id: authors.id });

    revalidatePath(`/clients/${input.clientId}`);
    return {
      success: true,
      authorId: row.id,
      message:
        `Author "${name}" created as a draft. Record consent before it can be used ` +
        `for a byline.` +
        (dropped.length
          ? ` Dropped ${dropped.length} self-referential sameAs URL(s): ${dropped.join(", ")}.`
          : ""),
    };
  } catch (err) {
    return {
      success: false,
      message: `Could not create author: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Record that the named person agreed to be credited. */
export async function recordAuthorConsent(
  authorId: string,
  consentRecordUrl: string,
): Promise<AuthorActionResult> {
  await requireAdmin();

  const url = consentRecordUrl.trim();
  if (!url) {
    return {
      success: false,
      message:
        "A consent record URL is required — a link to the signed agreement or " +
        "the email thread on file. Consent with no evidence is not consent.",
    };
  }

  try {
    const [row] = await db
      .update(authors)
      .set({
        consentGivenAt: new Date(),
        consentRecordUrl: url,
        updatedAt: new Date(),
      })
      .where(eq(authors.id, authorId))
      .returning({ id: authors.id, clientId: authors.clientId, name: authors.name });

    if (!row) return { success: false, message: "Author not found." };
    revalidatePath(`/clients/${row.clientId}`);
    return { success: true, authorId: row.id, message: `Consent recorded for ${row.name}.` };
  } catch (err) {
    return {
      success: false,
      message: `Could not record consent: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/**
 * Promote a draft author to `active` so it can be used for bylines.
 *
 * REFUSES without a consent timestamp. This is the compliance gate: the byline
 * names a real person on a real page, and doing that without their agreement
 * is the problem T12 exists to fix, not a formality.
 */
export async function activateAuthor(
  authorId: string,
): Promise<AuthorActionResult> {
  await requireAdmin();

  try {
    const [row] = await db
      .select()
      .from(authors)
      .where(eq(authors.id, authorId))
      .limit(1);

    if (!row) return { success: false, message: "Author not found." };

    if (!row.consentGivenAt) {
      return {
        success: false,
        message:
          `Cannot activate "${row.name}": no consent on file. Record consent first — ` +
          `a byline names a real person, and publishing under their name without ` +
          `their agreement is the defect this table exists to prevent.`,
      };
    }

    if (row.credentials.length > 0 && !row.credentialEvidenceUrl) {
      return {
        success: false,
        message:
          `Cannot activate "${row.name}": it lists ${row.credentials.length} credential(s) ` +
          `with no evidence URL. Either document them or remove them — an ` +
          `undocumented credential in this table is the same fabricated-expertise ` +
          `claim that was removed from the prompt library.`,
      };
    }

    await db
      .update(authors)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(authors.id, authorId));

    revalidatePath(`/clients/${row.clientId}`);
    return { success: true, authorId, message: `${row.name} is now active.` };
  } catch (err) {
    return {
      success: false,
      message: `Could not activate author: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/**
 * Retire an author — the person withdrew consent or left. The row is KEPT so
 * already-published posts still resolve their byline; it just stops being
 * selected for new ones.
 */
export async function retireAuthor(
  authorId: string,
): Promise<AuthorActionResult> {
  await requireAdmin();
  try {
    const [row] = await db
      .update(authors)
      .set({ status: "retired", updatedAt: new Date() })
      .where(eq(authors.id, authorId))
      .returning({ id: authors.id, clientId: authors.clientId, name: authors.name });

    if (!row) return { success: false, message: "Author not found." };

    // Any blog defaulting to this author falls back to the client's next
    // active author, or to the organisational byline.
    await db
      .update(blogs)
      .set({ defaultAuthorId: null })
      .where(eq(blogs.defaultAuthorId, authorId));

    revalidatePath(`/clients/${row.clientId}`);
    return {
      success: true,
      authorId,
      message: `${row.name} retired. Existing posts keep the byline; new posts will not use it.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Could not retire author: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Point a blog at a specific author for its byline. */
export async function setBlogDefaultAuthor(
  blogId: string,
  authorId: string | null,
): Promise<AuthorActionResult> {
  await requireAdmin();
  try {
    if (authorId) {
      const [a] = await db
        .select({ status: authors.status, name: authors.name })
        .from(authors)
        .where(eq(authors.id, authorId))
        .limit(1);
      if (!a) return { success: false, message: "Author not found." };
      if (a.status !== "active") {
        return {
          success: false,
          message: `"${a.name}" is ${a.status}, not active — it cannot be used for a byline.`,
        };
      }
    }

    await db
      .update(blogs)
      .set({ defaultAuthorId: authorId })
      .where(eq(blogs.id, blogId));

    revalidatePath(`/blogs/${blogId}`);
    return { success: true, message: authorId ? "Default author set." : "Default author cleared." };
  } catch (err) {
    return {
      success: false,
      message: `Could not set the default author: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }
}

/** Every author on file for a client, drafts included, for the admin list. */
export async function listAuthorsForClient(clientId: string) {
  await requireAdmin();
  return db
    .select()
    .from(authors)
    .where(eq(authors.clientId, clientId))
    .orderBy(asc(authors.status), asc(authors.name));
}

/** Blogs on a YMYL niche that would currently refuse to publish. */
export async function blogsBlockedForMissingAuthor(clientId: string) {
  await requireAdmin();
  return db
    .select({ id: blogs.id, domain: blogs.domain })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), eq(blogs.status, "active")));
}
