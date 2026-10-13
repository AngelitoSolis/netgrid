// S1 — Page-2 goldmine rescue loop (the crown jewel of the SEO-loop build).
// The article's highest-ROI tactic productized end-to-end with a proof layer:
//   detect → generate (at detection time) → apply (deterministic, zero LLM)
//   → verify live → outcome at day ≥28 → "Queries that moved" in the monthly PDF.
//
// Ground rules honoured here (see docs/mega-prompt-compact.md):
//   F1  Auto-apply ONLY when the GSC page URL resolves to a post WE published
//       (generated_posts.external_post_url match). Anything else becomes a
//       recommendation issue with copy-paste-ready text — never guessed.
//   F3  Generated meta traces to the S6 dossier block or the page itself; gaps
//       stay gaps ("not provided — do not invent").
//   F4  One ledger: every finding lands in seo_issues WITH a stable issue_key
//       ('page2:<normQuery>'); upsert via the partial unique index (migration
//       0056) so daily runs never re-detect and higher-status rows are never
//       touched.
//   F5  GSC reads use search_performance with the impressions-weighted position
//       rule and gsc-pool's named floors/windows — one aggregation rule network-wide.
//   F7  LLM calls capped per run (RESCUE_MAX_GENERATED_PER_RUN, env-tunable).
//   F8  The outcome loop writes a delta ONLY when both measurements exist;
//       "no measurable signal yet" is a valid state.

import { db } from "@/lib/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { generatedPosts, seoIssues, seoScans } from "@/lib/db/schema";
import { gscToday, shiftDate } from "./gsc-sync";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";
import {
  MIN_IMPRESSIONS_90D,
  RESCUE_POS_MAX,
  RESCUE_POS_MIN,
  RESCUE_WINDOW_DAYS,
} from "@/lib/content/gsc-pool";
import { buildDossierContextBlock, getDossierForClient } from "./client-dossier";
import { generateRescueMeta } from "./claude-client";

// ── Per-run budgets (F7: capped + env-tunable, client-keywords.ts pattern) ───

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** LLM proposals generated per shard run — the money cap of this loop. */
export const RESCUE_MAX_GENERATED_PER_RUN = envInt("RESCUE_MAX_GENERATED_PER_RUN", 5);
/** Applies per blog per run (each apply is a live site write). */
export const RESCUE_MAX_APPLIED_PER_BLOG = envInt("RESCUE_MAX_APPLIED_PER_BLOG", 3);
/** Applies network-wide per shard run — the outer safety net. */
export const RESCUE_MAX_APPLIED_NETWORK = envInt("RESCUE_MAX_APPLIED_NETWORK", 15);

// ── Types ────────────────────────────────────────────────────────────────────

/** One detected (query, page) pair sitting on page two with real volume. */
export interface RescueFinding {
  /** The blog this page belongs to — search_performance rows are per-blog, and seo_issues needs it. */
  blogId: string;
  query: string;
  /** The full URL exactly as Search Console stored it — possibly uncanonicalized. */
  page: string;
  impressions90d: number;
  clicks90d: number;
  /** Impressions-weighted average position over the window (8–20.4 by detection). */
  avgPosition: number;
  /** F1 boundary: true only when our generated_posts table proves we own this URL. */
  managed: boolean;
  /** Canonical stored URL when managed (what findPostByUrl must resolve); null otherwise. */
  canonicalUrl: string | null;
  postId: string | null;
  severity: "critical" | "warning";
}

/** fixPayload shape for every page-2 rescue issue (S1 apply branch reads this). */
export interface RescueFixPayload {
  kind: "query_rescue";
  targetQuery: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  windowDays: number;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Stable issue identity — the normalized query, namespaced to this detector. */
export function rescueIssueKey(query: string): string {
  return `page2:${normalizeQueryKey(query)}`;
}

/** One decimal place for rendered positions — stable string, no float noise. */
function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Title convention from the brief (one pattern operators can grep for). */
export function rescueIssueTitle(
  query: string,
  avgPosition: number,
  impressions90d: number,
): string {
  return `Page-2 rescue: "${query}" (${round1(avgPosition)} avg, ${impressions90d} imp/90d)`;
}

/** Top-3 pairs by impressions are 'critical' — the rest 'warning' (brief D.1). */
export function rescueSeverity(rankByImpressions: number): "critical" | "warning" {
  return rankByImpressions < 3 ? "critical" : "warning";
}

/**
 * URL normalization for the F1 managed check ONLY (never for display): same
 * origin+pathname, trailing slash trimmed. GSC strings carry UTM/tracking noise
 * that generated_posts never has; comparing raw strings would false-negative
 * on the first ?utm_source= and leave a real rescue as "unmanaged".
 * Non-URL input falls back to its trimmed self (a relative path can still match).
 */
export function normalizeForMatch(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    let p = u.pathname.replace(/\/+$/, "");
    // "/index.html" and "/" are the same page to every CMS we publish through.
    if (p === "/index.html") p = "";
    return `${u.host.toLowerCase()}${p}`;
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/** Outcome verdict for the proof layer — pure so its boundaries are testable. */
export interface RescueOutcomeVerdict {
  afterPosition: number | null;
  afterImpressions: number | null;
  /** Positive = improved (moved UP the SERP). */
  deltaPositions: number | null;
  /** Improved, or within one position of the before — "stable" per the brief. */
  resolved: boolean;
}

/**
 * The honest-skip rule (F8): a verdict exists ONLY when both measurements are
 * present. delta ≥ -1 counts as improved-or-stable ("same page, same fold" is
 * not a failure); anything worse stays open for the next cycle — no fabricated
 * ROI on thin data.
 */
export function computeRescueOutcome(
  beforePosition: number | null,
  afterPosition: number | null,
  afterImpressions: number | null,
): RescueOutcomeVerdict {
  if (beforePosition === null || !Number.isFinite(afterPosition) || afterPosition === null) {
    return {
      afterPosition: Number.isFinite(afterPosition as number) ? (afterPosition as number) : null,
      afterImpressions,
      deltaPositions: null, // no measurable signal yet — a valid state, not an error
      resolved: false,
    };
  }
  const delta = beforePosition - (afterPosition as number);
  return {
    afterPosition: afterPosition as number,
    afterImpressions,
    deltaPositions: Math.round(delta * 10) / 10,
    resolved: delta >= -1, // improved-or-stable (documented boundary)
  };
}

/** pageUrl stored on the issue row — canonical when we own it, GSC string otherwise. */
export function rescueIssuePageUrl(f: RescueFinding): string {
  return f.managed && f.canonicalUrl ? f.canonicalUrl : f.page;
}

/**
 * The detector (step 1 of D.1), scoped to ONE blog — seo_scans.blog_id is NOT
 * NULL, so each run owns exactly one scan row ("one scans row per run"). Raw SQL
 * against the real column names with the impressions-weighted position rule —
 * one aggregation rule network-wide (F5); floors and window imported from
 * gsc-pool so every consumer moves together when they change. Returns pairs
 * best-first by 90d impressions; empty on any failure (a detector error must not
 * kill a shard run).
 */
export async function detectPage2Rescues(blogId: string): Promise<RescueFinding[]> {
  const today = gscToday();
  try {
    interface PairRow {
      query: string;
      page: string;
      impressions_90d: number | string;
      clicks_90d: number | string;
      avg_position: number | string;
    }
    const rows = (await db.execute(sql`
      SELECT query, page,
             SUM(impressions)::int AS impressions_90d,
             COALESCE(SUM(clicks), 0)::int AS clicks_90d,
             SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS avg_position
      FROM search_performance
      WHERE blog_id = ${blogId}
        AND date >= ${shiftDate(today, -RESCUE_WINDOW_DAYS)}
        AND date <= ${today}
        AND impressions > 0
      GROUP BY query, page
      HAVING SUM(impressions) >= ${MIN_IMPRESSIONS_90D}
         AND SUM(position * impressions) / NULLIF(SUM(impressions), 0)
             BETWEEN ${RESCUE_POS_MIN} AND ${RESCUE_POS_MAX}
      ORDER BY impressions_90d DESC
      LIMIT 50
    `)) as unknown as PairRow[];

    if (!rows.length) return [];

    // F1 boundary: auto-fixable ONLY when the URL resolves to a post WE
    // published. One read of this client's posts, matched on normalized
    // origin+pathname (GSC strings carry tracking params our stored URLs never have).
    const posts = await db
      .select({
        id: generatedPosts.id,
        externalPostUrl: generatedPosts.externalPostUrl,
      })
      .from(generatedPosts)
      .where(eq(generatedPosts.blogId, blogId));

    const byNormalizedUrl = new Map<string, { postId: string; url: string }>();
    for (const p of posts) {
      if (!p.externalPostUrl) continue;
      const key = normalizeForMatch(p.externalPostUrl);
      if (key && !byNormalizedUrl.has(key)) byNormalizedUrl.set(key, { postId: p.id, url: p.externalPostUrl });
    }

    return rows.map((row, rank): RescueFinding => {
      const gscPage = String(row.page ?? "").trim();
      const key = normalizeForMatch(gscPage);
      const match = key ? byNormalizedUrl.get(key) : undefined;
      return {
        blogId,
        query: String(row.query ?? "").trim(),
        page: gscPage,
        impressions90d: Number(row.impressions_90d) || 0,
        clicks90d: Number(row.clicks_90d) || 0,
        avgPosition: Math.round((Number(row.avg_position) || 0) * 100) / 100,
        managed: Boolean(match),
        canonicalUrl: match ? match.url : null,
        postId: match ? match.postId : null,
        severity: rescueSeverity(rank), // rows are already impressions-desc (SQL ORDER BY)
      };
    }).filter((f) => f.query && f.page);
  } catch (err) {
    console.warn(
      `[page2-rescue] detection failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Generate a proposal for one finding at DETECTION time so the apply step is
 * later fully deterministic (zero LLM calls — spec D.1 step 2). The S6 dossier
 * block is the single facts source (F3); gaps stay gaps. Returns null on any
 * failure: the issue still opens with a null proposal, and the apply branch
 * retries generation once before failing the row honestly.
 */
export async function generateProposalForFinding(
  f: RescueFinding,
  dossierBlock: string,
  niche: string | null,
): Promise<{ proposedTitle: string; proposedDescription: string } | null> {
  try {
    const meta = await generateRescueMeta({
      query: f.query,
      avgPosition: f.avgPosition,
      impressions90d: f.impressions90d,
      // Live head is read at APPLY time (verifyLiveMeta) — no WP call here.
      currentTitle: null,
      currentDescription: null,
      pageExcerpt: "",
      niche: niche ?? "not provided",
      dossierContext:
        dossierBlock ||
        "(no dossier on file for this client — rely only on the query itself and do not invent facts)",
    });
    if (meta.title && meta.description) {
      return { proposedTitle: meta.title, proposedDescription: meta.description };
    }
    return null; // generateRescueMeta already logged RESCUE_META_PARSE_FAILED
  } catch (err) {
    console.warn(
      `[page2-rescue] proposal generation failed for "${f.query}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Create this run's seo_scans row. scanId on seo_issues is NOT NULL with
 * cascade, so every detector pass owns exactly one scans row; scores are 0 by
 * design for non-hygiene passes (compact spec: "score ints 0, real metadata in
 * rawData jsonb") and rawData.kind = 'page2_rescue' stamps the identity the
 * seo-scan purge uses to leave these rows alone.
 */
async function createRescueScanRow(
  blogId: string,
  clientId: string,
  issuesFound: number,
  criticalIssues: number,
): Promise<string> {
  const [scan] = await db
    .insert(seoScans)
    .values({
      blogId,
      clientId,
      overallScore: 0,
      metaScore: 0,
      contentScore: 0,
      technicalScore: 0,
      linkScore: 0,
      imageScore: 0,
      pagesCrawled: 0,
      issuesFound,
      criticalIssues,
      warnings: issuesFound - criticalIssues,
      notices: 0,
      rawData: { kind: "page2_rescue" },
    })
    .returning({ id: seoScans.id });
  return scan.id;
}

/**
 * Open one finding in the shared ledger (F4). The caller has ALREADY verified
 * no row exists for this (blogId, pageUrl, issueKey) triple — that check is the
 * upsert guard itself, because this detector is the only writer of 'page2:'
 * keys. New rows land 'queued' when we own the page (auto-apply eligible via the
 * shared pipeline) or 'detected' as an operator recommendation otherwise (F1).
 */
async function persistRescueFinding(
  f: RescueFinding,
  clientId: string,
  scanId: string,
  proposal: { proposedTitle: string; proposedDescription: string } | null,
): Promise<void> {
  const payload: RescueFixPayload = {
    kind: "query_rescue",
    targetQuery: f.query,
    proposedTitle: proposal?.proposedTitle ?? null,
    proposedDescription: proposal?.proposedDescription ?? null,
    windowDays: RESCUE_WINDOW_DAYS,
  };

  await db.insert(seoIssues).values({
    scanId,
    blogId: f.blogId,
    clientId,
    pageUrl: rescueIssuePageUrl(f),
    category: "meta",
    severity: f.severity,
    title: rescueIssueTitle(f.query, f.avgPosition, f.impressions90d).slice(0, 500),
    description:
      `"${f.query}" ranks at ${round1(f.avgPosition)} average position with ${f.impressions90d} ` +
      `impressions (and ${f.clicks90d} clicks) in the last ${RESCUE_WINDOW_DAYS} days — a page-2 goldmine. ` +
      (f.managed
        ? "Managed post: meta title + description rewrite generated from the client dossier; auto-applied and live-verified."
        : "This page is not managed by this system — recommended meta below, copy-paste ready."),
    suggestedFix: proposal
      ? `Title: ${proposal.proposedTitle}\nDescription: ${proposal.proposedDescription}`
      : null,
    fixPayload: payload,
    status: f.managed ? "queued" : "detected",
    // Managed rows are auto-fixable even with a null proposal — the apply branch
    // retries generation once before failing honestly (spec D.1 step 4).
    autoFixable: f.managed,
    issueKey: rescueIssueKey(f.query),
    // BEFORE measurement — the proof layer (F8). S1-verify writes .outcome into
    // this object once day >= 28 re-measurement is possible.
    preSnapshot: {
      query: f.query,
      avgPositionBefore: f.avgPosition,
      impressions90dBefore: f.impressions90d,
      clicks90dBefore: f.clicks90d,
      windowDays: RESCUE_WINDOW_DAYS,
      detectedAt: new Date().toISOString(),
    },
  });
}

export interface Page2RescueMetrics {
  detected: number;
  opened: number;
  skippedExisting: number; // upsert guard hit — never re-detected (F4)
  generated: number; // LLM proposals attempted this run (F7 budget accounting)
  applyEligible: number; // managed + queued with a proposal, awaiting the shared pipeline
}

/** The cron passes one GSC-connected blog at a time (shard-safe). */
export interface Page2RescueBlogInput {
  id: string;
  clientId: string;
}

/**
 * The per-blog S1 pass — called from the GSC cron for each connected blog.
 * detect → upsert guard → generate at detection time (budget-capped, best-first)
 * → open in the ledger under one seo_scans row. APPLY happens through the
 * EXISTING queued-issue pipeline (seo-autofix's query_rescue branch), exactly
 * how every other issue type ships today; carry-over rows from a budget-
 * exhausted day are picked up automatically on later runs — that is what the
 * queue is for, and it keeps this function free of any live-site writes.
 */
export async function runPage2RescueForBlog(
  blog: Page2RescueBlogInput,
): Promise<Page2RescueMetrics> {
  const metrics: Page2RescueMetrics = {
    detected: 0,
    opened: 0,
    skippedExisting: 0,
    generated: 0,
    applyEligible: 0,
  };

  const findings = await detectPage2Rescues(blog.id);
  metrics.detected = findings.length;
  if (!findings.length) return metrics; // nothing on page two — no writes at all

  // Upsert guard in ONE query (F4): any row already holding this triple — in ANY
  // status, applied included — wins. The unique index covers every keyed row, so
  // a second insert would throw; the guard is what makes daily runs idempotent.
  const existingRows = await db
    .select({ issueKey: seoIssues.issueKey, pageUrl: seoIssues.pageUrl })
    .from(seoIssues)
    .where(and(eq(seoIssues.blogId, blog.id), sql`${seoIssues.issueKey} LIKE 'page2:%'`));
  const existing = new Set(
    existingRows.map((r) => `${r.issueKey}\u0000${normalizeForMatch(r.pageUrl ?? "")}`),
  );

  // Findings arrive impressions-desc, so this filter preserves best-first order.
  const toOpen = findings.filter((f) => {
    const hit = existing.has(`${rescueIssueKey(f.query)}\u0000${normalizeForMatch(rescueIssuePageUrl(f))}`);
    if (hit) metrics.skippedExisting += 1;
    return !hit;
  });
  if (!toOpen.length) return metrics; // everything already in the ledger

  const scanId = await createRescueScanRow(
    blog.id,
    blog.clientId,
    toOpen.length,
    toOpen.filter((f) => f.severity === "critical").length,
  );

  // S6 dossier fetched ONCE per run — the single facts source (F3). A failure
  // degrades to "no dossier" text in the prompt; it never crashes a shard.
  const clientDossier = await getDossierForClient(blog.clientId).catch(() => null);
  let dossierBlock = "";
  if (clientDossier) {
    try {
      dossierBlock = buildDossierContextBlock(clientDossier);
    } catch {
      dossierBlock = "";
    }
  }

  // F7 generation budget, stateless + shard-safe: proposals this client already
  // opened TODAY. Carry-over queued rows keep their proposal without consuming
  // today's budget (they were counted on the day they generated).
  const [{ generatedToday }] = await db
    .select({ generatedToday: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(
      and(
        eq(seoIssues.clientId, blog.clientId),
        // S2's pin family generates with the SAME prompt — one client-day cap on
        // LLM meta spend across both families (F7). The hygiene pass counts the
        // identical set, so neither pass can double-spend.
        sql`(issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')`,
        sql`${seoIssues.fixPayload}->>'proposedTitle' IS NOT NULL`,
        gte(seoIssues.detectedAt, sql`${gscToday()}::timestamp`),
      ),
    );

  for (const f of toOpen) {
    let proposal: { proposedTitle: string; proposedDescription: string } | null = null;
    if (generatedToday + metrics.generated < RESCUE_MAX_GENERATED_PER_RUN) {
      metrics.generated += 1; // an attempt counts even when it fails
      proposal = await generateProposalForFinding(f, dossierBlock, null);
    }
    await persistRescueFinding(f, blog.clientId, scanId, proposal);
    metrics.opened += 1;
    if (f.managed && proposal) metrics.applyEligible += 1;
  }

  console.log(
    `[page2-rescue] blog ${blog.id}: detected=${metrics.detected} opened=${metrics.opened} ` +
      `skipped=${metrics.skippedExisting} generated=${metrics.generated} applyEligible=${metrics.applyEligible}`,
  );
  return metrics;
}

/**
 * F7 APPLY budget, stateless and shard-safe: counts rows actually APPLIED today
 * (status flipped with applied_at stamped) rather than in-flight queue depth —
 * queued carry-over is free, only live-site writes cost budget. Called by the
 * seo-autofix rescue branch before any WP write; a row that misses its budget
 * stays 'queued' and the next run's drain picks it up.
 */
export async function rescueApplyBudgetLeft(
  blogId: string,
): Promise<{ networkLeft: number; blogLeft: number }> {
  const today = gscToday();
  // page2:% AND pin:% — S2's pins are live-site writes too, so they consume the
  // same stateless apply budgets (one cap on meta writes per client/blog/day).
  const [net] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM seo_issues
    WHERE issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%'
      AND status IN ('applied', 'verified')
      AND applied_at >= ${today}::timestamp
  `)) as unknown as Array<{ n: number | string }>;
  const [perBlog] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM seo_issues
    WHERE blog_id = ${blogId}
      AND (issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')
      AND status IN ('applied', 'verified')
      AND applied_at >= ${today}::timestamp
  `)) as unknown as Array<{ n: number | string }>;
  return {
    networkLeft: Math.max(0, RESCUE_MAX_APPLIED_NETWORK - Number(net?.n ?? 0)),
    blogLeft: Math.max(0, RESCUE_MAX_APPLIED_PER_BLOG - Number(perBlog?.n ?? 0)),
  };
}

/** Re-measurement gate: at least this many days after apply (brief: day ≥ 28). */
export const RESCUE_OUTCOME_MIN_DAYS = envInt("RESCUE_OUTCOME_MIN_DAYS", 28);

interface AppliedRescueRow {
  id: string;
  blogId: string;
  pageUrl: string | null;
  fixPayload: unknown;
  preSnapshot: Record<string, unknown> | null;
}

/**
 * The proof layer (F8) — daily re-measurement of applied rescues. For each row
 * applied at least RESCUE_OUTCOME_MIN_DAYS ago that has no outcome yet, GSC's
 * OWN data is queried for the target query on that page over the trailing named
 * window (one aggregation rule network-wide), and preSnapshot.outcome is written
 * with the delta. computeRescueOutcome's honest-skip rule applies: missing
 * BEFORE or AFTER → null delta → the row simply waits for the next run; "no
 * measurable signal yet" is a valid state, never an error, and never a delta.
 */
export async function runPage2RescueOutcomes(
  clientId: string,
): Promise<{ measured: number; resolved: number }> {
  const today = gscToday();
  const earliestApply = shiftDate(today, -RESCUE_OUTCOME_MIN_DAYS);

  const rows = (await db.execute(sql`
    SELECT id,
           blog_id AS "blogId",
           page_url AS "pageUrl",
           fix_payload AS "fixPayload",
           pre_snapshot AS "preSnapshot"
    FROM seo_issues
    WHERE client_id = ${clientId}
      -- page2:% AND pin:% — S2's pins carry the same query_rescue payload and
      -- preSnapshot shape, so they prove themselves through the SAME loop.
      AND (issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')
      AND status IN ('applied', 'verified')
      AND applied_at <= ${earliestApply}::timestamp
      AND (pre_snapshot IS NULL OR pre_snapshot->'outcome' IS NULL)
  `)) as unknown as AppliedRescueRow[];

  let measured = 0;
  let resolved = 0;

  for (const row of rows) {
    try {
      const payload = (row.fixPayload ?? {}) as Partial<RescueFixPayload>;
      if (!payload.targetQuery || !row.pageUrl) continue; // nothing to re-measure against

      interface AfterRow {
        avg_position: number | string | null;
        impressions_window: number | string;
      }
      const [after] = (await db.execute(sql`
        SELECT SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS avg_position,
               COALESCE(SUM(impressions), 0)::int AS "impressions_window"
        FROM search_performance
        WHERE blog_id = ${row.blogId}
          AND page = ${row.pageUrl}
          AND query = ${payload.targetQuery}
          AND date >= ${shiftDate(today, -RESCUE_WINDOW_DAYS)}
          AND date <= ${today}
      `)) as unknown as AfterRow[];

      const beforeRaw = row.preSnapshot?.avgPositionBefore;
      const beforePosition = typeof beforeRaw === "number" ? beforeRaw : null;
      const afterPosition =
        after && after.avg_position !== null && after.avg_position !== undefined
          ? Math.round((Number(after.avg_position) || 0) * 100) / 100
          : null; // query fell out of the trailing window — thin data, not a failure

      const verdict = computeRescueOutcome(
        beforePosition,
        afterPosition,
        after ? Number(after.impressions_window) || 0 : null,
      );
      if (verdict.deltaPositions === null) continue; // honest skip — retry on a later run

      const merged: Record<string, unknown> = {
        ...(row.preSnapshot ?? {}),
        outcome: {
          afterPosition: verdict.afterPosition,
          deltaPositions: verdict.deltaPositions,
          resolved: verdict.resolved,
          targetQuery: payload.targetQuery,
          measuredAt: new Date().toISOString(),
        },
      };
      const update: Record<string, unknown> = { preSnapshot: merged };
      if (verdict.resolved) update.resolvedAt = new Date();
      await db.update(seoIssues).set(update as never).where(eq(seoIssues.id, row.id));

      measured += 1;
      if (verdict.resolved) resolved += 1;
    } catch (err) {
      // One bad row must not stop the rest of the client's outcomes.
      console.warn(
        `[page2-rescue] outcome measurement failed for issue ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (measured > 0) {
    console.log(`[page2-rescue] outcomes client ${clientId}: measured=${measured} resolved=${resolved}`);
  }
  return { measured, resolved };
}

// ── Outcome reads — the proof layer made surfaceable ─────────────────────────
// One source for every consumer of rescued-query results: the portal card
// ("N queries rescued this month"), the v1 rescues?since= cursor endpoint and
// the monthly PDF's "Queries that moved" section all read THESE rows, so a
// delta can never appear anywhere without both measurements being present (F8).

export interface RescueOutcomeRow {
  issueId: string;
  /** 'rescue' = S1 page-2 family, 'pin' = S2 accidental-ranker family. */
  family: "rescue" | "pin";
  query: string;
  pageUrl: string | null;
  domain: string | null;
  beforePosition: number | null;
  afterPosition: number | null;
  /** Positive = moved up the SERP. Null is impossible here — a row without both
   * measurements has no outcome object and never appears in this list. */
  deltaPositions: number | null;
  resolved: boolean;
  appliedAt: string | null; // ISO
  measuredAt: string; // ISO — the cursor field for rescues?since=
}

export interface RescueOutcomeQueryOptions {
  /** Strict lower bound on outcome.measuredAt (cursor / "since" reads). */
  since?: Date;
  limit?: number; // default 200, hard cap 500
  onlyResolved?: boolean; // the PDF shows proven movement only
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Rescue + pin issues for one client whose outcome has been MEASURED (both
 * before and after present — the honest-skip rule upstream guarantees this).
 * Ordered by measuredAt asc so rescues?since= is a stable forward cursor.
 */
export async function listRescueOutcomes(
  clientId: string,
  opts: RescueOutcomeQueryOptions = {},
): Promise<RescueOutcomeRow[]> {
  const sinceIso = opts.since ? new Date(opts.since).toISOString() : null;
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 200)));

  interface RawOutcomeRow {
    issueId: string;
    issueKey: string | null;
    pageUrl: string | null;
    appliedAt: unknown;
    fixPayload: Record<string, unknown> | null;
    preSnapshot: Record<string, unknown> | null;
    domain: string | null;
  }

  const rows = (await db.execute(sql`
    SELECT i.id AS "issueId",
           i.issue_key AS issueKey,
           i.page_url AS pageUrl,
           i.applied_at AS appliedAt,
           i.fix_payload AS fixPayload,
           i.pre_snapshot AS preSnapshot,
           b.domain AS domain
    FROM seo_issues i
    LEFT JOIN blogs b ON b.id = i.blog_id
    WHERE i.client_id = ${clientId}
      AND (i.issue_key LIKE 'page2:%' OR i.issue_key LIKE 'pin:%')
      AND i.pre_snapshot->'outcome' IS NOT NULL
      ${sinceIso ? sql`AND (i.pre_snapshot->'outcome'->>'measuredAt')::timestamptz > ${new Date(sinceIso)}` : sql``}
      ${opts.onlyResolved ? sql`AND (i.pre_snapshot->'outcome'->>'resolved') = 'true'` : sql``}
    ORDER BY (i.pre_snapshot->'outcome'->>'measuredAt')::timestamptz ASC, i.id ASC
    LIMIT ${limit}
  `)) as unknown as RawOutcomeRow[];

  return rows.map((r) => {
    const outcome = (r.preSnapshot?.outcome ?? null) as {
      afterPosition?: number | null;
      deltaPositions?: number | null;
      resolved?: boolean;
      measuredAt?: string;
    } | null;
    const beforeRaw = r.preSnapshot?.avgPositionBefore;
    return {
      issueId: r.issueId,
      family: String(r.issueKey ?? "").startsWith("pin:") ? "pin" : "rescue",
      query: typeof r.fixPayload?.targetQuery === "string" ? (r.fixPayload.targetQuery as string) : "",
      pageUrl: r.pageUrl,
      domain: r.domain,
      beforePosition: typeof beforeRaw === "number" ? beforeRaw : null,
      afterPosition: outcome?.afterPosition ?? null,
      deltaPositions: outcome?.deltaPositions ?? null,
      resolved: Boolean(outcome?.resolved),
      appliedAt: isoOrNull(r.appliedAt),
      measuredAt: outcome?.measuredAt ?? "",
    };
  });
}

/** Portal card math — "Search improvements this month": how many of the client's
 * rescues/pins MEASURED as resolved-or-stable since `sinceIso`, and their average
 * position delta. Zero rows → null avg (the card shows an honest dash). */
export async function rescueOutcomeSummaryForClient(
  clientId: string,
  sinceIso: string,
): Promise<{ rescuedCount: number; avgDeltaPositions: number | null }> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n,
           round(avg((pre_snapshot->'outcome'->>'deltaPositions')::numeric), 1)::float8 AS "avgDelta"
    FROM seo_issues
    WHERE client_id = ${clientId}
      AND (issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')
      AND pre_snapshot->'outcome' IS NOT NULL
      AND (pre_snapshot->'outcome'->>'resolved') = 'true'
      AND (pre_snapshot->'outcome'->>'measuredAt')::timestamptz >= ${new Date(sinceIso)}
  `)) as unknown as Array<{ n: number | string; avgDelta: number | string | null }>;

  const rescuedCount = Number(row?.n ?? 0);
  const rawAvg = row ? Number(row.avgDelta) : NaN;
  return {
    rescuedCount,
    avgDeltaPositions: rescuedCount > 0 && Number.isFinite(rawAvg) ? Math.round(rawAvg * 10) / 10 : null,
  };
}
