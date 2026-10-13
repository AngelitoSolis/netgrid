// The 30-day sprint engine (S7 of the SEO-loop build) — "week-by-week plans
// FROM live data", not a wall post.
//
// One plan per client per month: for each week W1–W4 up to 5 concrete items,
// each tagged with its machine hook so the operator can see WHAT will do it:
//   rescue:<issueId>         — auto-safe page-2/pin fix (S1 apply pipeline)
//   review-item:<issueId>    — human decision (S2/S8 approve/dismiss on /review)
//   location-page:<targetId> — the drip will build it (shared target claimer)
//   manual:<note>            — GBP/operator work, from the dossier's honest gaps
//
// DETERMINISM IS THE CONTRACT. Item selection order is fully specified below
// and ties always break on a stored string key, so re-running mid-month
// produces the same item set (idempotent on period) and two operators reading
// the plan see the same machine output. No Date.now() inside the pure core —
// the caller injects `now` so tests are byte-stable.
//
// GLOBAL RANK ORDER (documented comparator, S0-b style):
//   1. rescues      by pre-snapshot impressions90dBefore DESC NULLS LAST, then
//                   issue_key ASC — highest-impressions open rescues first
//   2. review items by severity (critical < warning < notice), then family
//                   order folded → split → dead, then issue_id ASC
//   3. location gaps by priority ASC NULLS LAST, then keyword ASC, id ASC
//   4. manual notes in dossier order, capped at MANUAL_ITEM_CAP
// The concatenated list is chunked into weeks of SPRINT_ITEMS_PER_WEEK (W1 gets
// ranks 0–4, W2 ranks 5–9, ...). Weeks past the candidate pool are empty — an
// honest plan, never padded with invented work (F8).
//
// ZERO-SIGNAL FALLBACK: when every candidate family is empty the plan carries
// fallback=true and a reason. A client with no live data gets "not enough live
// data — operator plan", never fabricated items.
//
// STORAGE: the plan is persisted as a report-period artifact inside
// reports.raw_data.sprint (spec S7) so it survives re-renders; the PDF section
// reads the STORED artifact, not a live recomputation. Manual items have no
// machine state — their completion lives in plan.overrides.manualDone.

import { db } from "@/lib/db";
import { asc, eq, and, inArray, sql } from "drizzle-orm";
import { blogKeywordTargets, clients, locationPageTargets, reports, seoIssues } from "@/lib/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SprintFamily = "rescue" | "review-item" | "location-page" | "manual";
export type SprintOwner = "netgrid_auto" | "operator";

/** One concrete action in the plan. `id` is stable across rebuilds for the
 * same period (it derives from the source row's identity), which is what makes
 * mid-month re-runs idempotent and completion ticks durable. */
export interface SprintItem {
  id: string;
  family: SprintFamily;
  /** The machine hook — `rescue:<issueId>` / `review-item:<issueId>` /
   * `location-page:<targetId>` / `manual:<note>`. */
  hook: string;
  /** Human-readable line, built from real stored data only (F3). */
  title: string;
  owner: SprintOwner;
}

export interface SprintWeek {
  week: number; // 1..4
  items: SprintItem[]; // ≤ SPRINT_ITEMS_PER_WEEK
}

/** The persisted plan artifact. Serialized into reports.raw_data.sprint. */
export interface MonthlySprintPlan {
  version: 1;
  clientId: string;
  /** YYYY-MM — the month this plan targets (the one being executed). */
  period: string;
  generatedAt: string; // ISO timestamp of when this artifact was written
  fallback: boolean;
  fallbackReason?: string;
  /** Explicit W2 constraint note (spec S7): printed in every surface so the
   * plan never promises body edits the apply pipeline cannot make yet. */
  contentDepthNote: string;
  weeks: SprintWeek[]; // always exactly 4 entries (some may be empty)
  /** Operator completion ticks for manual items (they have no machine state).
   * Carried across rebuilds of the same period. */
  overrides?: { manualDone: string[] };
}

/** A plan item enriched with its live completion state (admin/portal views). */
export interface SprintItemStatus extends SprintItem {
  done: boolean;
  /** Machine status string when one exists ("applied", "generated", ...). */
  machineStatus?: string | null;
}

export interface SprintProgress {
  plan: MonthlySprintPlan;
  items: SprintItemStatus[]; // flat, week order preserved
  doneCount: number;
  totalCount: number;
}

// ─── Constants (named per F10 — no magic numbers) ─────────────────────────────

/** Hard cap on items per week (spec: "≤5 concrete items"). */
export const SPRINT_ITEMS_PER_WEEK = 5;
/** Manual items come from the dossier's gaps list — two max keeps W4 honest. */
const MANUAL_ITEM_CAP = 2;
/** Per-family candidate caps before weekly chunking. Generous on purpose: a
 * plan can hold 4×5=20 slots, and the global rank order decides who makes it. */
const RESCUE_CANDIDATE_CAP = 8;
const REVIEW_CANDIDATE_CAP = 6;
const LOCATION_FETCH_CAP = 200;

/** Explicit W2 constraint (spec S7): T23's body-edit path is merged upstream,
 * but this pipeline's apply branch still only writes meta + FAQ JSON-LD. The
 * plan says so instead of promising edits it cannot make. */
export const CONTENT_DEPTH_NOTE =
  "Week-2 content-depth note: the in-body edit path is not live yet — slots carry meta title/description + FAQ JSON-LD items only, never promised body rewrites.";

/** Issue statuses that count as "the action was taken or closed" for ticks. */
const RESOLVED_ISSUE_STATUSES = ["applied", "verified", "resolved", "dismissed"];
/** Ledger target statuses that mean the drip already did its job. */
const DONE_TARGET_STATUSES = ["generated", "skipped"];

// ─── Pure core (no DB, no clock — fully testable) ──────────────────────────────

export interface RescueCandidate {
  issueId: string;
  /** Normalized query (issue_key minus the family prefix). */
  query: string;
  pageUrl: string | null;
  impressions90dBefore: number | null;
}

export interface ReviewIssueCandidate {
  issueId: string;
  familyKey: "folded" | "split" | "dead";
  severity: "critical" | "warning" | "notice";
  title: string;
  pageUrl: string | null;
}

export interface LocationGapCandidate {
  targetId: string;
  keyword: string;
  city: string | null;
  priority: number | null;
}

/** Everything assembleSprintPlan needs. The DB layer (buildMonthlySprint) is
 * the only producer today; tests feed fixtures directly. */
export interface SprintInputs {
  clientId: string;
  /** Injectable clock — keeps output byte-stable for a fixed input set. */
  now?: Date;
  openRescues: RescueCandidate[];
  reviewItems: ReviewIssueCandidate[];
  locationGaps: LocationGapCandidate[];
  /** Raw gap lines from the dossier (may be untrimmed/duplicated). */
  manualNotes: string[];
}

const SEVERITY_RANK: Record<ReviewIssueCandidate["severity"], number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};
/** Family tie-break inside review items (spec: "critical folded/split"). */
const REVIEW_FAMILY_ORDER: Record<ReviewIssueCandidate["familyKey"], number> = {
  folded: 0,
  split: 1,
  dead: 2,
};

/** YYYY-MM for the month `d` falls in — the plan period key. Exported so UIs
 * and tests share ONE definition of "this month". */
export function currentPeriodKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The calendar month BEFORE the one containing `d` (for last-month scores). */
export function priorPeriodKey(d: Date): string {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return currentPeriodKey(p);
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Stable id fragment for a manual note: lowercase alphanumerics + dashes. */
function slugify(note: string): string {
  const s = note
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "note";
}

/** Trim + case-insensitive dedupe of operator gap lines (dossier-actions
 * cleanList pattern — the stored row may carry duplicates). */
export function normalizeManualNotes(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 300));
  }
  return out;
}

/** Split a dossier gaps blob into lines the planner can use. */
export function splitGapLines(gaps: string | null): string[] {
  if (!gaps) return [];
  return gaps.split(/\r?\n/);
}

function toRescueItem(c: RescueCandidate): SprintItem {
  const imp = c.impressions90dBefore ?? null;
  return {
    id: `rescue:${c.issueId}`,
    family: "rescue",
    hook: `rescue:${c.issueId}`,
    title: truncate(
      `Fix meta for "${c.query}"${imp !== null ? ` (${imp} imp/90d)` : ""} — S1 auto-apply`,
      160,
    ),
    owner: "netgrid_auto",
  };
}

function toReviewItem(c: ReviewIssueCandidate): SprintItem {
  return {
    id: `review-item:${c.issueId}`,
    family: "review-item",
    hook: `review-item:${c.issueId}`,
    title: truncate(`${c.familyKey.toUpperCase()} — ${c.title || c.pageUrl || c.issueId}`, 160),
    owner: "operator",
  };
}

function toLocationItem(c: LocationGapCandidate): SprintItem {
  return {
    id: `location-page:${c.targetId}`,
    family: "location-page",
    hook: `location-page:${c.targetId}`,
    title: truncate(`Location page: "${c.keyword}"${c.city ? ` in ${c.city}` : ""} — drip builds it`, 160),
    owner: "netgrid_auto",
  };
}

function toManualItem(note: string, usedIds: Set<string>): SprintItem {
  let id = `manual:${slugify(note)}`;
  // Two different notes can slug-identically (rare); keep ids unique.
  for (let n = 2; usedIds.has(id); n++) id = `manual:${slugify(note)}-${n}`;
  usedIds.add(id);
  return {
    id,
    family: "manual",
    hook: `manual:${truncate(note, 120)}`,
    title: truncate(`Operator/GBP: ${note}`, 160),
    owner: "operator",
  };
}


/**
 * THE deterministic planner. Pure function of its inputs — same inputs give a
 * byte-identical plan (DoD). See the file header for the full comparator.
 */
export function assembleSprintPlan(inputs: SprintInputs): MonthlySprintPlan {
  const now = inputs.now ?? new Date();
  const period = currentPeriodKey(now);

  // Family-internal orders, per the documented comparator.
  const rescues = [...inputs.openRescues].sort((a, b) => {
    const ai = a.impressions90dBefore;
    const bi = b.impressions90dBefore;
    if (ai === null && bi === null) return a.issueId.localeCompare(b.issueId);
    if (ai === null) return 1; // NULLS LAST
    if (bi === null) return -1;
    if (bi !== ai) return bi - ai;
    return a.query.localeCompare(b.query);
  });

  const reviews = [...inputs.reviewItems].sort((a, b) => {
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity])
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (REVIEW_FAMILY_ORDER[a.familyKey] !== REVIEW_FAMILY_ORDER[b.familyKey])
      return REVIEW_FAMILY_ORDER[a.familyKey] - REVIEW_FAMILY_ORDER[b.familyKey];
    return a.issueId.localeCompare(b.issueId);
  });

  const locations = [...inputs.locationGaps].sort((a, b) => {
    if ((a.priority ?? null) !== (b.priority ?? null)) {
      if (a.priority === null) return 1; // NULLS LAST
      if (b.priority === null) return -1;
      if (a.priority !== b.priority) return a.priority - b.priority;
    }
    if (a.keyword !== b.keyword) return a.keyword.localeCompare(b.keyword);
    return a.targetId.localeCompare(b.targetId);
  });

  const manualNotes = normalizeManualNotes(inputs.manualNotes).slice(0, MANUAL_ITEM_CAP);

  // Zero-signal fallback — honest "operator plan", never fabricated items.
  if (rescues.length === 0 && reviews.length === 0 && locations.length === 0 && manualNotes.length === 0) {
    return {
      version: 1,
      clientId: inputs.clientId,
      period,
      generatedAt: now.toISOString(),
      fallback: true,
      fallbackReason:
        "Not enough live data — operator plan. No open rescues, no review issues and no pending location targets exist for this client yet.",
      contentDepthNote: CONTENT_DEPTH_NOTE,
      weeks: [1, 2, 3, 4].map((week) => ({ week, items: [] })),
    };
  }

  const usedIds = new Set<string>();
  const ordered: SprintItem[] = [
    ...rescues.map(toRescueItem),
    ...reviews.map(toReviewItem),
    ...locations.map(toLocationItem),
    ...manualNotes.map((n) => toManualItem(n, usedIds)),
  ];

  // Chunk the global rank into weeks of ≤5. Deterministic by construction;
  // candidates beyond 4×5 slots are dropped (the ledger keeps them for later).
  const weeks: SprintWeek[] = [1, 2, 3, 4].map((week) => ({
    week,
    items: ordered.slice((week - 1) * SPRINT_ITEMS_PER_WEEK, week * SPRINT_ITEMS_PER_WEEK),
  }));

  return {
    version: 1,
    clientId: inputs.clientId,
    period,
    generatedAt: now.toISOString(),
    fallback: false,
    contentDepthNote: CONTENT_DEPTH_NOTE,
    weeks,
  };
}

/** Flatten a plan's items in week order (views + progress share this). */
export function flattenPlanItems(plan: MonthlySprintPlan): SprintItem[] {
  return [...plan.weeks].sort((a, b) => a.week - b.week).flatMap((w) => w.items);
}


// ─── DB-backed build (every source fail-safe, S6 pattern) ──────────────────────

/** One open page-2/pin rescue row, straight from the shared ledger. */
interface RescueRow {
  id: string;
  issue_key: string | null;
  page_url: string | null;
  title: string | null;
  impressions_90d_before: number | string | null;
}

/** One open folded/split/dead review row. */
interface ReviewRow {
  id: string;
  issue_key: string | null;
  severity: "critical" | "warning" | "notice";
  page_url: string | null;
  title: string | null;
}

async function readOpenRescueCandidates(clientId: string): Promise<RescueCandidate[]> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.issue_key, i.page_url, i.title,
           (i.pre_snapshot->>'impressions90dBefore')::int AS impressions_90d_before
    FROM seo_issues i
    WHERE i.client_id = ${clientId}
      AND (i.issue_key LIKE 'page2:%' OR i.issue_key LIKE 'pin:%')
      AND i.status NOT IN ('applied', 'verified', 'resolved', 'dismissed')
    ORDER BY COALESCE((i.pre_snapshot->>'impressions90dBefore')::int, -1) DESC,
             i.issue_key ASC NULLS LAST
    LIMIT ${RESCUE_CANDIDATE_CAP}
  `)) as unknown as RescueRow[];
  return rows.map((r) => {
    const key = String(r.issue_key ?? "");
    const prefix = key.startsWith("pin:") ? "pin" : "page2";
    return {
      issueId: r.id,
      query: key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1) : key,
      pageUrl: r.page_url,
      impressions90dBefore:
        typeof r.impressions_90d_before === "number"
          ? r.impressions_90d_before
          : Number(r.impressions_90d_before) || null,
    };
  });
}

async function readReviewIssueCandidates(clientId: string): Promise<ReviewIssueCandidate[]> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.issue_key, i.severity, i.page_url, i.title
    FROM seo_issues i
    WHERE i.client_id = ${clientId}
      AND (i.issue_key LIKE 'folded:%' OR i.issue_key LIKE 'split:%' OR i.issue_key LIKE 'dead:%')
      AND i.status NOT IN ('applied', 'verified', 'resolved', 'dismissed')
    LIMIT ${REVIEW_CANDIDATE_CAP * 3}
  `)) as unknown as ReviewRow[];
  const out: ReviewIssueCandidate[] = [];
  for (const r of rows) {
    const key = String(r.issue_key ?? "");
    const familyKey = key.split(":")[0];
    if (familyKey !== "folded" && familyKey !== "split" && familyKey !== "dead") continue;
    out.push({
      issueId: r.id,
      familyKey,
      severity: (r.severity as ReviewIssueCandidate["severity"]) ?? "notice",
      title: String(r.title ?? "").slice(0, 300),
      pageUrl: r.page_url,
    });
  }
  return out;
}

/**
 * Location coverage gaps — the EXISTING targeted-page ledgers. S3 makes
 * location_page_targets authoritative when it exists (migration 0057); until a
 * given environment has applied it, blog_keyword_targets IS the local page
 * pipeline, so planning from it is real data, not invention (F3).
 */
async function readLocationGapCandidates(clientId: string): Promise<LocationGapCandidate[]> {
  try {
    const rows = await db
      .select({
        id: locationPageTargets.id,
        combinedQuery: locationPageTargets.combinedQuery,
        placeName: locationPageTargets.placeName,
        priority: locationPageTargets.priority,
      })
      .from(locationPageTargets)
      .where(and(eq(locationPageTargets.clientId, clientId), eq(locationPageTargets.status, "pending")))
      .orderBy(asc(locationPageTargets.id)) // deterministic fetch; real order is JS-side
      .limit(LOCATION_FETCH_CAP);
    if (rows.length > 0) {
      return rows.map((r) => ({
        targetId: r.id,
        keyword: String(r.combinedQuery ?? ""),
        city: r.placeName || null,
        priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || null,
      }));
    }
  } catch {
    // Table not present in this environment yet — fall through to the legacy ledger.
  }

  const rows = await db
    .select({
      id: blogKeywordTargets.id,
      keyword: blogKeywordTargets.keyword,
      city: blogKeywordTargets.city,
      priority: blogKeywordTargets.priority,
    })
    .from(blogKeywordTargets)
    .where(and(eq(blogKeywordTargets.clientId, clientId), eq(blogKeywordTargets.status, "pending")))
    .orderBy(asc(blogKeywordTargets.id)) // deterministic fetch; real order is JS-side
    .limit(LOCATION_FETCH_CAP);
  return rows.map((r) => ({
    targetId: r.id,
    keyword: String(r.keyword ?? ""),
    city: r.city || null,
    priority: typeof r.priority === "number" ? r.priority : Number(r.priority) || null,
  }));
}

/**
 * Build the client's plan for the CURRENT month from live sources. Every read
 * is fail-safe (its own try/catch): one unavailable source degrades to an empty
 * family instead of failing the whole plan — and a client with no data at all
 * still gets an honest fallback plan, which is an expected state, not an error.
 */
export async function buildMonthlySprint(
  clientId: string,
  opts?: { now?: Date },
): Promise<MonthlySprintPlan> {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) throw new Error("Client not found");

  // Dossier gaps → manual items (getDossierForClient is fail-safe internally).
  let manualNotes: string[] = [];
  try {
    const { getDossierForClient } = await import("@/lib/services/client-dossier");
    const dossier = await getDossierForClient(clientId);
    manualNotes = splitGapLines(dossier.gaps);
  } catch (err) {
    console.warn(
      `[sprint-planner] dossier read failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  let openRescues: RescueCandidate[] = [];
  try {
    openRescues = await readOpenRescueCandidates(clientId);
  } catch (err) {
    console.warn(
      `[sprint-planner] rescue candidates failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  let reviewItems: ReviewIssueCandidate[] = [];
  try {
    reviewItems = await readReviewIssueCandidates(clientId);
  } catch (err) {
    console.warn(
      `[sprint-planner] review candidates failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  let locationGaps: LocationGapCandidate[] = [];
  try {
    locationGaps = await readLocationGapCandidates(clientId);
  } catch (err) {
    console.warn(
      `[sprint-planner] location gaps failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return assembleSprintPlan({
    clientId,
    now: opts?.now,
    openRescues,
    reviewItems,
    locationGaps,
    manualNotes,
  });
}


// ─── Artifact storage (reports.raw_data.sprint) + progress ──────────────────────

/** The stored shape of raw_data we own. Other keys are preserved untouched. */
interface SprintRawData {
  sprint?: MonthlySprintPlan | null;
  [key: string]: unknown;
}

export function readStoredSprint(rawData: unknown): MonthlySprintPlan | null {
  if (!rawData || typeof rawData !== "object") return null;
  const sprint = (rawData as SprintRawData).sprint;
  if (!sprint || typeof sprint !== "object" || !Array.isArray((sprint as MonthlySprintPlan).weeks)) {
    return null;
  }
  return sprint as MonthlySprintPlan;
}

/**
 * Persist the plan onto the client's LATEST report row (raw_data.sprint, other
 * keys preserved) — or create a minimal placeholder report when the client has
 * none yet. Rebuilding mid-month replaces the artifact but item ids stay stable
 * (they derive from source rows), so completion ticks survive (DoD). Manual
 * overrides for the same period are carried across rebuilds.
 */
export async function storeSprintArtifact(
  clientId: string,
  plan: MonthlySprintPlan,
): Promise<{ ok: boolean; reportId?: string }> {
  try {
    const [latest] = await db
      .select({ id: reports.id, rawData: reports.rawData })
      .from(reports)
      .where(eq(reports.clientId, clientId))
      .orderBy(sql`generated_at DESC`)
      .limit(1);

    if (latest) {
      const prev = readStoredSprint(latest.rawData);
      // Carry operator ticks across a same-period rebuild.
      const carried =
        prev && prev.period === plan.period && Array.isArray(prev.overrides?.manualDone)
          ? { manualDone: [...prev.overrides.manualDone] }
          : undefined;
      const nextPlan: MonthlySprintPlan = carried ? { ...plan, overrides: carried } : plan;
      const mergedRawData: SprintRawData = { ...(latest.rawData as SprintRawData | null), sprint: nextPlan };
      await db.update(reports).set({ rawData: mergedRawData }).where(eq(reports.id, latest.id));
      return { ok: true, reportId: latest.id };
    }

    // No report yet for this client — a minimal placeholder row owns the
    // artifact. It stays invisible to the client until published, like any
    // other draft report.
    const lastDay = new Date(Number(plan.period.slice(0, 4)), Number(plan.period.slice(5, 7)), 0).getDate();
    const [created] = await db
      .insert(reports)
      .values({
        clientId,
        periodStart: `${plan.period}-01`,
        periodEnd: `${plan.period}-${String(lastDay).padStart(2, "0")}`,
        title: `Sprint plan ${plan.period}`,
        visibleToClient: false,
        rawData: { sprint: plan } satisfies SprintRawData,
      })
      .returning({ id: reports.id });
    return { ok: true, reportId: created?.id };
  } catch (err) {
    console.error(
      `[sprint-planner] store artifact failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  }
}

/** Read the client's ACTIVE plan — the stored artifact whose period is the
 * current month. Returns null when none exists (the UI then offers Rebuild). */
export async function getActiveSprint(clientId: string): Promise<MonthlySprintPlan | null> {
  try {
    const [latest] = await db
      .select({ rawData: reports.rawData })
      .from(reports)
      .where(eq(reports.clientId, clientId))
      .orderBy(sql`generated_at DESC`)
      .limit(1);
    const artifact = readStoredSprint(latest?.rawData ?? null);
    if (!artifact || artifact.period !== currentPeriodKey(new Date())) return null;
    return artifact;
  } catch (err) {
    console.warn(
      `[sprint-planner] active sprint read failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Rebuild the current-month plan and persist it. Idempotent on period: same
 * live inputs → same item ids/weeks (DoD). */
export async function rebuildCurrentSprint(
  clientId: string,
): Promise<{ ok: boolean; plan?: MonthlySprintPlan; error?: string }> {
  try {
    const plan = await buildMonthlySprint(clientId);
    const stored = await storeSprintArtifact(clientId, plan);
    if (!stored.ok) return { ok: false, error: "Could not persist the sprint artifact." };
    // Re-read so overrides carried by the store are visible to callers.
    const active = await getActiveSprint(clientId);
    return { ok: true, plan: active ?? plan };
  } catch (err) {
    const message = err instanceof Error ? err.message : "sprint build failed";
    console.error(`[sprint-planner] rebuild failed for ${clientId}:`, message);
    return { ok: false, error: message };
  }
}


/** Batch-resolve machine state for a plan's items (one query per family). */
async function resolveItemStates(
  clientId: string,
  plan: MonthlySprintPlan,
): Promise<Map<string, SprintItemStatus>> {
  const map = new Map<string, SprintItemStatus>();
  const items = flattenPlanItems(plan);

  const issueIds = items
    .filter((i) => i.family === "rescue" || i.family === "review-item")
    .map((i) => i.id.split(":")[1])
    .filter(Boolean);
  const targetIds = items
    .filter((i) => i.family === "location-page")
    .map((i) => i.id.split(":")[1])
    .filter(Boolean);

  const issueStatuses = new Map<string, string>();
  if (issueIds.length > 0) {
    try {
      const rows = await db
        .select({ id: seoIssues.id, status: seoIssues.status })
        .from(seoIssues)
        .where(and(eq(seoIssues.clientId, clientId), inArray(seoIssues.id, issueIds)));
      for (const r of rows) issueStatuses.set(r.id, String(r.status));
    } catch {
      // Fail-safe: unknown state renders as not-done with no status chip.
    }
  }

  const targetStatuses = new Map<string, string>();
  if (targetIds.length > 0) {
    try {
      const rows = await db
        .select({ id: blogKeywordTargets.id, status: blogKeywordTargets.status })
        .from(blogKeywordTargets)
        .where(and(eq(blogKeywordTargets.clientId, clientId), inArray(blogKeywordTargets.id, targetIds)));
      for (const r of rows) targetStatuses.set(r.id, String(r.status));
    } catch {
      // Fail-safe as above.
    }
  }

  const manualDone = new Set(plan.overrides?.manualDone ?? []);
  for (const item of items) {
    let done = false;
    let machineStatus: string | null = null;
    if (item.family === "rescue" || item.family === "review-item") {
      const id = item.id.split(":")[1];
      machineStatus = issueStatuses.get(id) ?? null;
      done = machineStatus !== null && RESOLVED_ISSUE_STATUSES.includes(machineStatus);
    } else if (item.family === "location-page") {
      const id = item.id.split(":")[1];
      machineStatus = targetStatuses.get(id) ?? null;
      done = machineStatus !== null && DONE_TARGET_STATUSES.includes(machineStatus);
    } else {
      done = manualDone.has(item.id);
    }
    map.set(item.id, { ...item, done, machineStatus });
  }
  return map;
}

/** Live progress for the client's ACTIVE plan (admin sprint tab + portal). */
export async function getSprintProgress(clientId: string): Promise<SprintProgress | null> {
  const plan = await getActiveSprint(clientId);
  if (!plan) return null;
  try {
    const states = await resolveItemStates(clientId, plan);
    const items = flattenPlanItems(plan).map((i) => states.get(i.id));
    const valid = items.filter((i): i is SprintItemStatus => Boolean(i));
    return {
      plan,
      items: valid,
      doneCount: valid.filter((i) => i.done).length,
      totalCount: valid.length,
    };
  } catch (err) {
    console.warn(
      `[sprint-planner] progress read failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Last-month completed-vs-planned score for the PDF: find the stored artifact
 * whose period is `periodKey` and evaluate its items against CURRENT machine
 * state. Null when no such artifact exists (the section prints "—"). */
export async function scoreStoredSprint(
  clientId: string,
  periodKey: string,
): Promise<{ period: string; done: number; total: number } | null> {
  try {
    const rows = await db
      .select({ rawData: reports.rawData })
      .from(reports)
      .where(eq(reports.clientId, clientId))
      .orderBy(sql`generated_at DESC`)
      .limit(6); // a plan is at most ~2 months old when it gets scored
    for (const row of rows) {
      const artifact = readStoredSprint(row.rawData ?? null);
      if (!artifact || artifact.period !== periodKey) continue;
      const states = await resolveItemStates(clientId, artifact);
      const items = flattenPlanItems(artifact).map((i) => states.get(i.id));
      const valid = items.filter((i): i is SprintItemStatus => Boolean(i));
      return {
        period: periodKey,
        done: valid.filter((i) => i.done).length,
        total: valid.length,
      };
    }
    return null;
  } catch (err) {
    console.warn(
      `[sprint-planner] score failed for ${clientId} (${periodKey}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Operator tick for a manual item — the only completion path that family has. */
export async function setManualItemDone(
  clientId: string,
  itemId: string,
  done: boolean,
): Promise<{ ok: boolean }> {
  try {
    const plan = await getActiveSprint(clientId);
    if (!plan) return { ok: false };
    if (!flattenPlanItems(plan).some((i) => i.id === itemId)) {
      return { ok: false }; // unknown item — never tick ids we did not emit
    }
    const current = new Set(plan.overrides?.manualDone ?? []);
    if (done) current.add(itemId);
    else current.delete(itemId);
    await storeSprintArtifact(clientId, { ...plan, overrides: { manualDone: [...current] } });
    return { ok: true };
  } catch (err) {
    console.warn(
      `[sprint-planner] manual tick failed for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  }
}

