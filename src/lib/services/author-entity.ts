/**
 * lib/services/author-entity.ts
 *
 * The single source of truth for "who is credited as the author of this blog's
 * posts". Replaces the hash-derived pseudonym generator that used to live in
 * services/shopify-client.ts, which picked a byline by hashing the store handle
 * over a 30x30 table of INVENTED names.
 *
 * Resolution order, highest priority first:
 *   1. blogs.default_author_id, if it points at an active author
 *   2. the blog's own active author (authors.blog_id = this blog)
 *   3. the client's first active shared author (authors.blog_id IS NULL)
 *   4. no author — an organisational byline is used instead
 *
 * Step 4 is legitimate for non-YMYL content: "The Brand Editorial Team" claims
 * no personal expertise and is true. It is NOT legitimate for YMYL content,
 * which is why `blocked` exists and why the publish path refuses.
 */
import { db } from "@/lib/db";
import { authors, blogs, clients } from "@/lib/db/schema";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { deriveBrandName } from "@/lib/content/brand";

/**
 * Niches where an invented or absent author is a compliance problem, not a
 * style problem. Keys match the niche keys declared in
 * content/libraries/niches.ts.
 *
 * Deliberately narrow: these are the ones where a wrong answer costs the
 * reader money or health. Widen it after a deliberate review, not by reflex.
 */
export const YMYL_NICHE_KEYS: ReadonlySet<string> = new Set([
  "peptides",
  "gambling",
  "online_casino",
  "loans",
  "tax_lawyer",
]);

/**
 * Local niche-key normaliser. Deliberately NOT imported from
 * services/content-generator.ts: that module pulls in the whole generation
 * stack, and this file is imported by services/platform-client.ts, which sits
 * underneath it. Keep this in sync with normalizeNicheKey for the keys above.
 */
function nicheKeyOf(niche: string | null | undefined): string {
  return (niche ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isYmylNiche(niche: string | null | undefined): boolean {
  return YMYL_NICHE_KEYS.has(nicheKeyOf(niche));
}

/**
 * Escape hatch for the YMYL publish gate. Unset (the default) means a YMYL
 * blog with no author entity will NOT publish. Setting it to "true" lets those
 * blogs publish under the organisational byline instead. It is an operational
 * decision with a compliance consequence — record who set it and why.
 */
function allowUnattributedYmyl(): boolean {
  return (process.env.ALLOW_UNATTRIBUTED_YMYL ?? "").trim().toLowerCase() === "true";
}

export interface ResolvedAuthor {
  id: string;
  name: string;
  slug: string;
  bio: string;
  jobTitle: string | null;
  photoUrl: string | null;
  credentials: string[];
  sameAs: string[];
  authorPageUrl: string | null;
  wpUserId: number | null;
}

export interface BylineContext {
  blogId: string;
  clientId: string;
  domain: string;
  niche: string | null;
  /** The real person, or null when there is none on file. */
  author: ResolvedAuthor | null;
  /** Honest organisational byline used when author is null. */
  fallbackByline: string;
  /** True when this blog must not publish without a real author. */
  blocked: boolean;
}

/** "Jane O'Neill-Smith" -> "jane-o-neill-smith". Stable and URL-safe. */
export function authorSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "author"
  );
}

/** "Montreal Peptides Editorial Team" — no personal expertise implied. */
function organisationalByline(
  brandName: string | null,
  domain: string,
): string {
  const brand = (brandName ?? "").trim() || deriveBrandName(domain) || domain;
  return `${brand} Editorial Team`;
}

function toResolved(row: typeof authors.$inferSelect): ResolvedAuthor {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    bio: row.bio,
    jobTitle: row.jobTitle,
    photoUrl: row.photoUrl,
    credentials: row.credentials ?? [],
    sameAs: row.sameAs ?? [],
    authorPageUrl: row.authorPageUrl,
    wpUserId: row.wpUserId,
  };
}

/**
 * Resolve the byline for a blog. Returns null only when the blog id does not
 * exist. Never throws — a publish must fail with a message, not a stack trace.
 */
export async function resolveBylineForBlog(
  blogId: string,
): Promise<BylineContext | null> {
  try {
    const [row] = await db
      .select({
        blogId: blogs.id,
        clientId: blogs.clientId,
        domain: blogs.domain,
        brandName: blogs.brandName,
        orgByline: blogs.orgByline,
        defaultAuthorId: blogs.defaultAuthorId,
        niche: clients.niche,
      })
      .from(blogs)
      .leftJoin(clients, eq(blogs.clientId, clients.id))
      .where(eq(blogs.id, blogId))
      .limit(1);

    if (!row) return null;

    let picked: typeof authors.$inferSelect | undefined;

    if (row.defaultAuthorId) {
      [picked] = await db
        .select()
        .from(authors)
        .where(
          and(eq(authors.id, row.defaultAuthorId), eq(authors.status, "active")),
        )
        .limit(1);
    }

    if (!picked) {
      // Blog-scoped authors first: Postgres ASC puts NULLs last, so a row with
      // a blog_id sorts ahead of the client-wide ones. Ties break on created_at.
      [picked] = await db
        .select()
        .from(authors)
        .where(
          and(
            eq(authors.clientId, row.clientId),
            eq(authors.status, "active"),
            or(eq(authors.blogId, row.blogId), isNull(authors.blogId)),
          ),
        )
        .orderBy(asc(authors.blogId), asc(authors.createdAt))
        .limit(1);
    }

    const author = picked ? toResolved(picked) : null;
    const orgByline = row.orgByline?.trim() || null;

    return {
      blogId: row.blogId,
      clientId: row.clientId,
      domain: row.domain,
      niche: row.niche,
      author,
      fallbackByline: orgByline ?? organisationalByline(row.brandName, row.domain),
      blocked:
        !author && !orgByline && isYmylNiche(row.niche) && !allowUnattributedYmyl(),
    };
  } catch (err) {
    console.error(
      `[author-entity] byline resolution failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The string stamped on the platform as the visible byline. */
export function bylineFor(ctx: BylineContext): string {
  return ctx.author?.name ?? ctx.fallbackByline;
}

/**
 * The schema.org author node for an Article / BlogPosting.
 *
 * With a real author this is a Person carrying @id (a stable identifier), url
 * (somewhere to go) and sameAs (third-party corroboration) — the three
 * properties that let an entity be resolved rather than discarded. Without one
 * it is an Organization, which is honest: the business published this and
 * nobody is claiming personal expertise.
 */
export function authorJsonLdNode(ctx: BylineContext): Record<string, unknown> {
  const a = ctx.author;
  if (!a) {
    return {
      "@type": "Organization",
      name: ctx.fallbackByline,
      url: `https://${ctx.domain}/`,
    };
  }

  const node: Record<string, unknown> = { "@type": "Person", name: a.name };
  if (a.authorPageUrl) {
    node["@id"] = `${a.authorPageUrl}#person`;
    node.url = a.authorPageUrl;
  }
  if (a.jobTitle) node.jobTitle = a.jobTitle;
  if (a.photoUrl) node.image = a.photoUrl;
  if (a.bio) node.description = a.bio;
  if (a.sameAs.length > 0) node.sameAs = a.sameAs;
  if (a.credentials.length > 0) {
    node.hasCredential = a.credentials.map((name) => ({
      "@type": "EducationalOccupationalCredential",
      name,
    }));
  }
  return node;
}
