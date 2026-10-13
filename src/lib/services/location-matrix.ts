// Service × Location page matrix (S3 of the SEO-loop build) — "one page per
// [service]+[place]" at network scale, built on REAL data only.
//
// Sources (existing tables/functions only — F3): services come from the
// client's vertical config service list when present (content/verticals/*),
// else commercial-intent rows of client_keywords in the EXISTING winnability
// order (topActiveClientKeywordsWithMeta). Places come from each blog's
// blogs.city, the client's OTHER-blog cities (the clientCities network
// city-list pattern already hoisted in keyword-target-actions.ts — client-
// scoped DISTINCT, never network-wide), and site_profiles.neighborhood +
// additional_areas (0057, operator-filled). No geocoding, no invented suburbs
// — a place not in those tables never becomes a page; a blog with neither city
// nor profile facts contributes no rows.
//
// Rows are (service × place) pairs per carrying blog. Skip rules land as
// status='skipped' + reason in `error`: no_local_presence (clients.localPresence
// false → informational-only), already_covered (normalizeQueryKey hit in this
// blog's covered queries), duplicate_cluster (same normalized pair planned
// twice for the client). Priority is a RANK snapshot of the service term under
// the existing formula (lower = earlier) — no new scoring invented.
//
// The pure core takes plain data and returns rows, so it is fully testable
// without a DB; the builder below is its only producer and is idempotent —
// re-running adds 0 new rows (unique index on blog_id+service_key+place_name)
// and only refreshes pending/skipped decisions.

import { db } from "@/lib/db";
import { asc, inArray, sql, eq, and } from "drizzle-orm";
import {
  blogs as blogsTable,
  blogCoveredQueries,
  clients,
  siteProfiles,
} from "@/lib/db/schema";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import { detectKeywordIntent } from "@/lib/content/keyword-targeting";
import { topActiveClientKeywordsWithMeta } from "@/lib/content/client-keywords";

// ─── Named constants (F10) ────────────────────────────────────────────────────

/** Service terms per client: the matrix stays reviewable, not a combinatorial blast. */
export const MATRIX_SERVICE_CAP = 20;
/** Real places per blog (city + neighborhood + additional_areas), capped so one
 * operator typo can't fan out into hundreds of rows. */
const MAX_PLACES_PER_BLOG = 8;
/** Hard cap on planned rows per build (services × blogs × places). */
export const MATRIX_ROW_CAP = 500;
/** How many commercial-intent keyword rows to scan when picking service terms. */
const SERVICE_TERM_SCAN_ROWS = 60;

// ─── Pure core ────────────────────────────────────────────────────────────────

export interface MatrixServiceTerm {
  /** Normalized term (normalizeQueryKey) — the row's dedupe key part. */
  serviceKey: string;
  /** Original casing for display/combined_query. */
  display: string;
  /** Rank under the existing winnability order — lower is earlier. */
  priority: number;
}

export interface MatrixBlogPlaces {
  blogId: string;
  places: Array<{ placeName: string; source: "city" | "neighborhood" | "additional_area" }>;
}

export type MatrixRowStatus = "pending" | "skipped";

/** One planned ledger row. `skipReason` is the exact token written to error. */
export interface MatrixPlannedRow {
  blogId: string;
  serviceKey: string;
  placeName: string;
  combinedQuery: string;
  status: MatrixRowStatus;
  skipReason: "no_local_presence" | "already_covered" | "duplicate_cluster" | null;
  priority: number;
}

/**
 * THE matrix planner. Pure + deterministic (DoD: re-run adds 0 rows — same
 * inputs, same planned state). Iteration order is fixed: blogs in input order,
 * places in input order, services by rank — so two builds of the same client
 * produce byte-identical row sets.
 */
export function planMatrixRows(opts: {
  services: MatrixServiceTerm[];
  blogs: MatrixBlogPlaces[];
  clientLocalPresence: boolean;
  /** blogId → set of normalizeQueryKey values this blog has already covered. */
  coveredByBlog?: Map<string, Set<string>>;
}): MatrixPlannedRow[] {
  const rows: MatrixPlannedRow[] = [];
  // duplicate_cluster guard is client-wide within one build: a normalized pair
  // that gets a pending row here must not get another from a second place.
  const seenClusters = new Set<string>();

  for (const blog of opts.blogs) {
    if (rows.length >= MATRIX_ROW_CAP) break;
    const covered = opts.coveredByBlog?.get(blog.blogId);
    for (const place of blog.places) {
      if (rows.length >= MATRIX_ROW_CAP) break;
      for (const service of opts.services) {
        if (rows.length >= MATRIX_ROW_CAP) break;
        const combinedQuery = `${service.display} ${place.placeName}`.replace(/\s+/g, " ").trim();
        const clusterKey = normalizeQueryKey(combinedQuery);

        let status: MatrixRowStatus = "pending";
        let skipReason: MatrixPlannedRow["skipReason"] = null;
        if (!opts.clientLocalPresence) {
          // Informational-only rows — the operator sees the shape of the
          // opportunity without a single page being generated (F3).
          status = "skipped";
          skipReason = "no_local_presence";
        } else if (clusterKey && covered?.has(clusterKey)) {
          status = "skipped";
          skipReason = "already_covered";
        } else if (clusterKey && seenClusters.has(clusterKey)) {
          status = "skipped";
          skipReason = "duplicate_cluster";
        } else if (clusterKey) {
          seenClusters.add(clusterKey);
        }

        rows.push({
          blogId: blog.blogId,
          serviceKey: service.serviceKey,
          placeName: place.placeName.slice(0, 160),
          combinedQuery: combinedQuery.slice(0, 400),
          status,
          skipReason,
          priority: service.priority,
        });
      }
    }
  }
  return rows;
}

/** One candidate row for the shared claimer's ordering (plain data — testable). */
export interface LocationClaimCandidate {
  id: string;
  priority: number | null;
  lastAttemptAt: Date | null;
}

/**
 * THE claim order, as a pure comparator (DoD regression target):
 *   priority ASC NULLS LAST → last_attempt_at ASC NULLS FIRST → id ASC.
 * That ordering IS the neighborhood rotation: every area gets turns over time
 * without any new state — untried rows (last_attempt_at NULL) always go first,
 * then the oldest-untouched.
 */
export function compareLocationCandidates(a: LocationClaimCandidate, b: LocationClaimCandidate): number {
  const ap = a.priority ?? Number.MAX_SAFE_INTEGER;
  const bp = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (ap !== bp) return ap - bp;
  const an = a.lastAttemptAt === null || isNaN(a.lastAttemptAt.getTime());
  const bn = b.lastAttemptAt === null || isNaN(b.lastAttemptAt.getTime());
  if (an && !bn) return -1; // NULLS FIRST
  if (!an && bn) return 1;
  if (a.lastAttemptAt!.getTime() !== b.lastAttemptAt!.getTime()) {
    return a.lastAttemptAt!.getTime() < b.lastAttemptAt!.getTime() ? -1 : 1;
  }
  return a.id.localeCompare(b.id); // stable tail — never two orders for one input
}

/** Failed location rows serve this cool-off before they can be re-claimed (the
 * claim query refuses error-set rows with a recent last_attempt_at). Named — no magic numbers. */
export const LOCATION_RETRY_COOLDOWN_HOURS = 6;

/** Which ledger mark a refused claim gets, plus its exact reason string — pure,
 * so the dispatch is unit-testable without a DB. S3 DoD: an un-profiled blog's
 * matrix row stays PENDING with the reason (the cool-off predicate serves it
 * back to rotation); duplicate-title / already-covered rows go terminal
 * 'skipped'. Legacy ledger behavior stays byte-identical to pre-S3. Lives here
 * (not in the "use server" action) because Next only allows async exports there. */
export type ClaimedTargetDisposition =
  | { action: "skipped"; reason: string }
  | { action: "failed"; reason: string };

export function decideClaimedTargetDisposition(input: {
  ledger: "location_page_targets" | "blog_keyword_targets";
  keyword: string;
  /** localFraming claim whose site-profile gate failed (or facts missing). */
  gateBlocked: boolean;
  gateReason?: string | null;
  duplicateTitle?: { title: string; score: number } | null;
}): ClaimedTargetDisposition {
  // Precedence mirrors the pre-S3 inline order exactly: gate → duplicate title
  // → already covered. The reason strings are byte-identical to what was logged
  // before S3, so legacy ledger rows see no behavior change at all.
  if (input.gateBlocked) {
    const reason = input.gateReason || "local page refused: site profile is not ready";
    return input.ledger === "location_page_targets"
      ? // 'failed' = requeue to pending + error(reason): the claimer refuses rows
        // whose last_attempt_at is inside LOCATION_RETRY_COOLDOWN_HOURS, so an
        // un-profiled blog rotates instead of hot-looping — and a later profile
        // fill lets the next run reclaim cleanly without a rebuild.
        { action: "failed", reason }
      : { action: "skipped", reason };
  }
  if (input.duplicateTitle) {
    return {
      action: "skipped",
      reason: `title duplicates "${input.duplicateTitle.title}" (${Math.round(input.duplicateTitle.score * 100)}% word overlap)`,
    };
  }
  return { action: "skipped", reason: `keyword "${input.keyword}" is already covered by this blog` };
}

/** Per-blog daily budget check (clients.location_pages_per_day, default 2). */
export function locationBudgetExhausted(todayClaimCount: number, pagesPerDay: number): boolean {
  return todayClaimCount >= Math.max(0, pagesPerDay);
}

/**
 * The fixed anatomy for a service × place page. Rides inside the local target
 * directive so it reaches EVERY prompt path (locked-profile or legacy). Pure —
 * same inputs, byte-identical text; uses only values the caller provided (F3).
 */
export function localServicePageStructure(serviceDisplay: string, placeName: string): string {
  const service = serviceDisplay.trim() || "the service";
  const place = placeName.trim() || "the area";
  return [
    `LOCAL SERVICE PAGE STRUCTURE (fixed — overrides any drawn template flow):`,
    `- H1 must be exactly: ${service} in ${place}`,
    `- Who we are: 60–90 words from the operator facts below ONLY.`,
    `- Service list: only services present in the directive/knowledge data.`,
    `- Local proof points: only real facts; omit the section if none exist.`,
    `- Close with a 3–5 question FAQ block local searchers actually ask here.`,
  ].join("\n");
}

// ─── DB-backed builder (fail-safe reads, idempotent upsert) ──────────────────────

export interface MatrixBuildSummary {
  servicesPlanned: number;
  blogsWithPlaces: number;
  rowsPlanned: number;
  pendingRows: number;
  skippedRows: number;
}

/** (1) Vertical-config service list — the documented seam. None of the registry
 * entries define an operator-verified service list today (searchTerms are news
 * queries, not services), so this returns [] and source (2) is used. */
function verticalServiceTerms(niche: string | null): MatrixServiceTerm[] {
  void niche;
  return [];
}

/** Service terms from EXISTING sources only, in the spec's order. Fail-safe [].
 * Exported for S4's GBP packs (F5 reuse: the packs' "real services" are the
 * SAME commercial-intent terms the matrix plans pages for — one source of
 * truth for "what this client actually sells"). */
export async function serviceTermsForClient(
  clientId: string,
  niche: string | null,
): Promise<MatrixServiceTerm[]> {
  const fromVertical = verticalServiceTerms(niche);
  if (fromVertical.length > 0) return fromVertical.slice(0, MATRIX_SERVICE_CAP);

  // (2) commercial-intent rows of client_keywords under the EXISTING winnability
  // order — priority is that rank, so no new scoring is invented.
  let ranked: Array<{ keyword: string }>;
  try {
    ranked = await topActiveClientKeywordsWithMeta(clientId, SERVICE_TERM_SCAN_ROWS);
  } catch (err) {
    console.warn(
      "[location-matrix] service-term read failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
  const seen = new Set<string>();
  const out: MatrixServiceTerm[] = [];
  for (const r of ranked) {
    if (out.length >= MATRIX_SERVICE_CAP) break;
    const keyword = String(r.keyword ?? "").trim();
    // Commercial intent = the SAME detection the local-framing machinery trusts.
    if (!keyword || detectKeywordIntent(keyword) !== "transactional") continue;
    const key = normalizeQueryKey(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ serviceKey: key, display: keyword.slice(0, 120), priority: out.length + 1 });
  }
  return out;
}

/** Real places per blog — city, neighborhood, additional_areas. Trimmed, deduped
 * case-insensitively, capped. Pure (testable without a DB).
 * `otherClientCities` = the client's other-blog cities (spec's second place
 * source): appended AFTER the blog's own/curated places so they only take
 * leftover cap slots, alphabetical so the slice stays deterministic. */
export function placesForBlog(
  blogCity: string | null,
  neighborhood: string | null,
  additionalAreas: string[],
  otherClientCities: string[] = [],
): Array<{ placeName: string; source: "city" | "neighborhood" | "additional_area" }> {
  const out: Array<{ placeName: string; source: "city" | "neighborhood" | "additional_area" }> = [];
  const seen = new Set<string>();
  const push = (name: string | null, source: "city" | "neighborhood" | "additional_area") => {
    const s = String(name ?? "").trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ placeName: s.slice(0, 160), source });
  };
  push(blogCity, "city");
  push(neighborhood, "neighborhood");
  for (const a of additionalAreas) push(a, "additional_area");
  // Other-blog cities LAST (leftover cap slots only), alphabetical so the cap
  // slice is deterministic.
  for (const c of [...otherClientCities]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))) {
    push(c, "city");
  }
  return out.slice(0, MAX_PLACES_PER_BLOG);
}

/**
 * Build/refresh the client's matrix. Idempotent (DoD): re-running adds 0 new
 * rows — the unique index owns identity, and DO UPDATE only refreshes rows
 * still in 'pending'/'skipped', so in-flight and finished work is never churned.
 */
export async function buildLocationMatrixForClient(clientId: string): Promise<MatrixBuildSummary> {
  const [client] = await db
    .select({ id: clients.id, localPresence: clients.localPresence, niche: clients.niche })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error("Client not found");

  const services = await serviceTermsForClient(clientId, client.niche ?? null);
  const empty: MatrixBuildSummary = {
    servicesPlanned: services.length,
    blogsWithPlaces: 0,
    rowsPlanned: 0,
    pendingRows: 0,
    skippedRows: 0,
  };
  // No real service terms → no invented matrix (F3).
  if (services.length === 0) return empty;

  const blogRows = await db
    .select({ id: blogsTable.id, city: blogsTable.city })
    .from(blogsTable)
    .where(and(eq(blogsTable.clientId, clientId), eq(blogsTable.status, "active")))
    .orderBy(asc(blogsTable.domain));
  if (blogRows.length === 0) return empty;

  // The client's other-blog cities — DISTINCT over this client's ACTIVE blogs
  // (the clientCities pattern hoisted in keyword-target-actions.ts; client-
  // scoped so one client's cities never leak into another's matrix).
  const clientCityRows = (await db.execute(sql`
    SELECT DISTINCT btrim(city) AS city FROM blogs
    WHERE client_id = ${clientId} AND status = 'active'
      AND city IS NOT NULL AND btrim(city) <> ''
  `)) as unknown as Array<{ city: string }>;
  const clientCities = clientCityRows
    .map((r) => String(r.city ?? "").trim())
    .filter(Boolean);

  const profileRows = await db
    .select({
      blogId: siteProfiles.blogId,
      neighborhood: siteProfiles.neighborhood,
      additionalAreas: siteProfiles.additionalAreas,
    })
    .from(siteProfiles)
    .where(inArray(siteProfiles.blogId, blogRows.map((b) => b.id)));
  const profileByBlog = new Map(profileRows.map((p) => [p.blogId, p]));

  // Covered queries per blog — the already_covered skip source (same key format
  // recordCoveredQuery writes: normalizeQueryKey).
  const coveredRows = await db
    .select({ blogId: blogCoveredQueries.blogId, queryNorm: blogCoveredQueries.queryNorm })
    .from(blogCoveredQueries)
    .where(eq(blogCoveredQueries.clientId, clientId));
  const coveredByBlog = new Map<string, Set<string>>();
  for (const r of coveredRows) {
    if (!r.queryNorm) continue;
    let set = coveredByBlog.get(r.blogId);
    if (!set) {
      set = new Set<string>();
      coveredByBlog.set(r.blogId, set);
    }
    set.add(String(r.queryNorm));
  }

  const blogs: MatrixBlogPlaces[] = [];
  for (const b of blogRows) {
    const prof = profileByBlog.get(b.id);
    const areas = Array.isArray(prof?.additionalAreas)
      ? (prof.additionalAreas as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const ownCity = String(b.city ?? "").trim();
    const otherCities = clientCities.filter(
      (c) => c.toLowerCase() !== ownCity.toLowerCase(),
    );
    const places = placesForBlog(b.city ?? null, prof?.neighborhood ?? null, areas, otherCities);
    if (places.length > 0) blogs.push({ blogId: b.id, places });
  }
  if (blogs.length === 0) return empty;

  const planned = planMatrixRows({
    services,
    blogs,
    clientLocalPresence: client.localPresence,
    coveredByBlog,
  });
  if (planned.length === 0) return { ...empty };

  // Idempotent upsert in chunks — one statement per ≤100 rows.
  const CHUNK = 100;
  for (let i = 0; i < planned.length; i += CHUNK) {
    const chunk = planned.slice(i, i + CHUNK);
    await db.execute(
      sql`INSERT INTO location_page_targets
           (blog_id, client_id, service_key, place_name, combined_query, status, priority, error)
         VALUES ${sql.join(
           chunk.map(
             (r) =>
               sql`(${r.blogId}, ${clientId}, ${r.serviceKey}, ${r.placeName}, ${r.combinedQuery}, ${r.status}, ${r.priority}, ${r.skipReason})`,
           ),
           sql`, `,
         )}
         ON CONFLICT (blog_id, service_key, place_name) DO UPDATE SET
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           error = EXCLUDED.error,
           updated_at = now()
         WHERE location_page_targets.status IN ('pending', 'skipped')`,
    );
  }

  const pendingRows = planned.filter((r) => r.status === "pending").length;
  console.log(
    `[location-matrix] client ${clientId}: services=${services.length} blogs=${blogs.length} ` +
      `rows=${planned.length} pending=${pendingRows} skipped=${planned.length - pendingRows}`,
  );
  return {
    servicesPlanned: services.length,
    blogsWithPlaces: blogs.length,
    rowsPlanned: planned.length,
    pendingRows,
    skippedRows: planned.length - pendingRows,
  };
}

// ── Outcome reads — the proof layer made surfaceable (S3 §E) ─────────────────
// One source for every consumer of location-page results: the portal card
// ("N service-area pages this month"), the v1 `locationPages=1&since=` cursor
// endpoint and the monthly PDF's coverage line all read THESE ledger rows, so a
// number can never appear anywhere without its two measurements (F8). Counts
// are direct ledger facts — no estimation.

export interface LocationPageOutcomeRow {
  targetId: string;
  /** combined_query — the "[service] [place]" page targets. */
  query: string;
  serviceKey: string;
  placeName: string;
  domain: string | null;
  /** ISO updated_at at mark-generated time — THE cursor field (strict >). */
  generatedAt: string;
}

export interface LocationPageOutcomeOptions {
  /** Strict lower bound on the generated timestamp (cursor / "since" reads). */
  since?: Date;
  limit?: number; // default 200, hard cap 500 — same convention as rescues?since=
}

interface RawLocationOutcomeRow {
  targetId: string;
  query: string | null;
  serviceKey: string | null;
  placeName: string | null;
  domain: string | null;
  generatedAt: unknown;
}

/** Generated location pages for one client, ordered by generatedAt asc so
 * `locationPages=1&since=` is a stable forward cursor (same shape as S1's
 * listRescueOutcomes — pass nextCursor back as since to page). */
export async function listLocationPageOutcomes(
  clientId: string,
  opts: LocationPageOutcomeOptions = {},
): Promise<LocationPageOutcomeRow[]> {
  const sinceIso = opts.since ? new Date(opts.since).toISOString() : null;
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 200)));

  const rows = (await db.execute(sql`
    SELECT t.id AS targetId,
           t.combined_query AS query,
           t.service_key AS serviceKey,
           t.place_name AS placeName,
           b.domain AS domain,
           t.updated_at AS generatedAt
    FROM location_page_targets t
    LEFT JOIN blogs b ON b.id = t.blog_id
    WHERE t.client_id = ${clientId} AND t.status = 'generated'
      ${sinceIso ? sql`AND t.updated_at::timestamptz > ${new Date(sinceIso)}` : sql``}
    ORDER BY t.updated_at ASC, t.id ASC
    LIMIT ${limit}
  `)) as unknown as RawLocationOutcomeRow[];

  return rows.flatMap((r) => {
    const ts = r.generatedAt ? new Date(String(r.generatedAt)).getTime() : NaN;
    if (Number.isNaN(ts)) return []; // never emit a row without its cursor field
    return [{
      targetId: String(r.targetId),
      query: String(r.query ?? ""),
      serviceKey: String(r.serviceKey ?? ""),
      placeName: String(r.placeName ?? ""),
      domain: r.domain,
      generatedAt: new Date(ts).toISOString(),
    }];
  });
}

export interface LocationPagesSummary {
  /** Generated since `sinceIso` (LA month-start for the portal card). */
  publishedSince: number;
  /** Actionable rows (pending + generating + generated) — skipped rows are
   * informational-only and never count toward coverage (F3 honesty). */
  actionableTotal: number;
}

/** Portal card math — "N service-area pages this month" + the coverage line.
 * Zero actionable rows → both zeros (the portal renders an honest empty state,
 * or omits the card entirely when no matrix exists yet). */
export async function locationPagesSummaryForClient(
  clientId: string,
  sinceIso: string,
): Promise<LocationPagesSummary> {
  const [row] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'generated' AND updated_at >= ${new Date(sinceIso)})::int AS publishedSince,
           count(*) FILTER (WHERE status IN ('pending', 'generating', 'generated'))::int AS actionableTotal
    FROM location_page_targets
    WHERE client_id = ${clientId}
  `)) as unknown as Array<{ publishedSince: number | string; actionableTotal: number | string }>;

  return {
    publishedSince: Number(row?.publishedSince ?? 0) || 0,
    actionableTotal: Number(row?.actionableTotal ?? 0) || 0,
  };
}

/** Monthly PDF "coverage % line" data (S3 §E). Null when the client has no
 * actionable matrix rows yet — an expected empty state that omits the line —
 * or on read failure: the PDF must never fail because of it (same posture as
 * S1's queriesThatMovedForPeriod). */
export async function locationCoverageForPeriod(
  clientId: string,
  periodStartIso: string,
  periodEndIso: string,
): Promise<{ publishedInPeriod: number; generatedTotal: number; actionableTotal: number } | null> {
  try {
    const start = new Date(periodStartIso);
    const end = new Date(periodEndIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

    const [row] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'generated' AND updated_at >= ${start} AND updated_at <= ${end})::int AS publishedInPeriod,
             count(*) FILTER (WHERE status = 'generated')::int AS generatedTotal,
             count(*) FILTER (WHERE status IN ('pending', 'generating', 'generated'))::int AS actionableTotal
      FROM location_page_targets
      WHERE client_id = ${clientId}
    `)) as unknown as Array<{
      publishedInPeriod: number | string;
      generatedTotal: number | string;
      actionableTotal: number | string;
    }>;

    const publishedInPeriod = Number(row?.publishedInPeriod ?? 0) || 0;
    const generatedTotal = Number(row?.generatedTotal ?? 0) || 0;
    const actionableTotal = Number(row?.actionableTotal ?? 0) || 0;
    if (actionableTotal === 0) return null; // no matrix → nothing to cover

    return { publishedInPeriod, generatedTotal, actionableTotal };
  } catch (err) {
    console.warn(
      "[location-matrix] coverage read failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Coverage % — the single formula every surface uses (locations page, portal
 * line, PDF). Skipped rows are informational-only and stay OUT of the
 * denominator. Pure + testable. */
export function locationCoveragePct(generatedTotal: number, actionableTotal: number): number | null {
  if (!Number.isFinite(actionableTotal) || actionableTotal <= 0) return null;
  return Math.round((100 * Math.max(0, generatedTotal)) / actionableTotal);
}
