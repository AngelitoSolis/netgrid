/**
 * lib/seo/structured-data.ts
 *
 * The single place that builds every JSON-LD document netgrid emits.
 *
 * Three consumers:
 *   1. content-generation-actions — appends a managed block to the post BODY
 *      before publish (FAQPage + BreadcrumbList; the live URL isn't known yet).
 *   2. wp-seo-injector — rewrites that same block AFTER publish on plugin-less
 *      WordPress, this time with the full Article entity graph, because that
 *      is the only structured data such a page will ever have.
 *   3. shopify-theme-client — mirrors buildArticleGraph() in Liquid, because a
 *      Shopify theme renders the graph per request from `article.*`.
 *
 * Design rules:
 *   - ONE <script type="application/ld+json"> per managed block, always an
 *     @graph, so nodes reference each other by @id instead of repeating the
 *     publisher and author inline on every page.
 *   - Never invent facts. No author, no logo, no sameAs → the property is
 *     omitted. Fabricated sameAs profiles are a spam signal, not a win.
 *   - The block is fenced by a per-site OPAQUE marker (schemaMarkerToken) so
 *     re-runs replace it instead of stacking, WITHOUT printing a vendor name
 *     into every page of the network.
 *
 * Pure: no I/O, no database imports. That is what makes it unit-testable, and
 * it is why the AuthorIdentity is passed IN rather than resolved here — the
 * real author lives in the `authors` table and is resolved by
 * services/author-entity.ts (T12).
 */
import { deriveBrandName } from "@/lib/content/brand";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FaqItem {
  question: string;
  answer: string;
}

export interface SiteIdentity {
  /** Public origin, scheme + host, no trailing slash: "https://example.com". */
  origin: string;
  /** Publisher display name (blogs.brand_name, else derived from the domain). */
  name: string;
  /** Absolute logo URL, or null when the site has none. Never a data: URI. */
  logoUrl?: string | null;
  /** Blog index URL for the middle breadcrumb ("/blog", "/blogs/news"). */
  blogUrl?: string | null;
  /** Label for that breadcrumb step. */
  blogName?: string | null;
}

export interface AuthorIdentity {
  name: string;
  /** The author's own page on this site. Omit when the site has none. */
  url?: string | null;
  /** REAL profile URLs only. Never synthesise these — see module header. */
  sameAs?: string[] | null;
}

export interface ArticleFacts {
  /** Canonical, absolute URL of the published post. */
  url: string;
  headline: string;
  description: string;
  /** ISO-8601 with an offset or Z. */
  datePublished?: string | null;
  dateModified?: string | null;
  /** Absolute http(s) URL. data: URIs are rejected by the callers. */
  imageUrl?: string | null;
  keywords?: string[] | null;
  wordCount?: number | null;
  /** BCP-47 tag: "en" | "fr". */
  inLanguage?: string | null;
}

export type JsonLdNode = Record<string, unknown>;

export interface JsonLdDocument {
  "@context": "https://schema.org";
  "@graph": JsonLdNode[];
}

/** Below this, an FAQPage node is noise — Google ignores 1-question FAQs. */
export const MIN_FAQ_ITEMS = 2;

/** Matches the heading that opens a Q/A section, EN + FR. */
export const FAQ_HEADING_RE =
  /(frequently asked|common questions|questions and answers|questions fréquentes|questions courantes|foire aux questions|\bfaq\b)/i;

// ─── Small helpers ──────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

/** Scheme + host, no path, no trailing slash. Tolerates a bare domain. */
export function normalizeOrigin(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}

/** ASCII slug used inside Person @id values. Stable for the same name. */
function slugify(value: string): string {
  const s = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "author";
}

/** HTML → single-line plain text. Used for every string that lands in JSON-LD. */
export function plainText(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Node @id scheme ────────────────────────────────────────────────────────
// Every node gets a stable @id so the graph is a graph, not four disconnected
// objects. Same author on two posts → the SAME Person @id, which is exactly
// what lets a search engine merge them into one entity.

export const orgId = (origin: string): string => `${origin}/#organization`;
export const personId = (origin: string, name: string): string =>
  `${origin}/#/schema/person/${slugify(name)}`;
export const webPageId = (url: string): string => `${url}#webpage`;
export const articleNodeId = (url: string): string => `${url}#article`;
export const breadcrumbId = (url: string): string => `${url}#breadcrumb`;
export const faqId = (url: string): string => `${url}#faq`;

// ─── Node builders ──────────────────────────────────────────────────────────

export function buildOrganization(site: SiteIdentity): JsonLdNode {
  const node: JsonLdNode = {
    "@type": "Organization",
    "@id": orgId(site.origin),
    name: site.name,
    url: `${site.origin}/`,
  };
  if (site.logoUrl && !/^data:/i.test(site.logoUrl)) {
    node.logo = {
      "@type": "ImageObject",
      "@id": `${site.origin}/#logo`,
      url: site.logoUrl,
      contentUrl: site.logoUrl,
    };
    node.image = { "@id": `${site.origin}/#logo` };
  }
  return node;
}

export function buildPerson(
  site: SiteIdentity,
  author: AuthorIdentity,
): JsonLdNode {
  const node: JsonLdNode = {
    "@type": "Person",
    "@id": personId(site.origin, author.name),
    name: author.name,
    worksFor: { "@id": orgId(site.origin) },
  };
  if (author.url) node.url = author.url;
  const sameAs = (author.sameAs ?? []).filter((u) => /^https?:\/\//i.test(u));
  if (sameAs.length > 0) node.sameAs = sameAs;
  return node;
}

/**
 * BreadcrumbList. The LAST crumb deliberately carries no `item` — schema.org
 * and Google both treat "no item on the final element" as "this is the page
 * you're on", which is what lets us build a valid breadcrumb BEFORE the
 * platform has told us the post's URL.
 */
export function buildBreadcrumbList(
  site: SiteIdentity,
  pageTitle: string,
  pageUrl?: string | null,
): JsonLdNode {
  const items: JsonLdNode[] = [
    { "@type": "ListItem", position: 1, name: "Home", item: `${site.origin}/` },
  ];
  if (site.blogUrl) {
    items.push({
      "@type": "ListItem",
      position: items.length + 1,
      name: site.blogName || "Blog",
      item: site.blogUrl,
    });
  }
  items.push({
    "@type": "ListItem",
    position: items.length + 1,
    name: pageTitle,
  });
  const node: JsonLdNode = { "@type": "BreadcrumbList", itemListElement: items };
  if (pageUrl) node["@id"] = breadcrumbId(pageUrl);
  return node;
}

/** FAQPage, or null when there aren't enough real Q/A pairs to be worth it. */
export function buildFaqPage(
  items: FaqItem[],
  pageUrl?: string | null,
): JsonLdNode | null {
  const clean = items.filter(
    (i) => i.question.trim().length > 0 && i.answer.trim().length > 0,
  );
  if (clean.length < MIN_FAQ_ITEMS) return null;
  const node: JsonLdNode = {
    "@type": "FAQPage",
    mainEntity: clean.map((i) => ({
      "@type": "Question",
      name: i.question.trim(),
      acceptedAnswer: { "@type": "Answer", text: i.answer.trim() },
    })),
  };
  if (pageUrl) node["@id"] = faqId(pageUrl);
  return node;
}

// ─── Graph builders ─────────────────────────────────────────────────────────

export interface ArticleGraphInput {
  site: SiteIdentity;
  article: ArticleFacts;
  author?: AuthorIdentity | null;
  faq?: FaqItem[] | null;
  includeBreadcrumb?: boolean;
  /** "Article" for WordPress posts, "BlogPosting" for a Shopify blog article. */
  articleType?: "Article" | "BlogPosting";
}

/**
 * The full page graph: Organization → Person → WebPage → Article →
 * BreadcrumbList (→ FAQPage). Use ONLY on pages that emit nothing else —
 * a second Article node next to Yoast's is duplication, not enrichment.
 */
export function buildArticleGraph(input: ArticleGraphInput): JsonLdDocument {
  const { site, article } = input;
  const includeBreadcrumb = input.includeBreadcrumb ?? true;
  const articleType = input.articleType ?? "Article";

  const graph: JsonLdNode[] = [buildOrganization(site)];

  const authorName = input.author?.name?.trim();
  if (authorName && input.author) graph.push(buildPerson(site, input.author));

  // No named author → the Organization IS the author. schema.org allows it and
  // it beats inventing a person who doesn't exist.
  const authorRef = authorName
    ? { "@id": personId(site.origin, authorName) }
    : { "@id": orgId(site.origin) };

  const webPage: JsonLdNode = {
    "@type": "WebPage",
    "@id": webPageId(article.url),
    url: article.url,
    name: article.headline,
    isPartOf: { "@id": orgId(site.origin) },
  };
  if (article.description) webPage.description = article.description;
  if (article.inLanguage) webPage.inLanguage = article.inLanguage;
  if (includeBreadcrumb) {
    webPage.breadcrumb = { "@id": breadcrumbId(article.url) };
  }
  graph.push(webPage);

  const articleNode: JsonLdNode = {
    "@type": articleType,
    "@id": articleNodeId(article.url),
    isPartOf: { "@id": webPageId(article.url) },
    mainEntityOfPage: { "@id": webPageId(article.url) },
    // Google truncates the displayed headline near 110 characters.
    headline: article.headline.slice(0, 110),
    description: article.description,
    author: authorRef,
    publisher: { "@id": orgId(site.origin) },
  };
  if (article.datePublished) articleNode.datePublished = article.datePublished;
  if (article.dateModified) articleNode.dateModified = article.dateModified;
  else if (article.datePublished) articleNode.dateModified = article.datePublished;
  if (article.imageUrl && !/^data:/i.test(article.imageUrl)) {
    articleNode.image = [article.imageUrl];
  }
  if (article.keywords && article.keywords.length > 0) {
    articleNode.keywords = article.keywords.join(", ");
  }
  if (article.wordCount && article.wordCount > 0) {
    articleNode.wordCount = article.wordCount;
  }
  if (article.inLanguage) articleNode.inLanguage = article.inLanguage;
  graph.push(articleNode);

  if (includeBreadcrumb) {
    graph.push(buildBreadcrumbList(site, article.headline, article.url));
  }

  const faqNode = input.faq ? buildFaqPage(input.faq, article.url) : null;
  if (faqNode) graph.push(faqNode);

  return { "@context": "https://schema.org", "@graph": graph };
}

export interface PostBodyGraphInput {
  site: SiteIdentity;
  pageTitle: string;
  /** Null before publish — the breadcrumb and FAQ nodes work without it. */
  pageUrl?: string | null;
  faq?: FaqItem[] | null;
  includeBreadcrumb?: boolean;
}

/**
 * The graph safe to embed in a post BODY on a page that already emits an
 * Article graph in <head> (Shopify theme block, Yoast, RankMath): FAQPage plus
 * an optional BreadcrumbList. Returns null when there'd be nothing to emit —
 * callers must then leave the body alone rather than shipping an empty script.
 */
export function buildPostBodyGraph(
  input: PostBodyGraphInput,
): JsonLdDocument | null {
  const graph: JsonLdNode[] = [];
  const faqNode = input.faq ? buildFaqPage(input.faq, input.pageUrl) : null;
  if (faqNode) graph.push(faqNode);
  if (input.includeBreadcrumb ?? true) {
    graph.push(buildBreadcrumbList(input.site, input.pageTitle, input.pageUrl));
  }
  if (graph.length === 0) return null;
  return { "@context": "https://schema.org", "@graph": graph };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Serialize to a <script> tag. `<`, `>` and `&` are escaped as \u00xx so no
 * value in the JSON (an article title containing "</script>", an href with an
 * ampersand) can break out of the script element. This is a correctness
 * requirement, not a style choice — JSON-LD is parsed as raw text by the HTML
 * tokenizer, so an unescaped "</script" inside a string ends the element.
 */
export function renderJsonLdScript(doc: JsonLdDocument): string {
  const json = JSON.stringify(doc)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${json}</script>`;
}

// ─── Managed-block markers ──────────────────────────────────────────────────
//
// The markers exist so a re-run REPLACES our block instead of appending a
// second one. They therefore have to be findable — which is why the old
// implementation printed "netgrid-seo" into every page of the network and made
// the whole estate discoverable with one search operator.
//
// The fix keeps idempotency and drops the brand: the marker is a deterministic
// 8-hex-character token derived from the site's own host. Same site → same
// token forever (so we always find our own block); different sites → different
// tokens (so there is no shared literal string to search for). It is not a
// secret and is not meant to be — it defeats a literal-string search, which is
// the actual exposure, at zero cost to correctness.

/** FNV-1a 32-bit over the site host. Deterministic across processes/deploys. */
export function schemaMarkerToken(siteKey: string): string {
  const host = normalizeOrigin(siteKey).replace(/^https?:\/\//i, "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** HTML comment fences for a post body. */
export function htmlMarkers(token: string): { start: string; end: string } {
  return { start: `<!--${token}-->`, end: `<!--/${token}-->` };
}

/** Legacy branded fences. Matched only so an upgrade DELETES them. */
export const LEGACY_HTML_START = "<!-- netgrid-seo:jsonld:start -->";
export const LEGACY_HTML_END = "<!-- netgrid-seo:jsonld:end -->";

export function renderManagedJsonLdBlock(
  doc: JsonLdDocument,
  token: string,
): string {
  const { start, end } = htmlMarkers(token);
  return `${start}\n${renderJsonLdScript(doc)}\n${end}`;
}

function replaceSpan(
  body: string,
  start: string,
  end: string,
  block: string,
): string | null {
  const s = body.indexOf(start);
  const e = body.indexOf(end);
  if (s === -1 || e === -1 || e <= s) return null;
  return body.slice(0, s) + block + body.slice(e + end.length);
}

/**
 * Insert or replace the managed block. Idempotent, and migrating: a body still
 * carrying the LEGACY branded fences has them replaced in place, so the vendor
 * string physically leaves the live page on the first re-run. Pure — no I/O.
 */
export function upsertManagedBlock(
  body: string,
  block: string,
  token: string,
): string {
  const { start, end } = htmlMarkers(token);
  const current = replaceSpan(body, start, end, block);
  if (current !== null) return current;
  const legacy = replaceSpan(body, LEGACY_HTML_START, LEGACY_HTML_END, block);
  if (legacy !== null) return legacy;
  const trimmed = body.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

/** Remove the managed block (current OR legacy). Used by the rollback path. */
export function stripManagedBlock(body: string, token: string): string {
  const { start, end } = htmlMarkers(token);
  const current = replaceSpan(body, start, end, "");
  const base = current !== null ? current : body;
  const legacy = replaceSpan(base, LEGACY_HTML_START, LEGACY_HTML_END, "");
  return (legacy !== null ? legacy : base).replace(/\n{3,}/g, "\n\n");
}

// ─── FAQ plumbing ───────────────────────────────────────────────────────────

/**
 * Coerce whatever the model returned for `faq` into clean pairs. Tolerates the
 * shapes seen in the wild ({question,answer}, {q,a}) and caps both the number
 * of items and the answer length so appending a visible FAQ section can never
 * blow the post's word band.
 */
export function normalizeFaqItems(
  raw: unknown,
  limits: { maxItems?: number; maxAnswerWords?: number } = {},
): FaqItem[] {
  const maxItems = limits.maxItems ?? 4;
  const maxAnswerWords = limits.maxAnswerWords ?? 80;
  if (!Array.isArray(raw)) return [];

  const out: FaqItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const question = plainText(String(e.question ?? e.q ?? e.name ?? ""));
    const answerFull = plainText(String(e.answer ?? e.a ?? e.text ?? ""));
    if (question.length < 8 || answerFull.length < 20) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const words = answerFull.split(/\s+/);
    const answer =
      words.length > maxAnswerWords
        ? `${words.slice(0, maxAnswerWords).join(" ")}…`
        : answerFull;
    out.push({
      question: /\?$/.test(question) ? question : `${question}?`,
      answer,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/** True when the body already carries a Q/A section heading. */
export function hasFaqSection(html: string): boolean {
  const re = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (FAQ_HEADING_RE.test(plainText(m[1]))) return true;
  }
  return false;
}

/** The visible Q/A block. FAQPage markup MUST have visible text behind it. */
export function renderFaqSection(items: FaqItem[], heading: string): string {
  if (items.length === 0) return "";
  const body = items
    .map((i) => `<h3>${escapeHtml(i.question)}</h3><p>${escapeHtml(i.answer)}</p>`)
    .join("");
  return `<h2>${escapeHtml(heading)}</h2>${body}`;
}

/**
 * Read the Q/A pairs back OUT of the finished body. This — not the model's raw
 * faq[] — is what feeds the FAQPage node, so the markup can never claim an
 * answer the reader cannot see (the single most common cause of a manual
 * action for structured-data spam).
 *
 * Deliberately regex-based rather than cheerio: the generated body is a flat
 * sequence of h2/h3/p/ul, and this runs inside the generator's hot path.
 */
export function extractFaqFromHtml(html: string): FaqItem[] {
  const items: FaqItem[] = [];
  const sectionRe = /<h2\b[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi;
  let section: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(html)) !== null) {
    if (FAQ_HEADING_RE.test(plainText(m[1]))) {
      section = m[2];
      break;
    }
  }
  if (!section) return items;

  const qaRe = /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/gi;
  let qa: RegExpExecArray | null;
  while ((qa = qaRe.exec(section)) !== null) {
    const question = plainText(qa[1]);
    const answer = plainText(qa[2]).slice(0, 900);
    if (question.length < 8 || answer.length < 20) continue;
    items.push({ question, answer });
  }
  return items;
}

// ─── Blog row → identity ────────────────────────────────────────────────────
// Structurally typed on purpose: `typeof blogs.$inferSelect` satisfies this
// without lib/seo importing the Drizzle schema.

export interface BlogIdentityRow {
  domain: string;
  platform?: string | null;
  wpUrl?: string | null;
  shopifyStoreUrl?: string | null;
  brandName?: string | null;
  logoUrl?: string | null;
}

export function siteIdentityForBlog(blog: BlogIdentityRow): SiteIdentity {
  const raw =
    blog.platform === "shopify"
      ? blog.domain || blog.shopifyStoreUrl || ""
      : blog.wpUrl || blog.domain || "";
  return {
    origin: normalizeOrigin(raw),
    name: blog.brandName?.trim() || deriveBrandName(blog.domain) || blog.domain,
    logoUrl: blog.logoUrl ?? null,
    blogUrl: null,
    blogName: null,
  };
}

/**
 * Adapt T12's resolved byline into the AuthorIdentity this module wants.
 *
 * NOTE — the T20 SOP expects author_name / author_url / author_same_as columns
 * on `blogs`, and says T12 will add them. T12 as shipped does NOT: an author is
 * a first-class row in the `authors` table, because one real person can write
 * for several of a client's blogs and because consent and evidence have to live
 * next to the identity they authorise. This adapter is the seam between the
 * two, so this module stays pure and the database lookup stays in
 * services/author-entity.ts.
 *
 * Returns null when there is no real author on file, which makes
 * buildArticleGraph fall back to Organization-as-author — honest, and better
 * than a Person who does not exist.
 */
export function authorIdentityFrom(
  resolved: {
    name: string;
    authorPageUrl?: string | null;
    sameAs?: string[] | null;
  } | null | undefined,
): AuthorIdentity | null {
  const name = resolved?.name?.trim();
  if (!name) return null;
  const sameAs = (resolved?.sameAs ?? []).filter((u) => /^https?:\/\//i.test(u));
  return {
    name,
    url: resolved?.authorPageUrl?.trim() || null,
    sameAs: sameAs.length > 0 ? sameAs : null,
  };
}
