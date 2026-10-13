import { NextResponse } from "next/server";
import { opsAuthGuard } from "@/lib/api/ops-auth";
import { trafficBySite } from "@/lib/api/ops-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/ops/traffic?days=28
 * Search Console totals per active blog. Not live visitors. link_events
 * (retired 2026-09-08) are intentionally absent.
 */
export async function GET(request: Request) {
  const denied = opsAuthGuard(request);
  if (denied) return denied;

  const requested = Number(new URL(request.url).searchParams.get("days") ?? "28");
  const days = Number.isFinite(requested)
    ? Math.min(90, Math.max(7, Math.round(requested)))
    : 28;

  const sites = await trafficBySite(days);
  return NextResponse.json({
    windowDays: days,
    sites,
    note: "Search Console, not live visitors. link_events is historic and is not in this payload.",
  });
}
