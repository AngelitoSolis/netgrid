import { NextResponse } from "next/server";
import { apiAuthGuard } from "@/lib/api/auth";
import { isUuid, parseSince } from "@/lib/api/public-data";
import { searchSummaryForClient } from "@/lib/search/performance-summary";
import { gscToday } from "@/lib/services/gsc-sync";
import { listRescueOutcomes } from "@/lib/services/page2-rescue";
import { listLocationPageOutcomes } from "@/lib/services/location-matrix";
import { listHygieneIssues } from "@/lib/services/query-hygiene";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/clients/{clientId}/search
 *
 * Search Console rollup already stored by the gsc-sync cron. Read-only.
 * Does not call Google. `position` is null when the window has no
 * impressions — callers must not coerce that to 0.
 *
 * Optional: ?days=7..90 (default 28)
 *
 * Cursor mode (?rescues=1): page-2 rescue + pin outcomes measured after
 * `?since=` (ISO timestamp; default = start of the current month in LA time).
 * The monthly sync reads this. Pass the previous response's nextCursor back as
 * `since` to continue — items are ordered by measuredAt asc, strict >.
 *
 * Cursor mode (?locationPages=1): S3 service × location pages GENERATED after
 * `?since=` (same window convention, same strict-> paging). Items are ordered
 * by generatedAt asc.
 *
 * Cursor mode (?hygiene=1): S2/S8 query-hygiene ledger rows (split/folded/
 * pin/dead) DETECTED after `?since=` — open and decided rows both appear with
 * their current lifecycle state, public fields only (no fix payloads).
 * Same window convention, same strict-> paging; ordered by detectedAt asc.
 */
export async function GET(
  request: Request,
  { params }: { params: { clientId: string } },
) {
  const denied = await apiAuthGuard(request);
  if (denied) return denied;

  if (!isUuid(params.clientId)) {
    return NextResponse.json({ error: "Invalid client id" }, { status: 400 });
  }

  const url = new URL(request.url);

  // ── Cursor mode — rescued-query outcomes (the proof layer, read-only) ──────
  if (url.searchParams.get("rescues") === "1") {
    // Same window convention as every other cursor read (public-data.parseSince):
    // ?since=<ISO> or ?days=N; when neither is given, default to the start of the
    // current month in America/Los_Angeles — gscToday() is THE LA date helper.
    const requested = parseSince(url.searchParams);
    let since: Date;
    if (requested) {
      since = requested;
    } else {
      const todayLa = gscToday();
      since = new Date(`${todayLa.slice(0, 8)}01T00:00:00Z`);
    }

    const requestedLimit = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.round(requestedLimit)))
      : 200;

    const items = await listRescueOutcomes(params.clientId, { since, limit });
    // Full page → there may be more; the caller continues with this cursor.
    const nextCursor =
      items.length === limit && items[items.length - 1]?.measuredAt
        ? items[items.length - 1].measuredAt
        : null;

    return NextResponse.json({
      clientId: params.clientId,
      mode: "rescues",
      since: since.toISOString(),
      limit,
      items,
      nextCursor,
      note:
        "Outcome rows only — a delta is present because BOTH before/after measurements exist (honest-skip rule). Positive deltaPositions = moved up. Pass nextCursor back as ?since= to page.",
    });
  }

  // ── Cursor mode — location-page ledger (S3, read-only) ─────────────────────
  if (url.searchParams.get("locationPages") === "1") {
    const requested = parseSince(url.searchParams);
    let since: Date;
    if (requested) {
      since = requested;
    } else {
      const todayLa = gscToday();
      since = new Date(`${todayLa.slice(0, 8)}01T00:00:00Z`);
    }

    const requestedLimit = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.round(requestedLimit)))
      : 200;

    const items = await listLocationPageOutcomes(params.clientId, { since, limit });
    const nextCursor =
      items.length === limit && items[items.length - 1]?.generatedAt
        ? items[items.length - 1].generatedAt
        : null;

    return NextResponse.json({
      clientId: params.clientId,
      mode: "location-pages",
      since: since.toISOString(),
      limit,
      items,
      nextCursor,
      note:
        "Generated service × location pages only (ledger status 'generated'), ordered by generatedAt asc, strict >. Pass nextCursor back as ?since= to page.",
    });
  }

  // ── Cursor mode — query-hygiene ledger (S2/S8, read-only) ─────────────────
  if (url.searchParams.get("hygiene") === "1") {
    const requested = parseSince(url.searchParams);
    let since: Date;
    if (requested) {
      since = requested;
    } else {
      const todayLa = gscToday();
      since = new Date(`${todayLa.slice(0, 8)}01T00:00:00Z`);
    }

    const requestedLimit = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(500, Math.max(1, Math.round(requestedLimit)))
      : 200;

    const items = await listHygieneIssues(params.clientId, { since, limit });
    const nextCursor =
      items.length === limit && items[items.length - 1]?.detectedAt
        ? items[items.length - 1].detectedAt
        : null;

    return NextResponse.json({
      clientId: params.clientId,
      mode: "hygiene",
      since: since.toISOString(),
      limit,
      items,
      nextCursor,
      note:
        "Open and decided query-hygiene ledger rows (split/folded/pin/dead) with public fields only — no fix payloads. Ordered by detectedAt asc, strict >. Pass nextCursor back as ?since= to page.",
    });
  }

  const requested = Number(url.searchParams.get("days") ?? "28");
  const days = Number.isFinite(requested)
    ? Math.min(90, Math.max(7, Math.round(requested)))
    : 28;

  const summary = await searchSummaryForClient(params.clientId, days);
  return NextResponse.json({
    clientId: params.clientId,
    windowDays: summary.windowDays,
    clicks: summary.clicks,
    impressions: summary.impressions,
    position: summary.position,
    blogsWithData: summary.blogsWithData,
    blogsInScope: summary.blogsInScope,
    queries: summary.queries,
    note:
      "Read from synced Search Console rows. position is null when there are no impressions. Do not treat a missing window as rank 0.",
  });
}
