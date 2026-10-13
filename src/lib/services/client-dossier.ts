// Client SEO dossier (S6 of the SEO-loop build) — "load business context once,
// never repeat". Every generated artifact this session adds (rescue meta in S1,
// location pages in S3, GBP packs in S4, sprint plans in S7) injects ONE shared
// fact sheet at the top of its prompt instead of re-asking or inventing.
//
// Two halves:
//   getDossierForClient(clientId) — MERGED READ: dossier row + site_profiles
//     facts (real operator data, B.5) + top live GSC pairs (S0 module — F5 reuse
//     of rankedPageQueryPairs, no new aggregation) + open issue counts. All DB
//     reads are fail-safe: a missing table or failed read degrades that section
//     to empty, never throws into the caller's prompt build.
//   buildDossierContextBlock(view) — PURE + DETERMINISTIC: renders that view as
//     one text block. No Date.now() inside (staleness is pre-computed by the
//     reader and passed in), no randomness, stable section order — so a fixture
//     dossier always produces byte-identical output (hard S6 DoD). Missing facts
//     render as "not provided — do not invent" (F3); gaps are printed as gaps
//     (F8). Size is bounded by construction: ~1200-token budget with a fixed
//     truncation ORDER (competitors → wins → audience → area) and two sections
//     that never truncate (business_model, differentiators).

import { db } from "@/lib/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  clients as clientsTable,
  blogs as blogsTable,
  clientSeoDossiers,
  seoIssues,
  siteProfiles,
} from "@/lib/db/schema";
import { rankedPageQueryPairs, type PageQueryPair } from "@/lib/content/gsc-pool";

/** Optional integer tuning knob from the environment. Falls back on anything
 * unparseable (client-keywords.ts pattern — F7). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Prompt budget for the context block in APPROXIMATE tokens. Postgres text is
 * UTF-8 and prompts are tokenized ~4 chars/token, so the builder caps on a char
 * budget of TOKENS × 4 — a documented approximation that keeps the bound exact
 * (char-countable) while staying honest about what it measures. */
export const DOSSIER_CONTEXT_TOKEN_BUDGET = envInt("DOSSIER_CONTEXT_TOKEN_BUDGET", 1200);

/** A dossier unverified for longer than this gets a staleness warning line in
 * the context block (the spec's "stale (>90d) dossiers say so in output"). */
export const DOSSIER_STALE_DAYS = 90;

/** How many of the client's blogs feed site-profile facts into the block. The
 * merged read stays bounded no matter how big a network gets. */
const MAX_PROFILE_BLOGS = 3;

/** Top live pairs shown per dossier — enough to ground copy, small by design. */
const MAX_LIVE_PAIRS_IN_BLOCK = 5;

/** The one phrase every missing fact renders as (F3: real data only). */
export const NOT_PROVIDED = "not provided — do not invent";

/** One pasted competitor profile. S4's GBP tab owns the full paste shape; this
 * is what the shared block knows how to render. Unknown extra fields are ignored
 * here on purpose (deterministic output from an operator-shaped object). */
export interface DossierCompetitor {
  name: string;
  category?: string | null;
  reviewCount?: number | null;
  description?: string | null;
}

/** site_profiles facts for one of the client's blogs. */
export interface DossierSiteProfile {
  domain: string;
  neighborhood: string | null;
  signatureFacts: string[];
  doesNot: string[];
  placeNote: string | null;
}

/** The merged, serializable view a prompt consumer (or the admin UI) works from. */
export interface DossierView {
  clientId: string;
  /** False when no dossier row exists yet — the block then says so explicitly. */
  started: boolean;
  businessModel: string | null;
  serviceArea: string[];
  differentiators: string[];
  audience: string | null;
  competitors: DossierCompetitor[];
  recentWins: string[];
  gaps: string | null;
  /** ISO string or null — serialized for React props. */
  lastVerifiedAt: string | null;
  /** Pre-computed staleness line (time-dependent work stays OUT of the pure
   * builder so its output is byte-stable for a fixed view). Null when fresh. */
  staleWarning: string | null;
  siteProfiles: DossierSiteProfile[];
  topLivePairs: PageQueryPair[];
  openIssueCounts: Record<string, number>;
}

// ── Merged read (DB-backed — every section fail-safe) ────────────────────────

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * The one read path for the per-client fact sheet. Merges, in order of trust:
 * operator-entered dossier row → site_profiles facts (B.5 gate machinery) →
 * live GSC pairs via the S0 module → open issue counts. Each section is read in
 * its own try/catch so one unavailable source degrades to empty instead of
 * failing the whole block — and a client with NO data at all still gets a view
 * (started=false, everything NOT_PROVIDED), which is an expected state, not an
 * error (F8).
 */
export async function getDossierForClient(clientId: string): Promise<DossierView> {
  const empty: DossierView = {
    clientId,
    started: false,
    businessModel: null,
    serviceArea: [],
    differentiators: [],
    audience: null,
    competitors: [],
    recentWins: [],
    gaps: null,
    lastVerifiedAt: null,
    staleWarning: null,
    siteProfiles: [],
    topLivePairs: [],
    openIssueCounts: {},
  };

  // 1. The operator-verified row (or absence of one).
  try {
    const [row] = await db
      .select()
      .from(clientSeoDossiers)
      .where(eq(clientSeoDossiers.clientId, clientId))
      .limit(1);
    if (row) {
      empty.started = true;
      empty.businessModel = row.businessModel;
      empty.serviceArea = asStringArray(row.serviceArea);
      empty.differentiators = asStringArray(row.differentiators);
      empty.audience = row.audience;
      empty.recentWins = asStringArray(row.recentWins);
      empty.gaps = row.gaps;
      if (row.lastVerifiedAt) {
        empty.lastVerifiedAt = new Date(row.lastVerifiedAt).toISOString();
        // Staleness is time-dependent — computed HERE so the pure builder stays
        // byte-stable. Rendered as a relative statement, never a raw timestamp.
        const ageDays = (Date.now() - row.lastVerifiedAt.getTime()) / 86_400_000;
        if (Number.isFinite(ageDays) && ageDays > DOSSIER_STALE_DAYS) {
          empty.staleWarning = `WARNING: this dossier was last verified more than ${DOSSIER_STALE_DAYS} days ago — treat its facts as possibly stale and confirm material claims with the operator.`;
        }
      }
      // S4's GBP tab owns competitor pastes; render only what we can verify.
      empty.competitors = (Array.isArray(row.competitorProfiles)
        ? (row.competitorProfiles as unknown[])
            .map((c): DossierCompetitor | null => {
              if (!c || typeof c !== "object") return null;
              const o = c as Record<string, unknown>;
              const name = String(o.name ?? "").trim();
              if (!name) return null; // unnamed paste rows carry no identity
              return {
                name,
                category: o.category ? String(o.category).trim() : null,
                reviewCount:
                  typeof o.reviewCount === "number" && Number.isFinite(o.reviewCount)
                    ? Math.trunc(o.reviewCount)
                    : null,
                description: o.description ? String(o.description).slice(0, 500) : null,
              };
            })
            .filter((c): c is DossierCompetitor => c !== null)
        : []);
    }
  } catch (err) {
    console.warn(
      `[client-dossier] dossier row read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 2. site_profiles facts for up to MAX_PROFILE_BLOGS of this client's blogs,
  //    domain-ordered so the block is deterministic across runs.
  try {
    const profiles = await db
      .select({
        domain: blogsTable.domain,
        neighborhood: siteProfiles.neighborhood,
        signatureFacts: siteProfiles.signatureFacts,
        doesNot: siteProfiles.doesNot,
        placeNote: siteProfiles.placeNote,
      })
      .from(siteProfiles)
      .innerJoin(blogsTable, eq(siteProfiles.blogId, blogsTable.id))
      .where(eq(siteProfiles.clientId, clientId))
      .orderBy(asc(blogsTable.domain))
      .limit(MAX_PROFILE_BLOGS);
    empty.siteProfiles = profiles.map((p) => ({
      domain: p.domain,
      neighborhood: p.neighborhood,
      signatureFacts: asStringArray(p.signatureFacts),
      doesNot: asStringArray(p.doesNot),
      placeNote: p.placeNote,
    }));
  } catch (err) {
    console.warn(
      `[client-dossier] site-profile read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Top live GSC pairs via the S0 module — impressions-weighted positions,
  //    same floors as every other detector (F5: one aggregation rule).
  try {
    const activeBlogs = await db
      .select({ id: blogsTable.id })
      .from(blogsTable)
      .where(and(eq(blogsTable.clientId, clientId), eq(blogsTable.status, "active")))
      .orderBy(asc(blogsTable.domain))
      .limit(MAX_PROFILE_BLOGS);
    const merged: PageQueryPair[] = [];
    for (const b of activeBlogs) {
      // rankedPageQueryPairs is already fail-safe [] per blog.
      const pairs = await rankedPageQueryPairs(b.id, { limit: MAX_LIVE_PAIRS_IN_BLOCK });
      merged.push(...pairs);
    }
    empty.topLivePairs = merged
      .sort((a, b) => b.impressions90d - a.impressions90d)
      .slice(0, MAX_LIVE_PAIRS_IN_BLOCK);
  } catch (err) {
    console.warn(
      `[client-dossier] live-pair read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 4. Open issue counts by status — the "queue got shorter by itself" number.
  try {
    const rows = await db
      .select({ status: seoIssues.status, n: sql<number>`count(*)::int` })
      .from(seoIssues)
      .where(eq(seoIssues.clientId, clientId))
      .groupBy(seoIssues.status);
    for (const r of rows) {
      if (!r.status) continue; // column is nullable in schema — skip nulls defensively
      empty.openIssueCounts[r.status] = Number(r.n) || 0;
    }
  } catch (err) {
    console.warn(
      `[client-dossier] issue-count read failed for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return empty;
}

// ── Pure context block builder (unit-tested — byte-stable) ───────────────────

/**
 * The single text block injected at the TOP of every prompt this session adds
 * (S1 rescue meta, S3 location pages, S4 GBP packs, S7 sprint plans). PURE:
 * same view in → identical string out. No Date.now(), no randomness, stable
 * section order and list order — a fixture dossier is byte-stable by
 * construction (hard S6 DoD), which is also what makes the three prompt
 * consumers provably share one builder.
 *
 * Size rule: ≤ DOSSIER_CONTEXT_TOKEN_BUDGET × 4 chars, enforced by dropping
 * WHOLE truncatable sections in the spec's order — competitor → wins →
 * audience → area. business_model and differentiators NEVER truncate (they are
 * the point of a dossier); if core content alone exceeds the budget we keep it
 * all rather than cut operator-verified facts (documented pathological case).
 */
export function buildDossierContextBlock(view: DossierView): string {
  const charBudget = Math.max(400, DOSSIER_CONTEXT_TOKEN_BUDGET) * 4;

  // Truncatable sections in the spec's truncation order. Each returns its lines
  // or null when it has nothing to say (null sections are skipped entirely).
  const competitorsSection: string[] | null = view.competitors.length > 0
    ? [
        "COMPETITOR PROFILES (operator-pasted GBP data):",
        ...view.competitors.slice(0, 5).map((c) => {
          const bits = [`- ${c.name}`];
          if (c.category) bits.push(`category: ${c.category}`);
          if (typeof c.reviewCount === "number") bits.push(`${c.reviewCount} reviews`);
          return bits.join(" | ");
        }),
      ]
    : null;

  const winsSection: string[] | null = view.recentWins.length > 0
    ? ["RECENT WINS (measured outcomes):", ...view.recentWins.slice(0, 5).map((w) => `- ${w}`)]
    : null;

  const audienceSection: string[] | null = view.audience?.trim()
    ? [`AUDIENCE:\n${view.audience.trim()}`]
    : null;

  const areaSection: string[] | null = view.serviceArea.length > 0
    ? ["SERVICE AREA (real places only): " + view.serviceArea.slice(0, 12).join(", ")]
    : null;

  // Always-on core. Missing facts render as NOT_PROVIDED — a gap is printed as
  // a gap, never backfilled with guesses (F3/F8).
  const core: string[] = [
    'CLIENT DOSSIER — operator-verified facts only. Use ONLY these; where a field says "' +
      NOT_PROVIDED + '", do not invent anything.',
  ];
  if (!view.started) {
    core.push(
      "DOSSIER NOT STARTED — no operator-verified facts exist yet. Ask the operator before writing client-facing copy.",
    );
  }
  if (view.staleWarning) core.push(view.staleWarning);
  core.push(`BUSINESS MODEL:\n${view.businessModel?.trim() || NOT_PROVIDED}`);
  core.push(
    view.differentiators.length > 0
      ? "DIFFERENTIATORS (never invented):" +
        view.differentiators.slice(0, 8).map((d) => `\n- ${d}`).join("")
      : `DIFFERENTIATORS:\n${NOT_PROVIDED}`,
  );
  core.push(`GAPS (honest unknowns — keep them visible):\n${view.gaps?.trim() || "none recorded"}`);

  if (view.siteProfiles.length > 0) {
    core.push("SITE PROFILES (operator-entered, per blog):");
    for (const p of view.siteProfiles.slice(0, MAX_PROFILE_BLOGS)) {
      const bits = [`- ${p.domain}`];
      if (p.neighborhood) bits.push(`area: ${p.neighborhood}`);
      if (p.signatureFacts.length > 0)
        bits.push("facts: " + p.signatureFacts.slice(0, 5).join("; "));
      if (p.doesNot.length > 0) bits.push("does not: " + p.doesNot.slice(0, 3).join("; "));
      core.push(bits.join(" | "));
    }
  }

  const liveLines =
    view.topLivePairs.length > 0
      ? [
          "LIVE SEARCH DATA (trailing 90 days, impressions-weighted):",
          ...view.topLivePairs.map((p) => `- "${p.query}" @ position ${round1(p.avgPosition)} (${p.impressions90d} impressions)`),
        ]
      : ["LIVE SEARCH DATA: no Search Console data in the trailing window."];
  core.push(...liveLines);

  const issueBits = Object.entries(view.openIssueCounts).filter(([, n]) => (n ?? 0) > 0);
  core.push(
    issueBits.length > 0
      ? "OPEN ISSUES: " + issueBits.map(([s, n]) => `${n} ${s}`).join(", ")
      : "OPEN ISSUES: ledger empty.",
  );

  // Display order after core; DROP order on budget overflow is this same array
  // front-to-back: competitors → wins → audience → area.
  const optionalSections: Array<string[] | null> = [
    competitorsSection, // tier 1 — dropped first when over budget
    winsSection,        // tier 2
    audienceSection,    // tier 3
    areaSection,        // tier 4 — dropped last
  ];

  const assemble = (included: boolean[]): string => {
    const out: string[] = [...core];
    for (let i = 0; i < optionalSections.length; i++) {
      const section = optionalSections[i];
      if (included[i] && section) out.push(...section);
    }
    return out.join("\n");
  };

  const included = [true, true, true, true];
  let block = assemble(included);
  // Whole-section drops in the spec's truncation order until under budget. If
  // core alone exceeds it (pathological), keep everything — never cut
  // operator-verified business_model / differentiators.
  for (let i = 0; block.length > charBudget && i < included.length; i++) {
    included[i] = false;
    block = assemble(included);
  }

  return block;
}

/** One decimal place for rendered positions — stable string, no float noise. */
function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ─── §E rollout row: dossier freshness check (weekly-run counter) ────────────

export interface DossierFreshnessCounts {
  clients: number;
  verified: number;
  stale: number;
  neverVerified: number;
}

/** Pure core of the weekly freshness counter. Boundary: a dossier verified
 * EXACTLY DOSSIER_STALE_DAYS days ago is still fresh (the spec's wording is
 * "stale (>90d)", so day 90 itself is not stale). An unparseable stamp counts
 * as never-verified — an honest bucket, never silently fresh (F8). */
export function dossierFreshnessFromRows(
  rows: Array<{ lastVerifiedAt: Date | string | null }>,
  totalClients: number,
  now: Date,
): DossierFreshnessCounts {
  let verified = 0;
  let stale = 0;
  let neverVerified = 0;
  for (const r of rows) {
    if (!r.lastVerifiedAt) {
      neverVerified += 1;
      continue;
    }
    const ageDays = (now.getTime() - new Date(r.lastVerifiedAt).getTime()) / 86_400_000;
    if (!Number.isFinite(ageDays)) {
      neverVerified += 1;
    } else if (ageDays > DOSSIER_STALE_DAYS) {
      stale += 1;
    } else {
      verified += 1;
    }
  }
  return { clients: Math.max(totalClients, rows.length), verified, stale, neverVerified };
}

/** §E weekly run: "dossier freshness check" + "stale-dossier counter". A
 * read-only count — the gsc-sync run metrics surface it, and the editor's
 * last_verified_at stamp (dossier-actions) is what moves it. */
export async function runDossierFreshnessCheck(
  now: Date = new Date(),
): Promise<DossierFreshnessCounts> {
  const rows = await db
    .select({ lastVerifiedAt: clientSeoDossiers.lastVerifiedAt })
    .from(clientSeoDossiers);
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clientsTable);
  return dossierFreshnessFromRows(rows, Number(countRow?.n ?? 0) || 0, now);
}