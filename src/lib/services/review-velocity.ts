// S5 — review-velocity math + response SLA (SEO loop). Lives inside the GBP
// tab, COMPUTED not generated: months-to-parity comes from pasted review-date
// history by the documented formula, never from a model, and every edge case
// the brief names is an explicit state the UI renders honestly (F8):
//   already ahead → maintain mode; < 6 months of dates on either side → the
//   number shows but is labeled "estimate (short history)"; missing dates → no
//   number at all, only the gap list.

import { db } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import { clientSeoDossiers } from "@/lib/db/schema";
import type { ParsedCompetitor } from "@/lib/services/gbp-packs";

// ─── Named constants ──────────────────────────────────────────────────────────

/** Below this many months of dated history on EITHER side, the number is an
 * estimate (the brief's short-history rule). */
export const SHORT_HISTORY_MONTHS = 6;
/** The response-time standard (the brief's SLA). */
export const RESPONSE_SLA_HOURS = 24;

// ─── Pure math ────────────────────────────────────────────────────────────────

export interface ReviewHistory {
  /** ISO 'YYYY-MM-DD' strings — exactly what the paste parser kept. */
  dates: string[];
  /** Total review count when the operator pasted one (may exceed the dated
   * sample: "review count: 142" + a handful of dates). Null when not pasted. */
  totalCount: number | null;
}

/** Parse pasted date-ish strings; unparseable entries come back separately so
 * the UI can show exactly what could not be used (no silent dropping). */
export function parseReviewDates(
  raw: string[],
): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const r of raw) {
    const s = String(r ?? "").trim();
    if (!s) continue; // blank paste noise is not a date and not worth reporting
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      ok.push(s);
    } else {
      bad.push(s);
    }
  }
  return { ok: ok.sort(), bad };
}

/** Calendar months spanned by the dated history (min 1) — the denominator's
 * time base. Pure. */
export function historyMonths(dates: string[]): number {
  if (dates.length === 0) return 0;
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const months = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  return Math.max(1, months(last) - months(first));
}

/** Reviews per month from the DATED sample. Fewer than 2 dates → null (a rate
 * from one data point is a guess, and F8 forbids guesses). */
export function reviewRatePerMonth(dates: string[]): number | null {
  if (dates.length < 2) return null;
  return dates.length / historyMonths(dates);
}

export type ParityState =
  | "maintain" // already at or ahead of the competitor's count
  | "behind" // a real months-to-parity number exists
  | "missing_data"; // dates missing on a needed side — no number is honest

export interface ParityResult {
  state: ParityState;
  /** The documented formula's number, when a number exists at all. */
  monthsToParity: number | null;
  estimate: boolean;
  theirRate: number | null;
  ourRate: number | null;
  theirCount: number | null;
  ourCount: number | null;
  /** Exactly why no number is shown (missing_data state). */
  gaps: string[];
}

/** THE calculation, verbatim from the brief:
 * monthsToParity = ceil((theirCount − ourCount) / max(1, theirRatePerMonth − ourRatePerMonth))
 * Rates come from pasted review-DATE history (not the pasted total counts —
 * those have no time base). Edge cases per the brief. Pure in `now` so it is
 * deterministic under test. */
export function monthsToParity(
  their: ReviewHistory,
  ours: ReviewHistory,
): ParityResult {
  const gaps: string[] = [];
  const theirDates = their.dates;
  const ourDates = ours.dates;
  if (theirDates.length < 2) gaps.push("competitor review dates: fewer than 2 dated reviews pasted");
  if (ourDates.length < 2) gaps.push("our review dates: fewer than 2 dated reviews pasted");
  if (gaps.length > 0) {
    return {
      state: "missing_data",
      monthsToParity: null,
      estimate: false,
      theirRate: null,
      ourRate: null,
      theirCount: their.totalCount,
      ourCount: ours.totalCount,
      gaps,
    };
  }

  const theirCount = their.totalCount ?? theirDates.length;
  const ourCount = ours.totalCount ?? ourDates.length;
  const theirRate = reviewRatePerMonth(theirDates) as number;
  const ourRate = reviewRatePerMonth(ourDates) as number;

  if (ourCount >= theirCount) {
    return {
      state: "maintain",
      monthsToParity: null,
      estimate: false,
      theirRate,
      ourRate,
      theirCount,
      ourCount,
      gaps: [],
    };
  }

  const months = Math.ceil((theirCount - ourCount) / Math.max(1, theirRate - ourRate));
  return {
    state: "behind",
    monthsToParity: months,
    estimate:
      historyMonths(theirDates) < SHORT_HISTORY_MONTHS ||
      historyMonths(ourDates) < SHORT_HISTORY_MONTHS,
    theirRate,
    ourRate,
    theirCount,
    ourCount,
    gaps: [],
  };
}

/** SLA proof line — how many logged responses meet the ≤24h standard is only
 * ever counted from the operator's actual log rows (F8: no invented %). */
export function withinSla(respondedAt: Date, reviewRefDate: Date | null): boolean {
  if (!reviewRefDate) return false; // no review timestamp → cannot claim the SLA
  return respondedAt.getTime() - reviewRefDate.getTime() <= RESPONSE_SLA_HOURS * 3_600_000;
}

// ─── S5 state rows (folded into gbp_assets 'reviews' payloads — no new table,
// exactly as the brief specifies) ────────────────────────────────────────────

export interface OurReviewHistoryRow {
  kind: "review_history";
  side: "ours";
  dates: string[];
  totalCount: number | null;
  createdAt: Date;
}

export interface ReviewResponseRow {
  kind: "response_log";
  reviewRef: string;
  respondedAt: string;
  notes: string;
  createdAt: Date;
}

/** Latest our-side review-history paste (newest row wins — inserts only). */
export async function latestOurReviewHistory(
  clientId: string,
): Promise<OurReviewHistoryRow | null> {
  const rows = (await db.execute(sql`
    SELECT payload, created_at AS "createdAt"
    FROM gbp_assets
    WHERE client_id = ${clientId}
      AND asset_type = 'reviews'
      AND payload->>'kind' = 'review_history'
    ORDER BY created_at DESC
    LIMIT 1
  `)) as unknown as Array<{ payload: OurReviewHistoryRow; createdAt: Date }>;
  const row = rows[0];
  if (!row || !row.payload || typeof row.payload !== "object") return null;
  return { ...row.payload, createdAt: new Date(row.createdAt) };
}

/** The operator's response log, newest first. */
export async function listReviewResponses(clientId: string): Promise<ReviewResponseRow[]> {
  const rows = (await db.execute(sql`
    SELECT payload, created_at AS "createdAt"
    FROM gbp_assets
    WHERE client_id = ${clientId}
      AND asset_type = 'reviews'
      AND payload->>'kind' = 'response_log'
    ORDER BY created_at DESC
    LIMIT 200
  `)) as unknown as Array<{ payload: ReviewResponseRow; createdAt: Date }>;
  return rows
    .filter((r) => r.payload && typeof r.payload === "object")
    .map((r) => ({ ...r.payload, createdAt: new Date(r.createdAt) }));
}

export interface CompetitorParityLine {
  competitor: string;
  parity: ParityResult;
  isTop: boolean;
}

/** Per-competitor parity lines for the gbp tab — computed from the dossier's
 * pasted competitor reviews and the latest our-side history paste. */
export async function reviewVelocityForClient(clientId: string): Promise<{
  ourHistory: OurReviewHistoryRow | null;
  lines: CompetitorParityLine[];
}> {
  const [history, [dossier]] = await Promise.all([
    latestOurReviewHistory(clientId),
    db
      .select({ competitorProfiles: clientSeoDossiers.competitorProfiles })
      .from(clientSeoDossiers)
      .where(eq(clientSeoDossiers.clientId, clientId))
      .limit(1),
  ]);

  const competitors: ParsedCompetitor[] = ((Array.isArray(dossier?.competitorProfiles)
    ? dossier.competitorProfiles
    : []) as unknown[])
    .map((c): ParsedCompetitor | null => {
      if (!c || typeof c !== "object") return null;
      const r = c as Record<string, unknown>;
      if (typeof r.name !== "string" || !r.name) return null;
      return {
        name: r.name,
        category: typeof r.category === "string" ? r.category : null,
        attributes: Array.isArray(r.attributes) ? r.attributes.map(String) : [],
        services: [],
        description: typeof r.description === "string" ? r.description : null,
        reviewCount: typeof r.reviewCount === "number" ? r.reviewCount : null,
        reviews: Array.isArray(r.reviews)
          ? (r.reviews as unknown[])
              .map((v): { date: string; rating: number | null } | null => {
                if (!v || typeof v !== "object") return null;
                const vr = v as Record<string, unknown>;
                return { date: String(vr.date ?? ""), rating: typeof vr.rating === "number" ? vr.rating : null };
              })
              .filter((v): v is { date: string; rating: number | null } => v !== null && v.date !== "")
          : [],
        photos: typeof r.photos === "number" ? r.photos : null,
        photosPerMonth: typeof r.photosPerMonth === "number" ? r.photosPerMonth : null,
      };
    })
    .filter((c): c is ParsedCompetitor => c !== null);

  const ours: ReviewHistory = {
    dates: history?.dates ?? [],
    totalCount: history?.totalCount ?? null,
  };

  // Top competitor = most pasted dated reviews (ties: most total reviews, then name).
  const ranked = [...competitors].sort(
    (a, b) =>
      b.reviews.length - a.reviews.length ||
      (b.reviewCount ?? 0) - (a.reviewCount ?? 0) ||
      a.name.localeCompare(b.name),
  );

  const lines = ranked.map((c, i) => ({
    competitor: c.name,
    isTop: i === 0,
    parity: monthsToParity(
      { dates: parseReviewDates(c.reviews.map((r) => r.date)).ok, totalCount: c.reviewCount },
      ours,
    ),
  }));

  return { ourHistory: history, lines };
}

// ─── §E rollout row: the renewal one-liner (monthly PDF) ─────────────────────

/** One honest line for the monthly PDF, shown only when a real parity state
 * exists (§E: "renewal one-liner when ahead/behind parity"). No pasted our-side
 * history or a missing_data top competitor → null: the PDF omits the line
 * instead of printing a guessed number (F8). `lines` is the ranked order from
 * reviewVelocityForClient, so lines[0] is the top competitor. Pure. */
export function renewalParityLine(velocity: {
  ourHistory: unknown;
  lines: CompetitorParityLine[];
}): string | null {
  if (!velocity.ourHistory || velocity.lines.length === 0) return null;
  const top = velocity.lines[0];
  if (top.parity.state === "maintain") {
    return `Review velocity vs ${top.competitor}: you are ahead — maintain mode, keep matching or beating their pace.`;
  }
  if (top.parity.state === "behind" && top.parity.monthsToParity !== null) {
    const unit = `month${top.parity.monthsToParity === 1 ? "" : "s"}`;
    const est = top.parity.estimate ? " — estimate (short history)" : "";
    return `Review velocity vs ${top.competitor}: about ${top.parity.monthsToParity} ${unit} to parity${est} (ours ${top.parity.ourCount ?? "—"} vs theirs ${top.parity.theirCount ?? "—"}).`;
  }
  return null;
}