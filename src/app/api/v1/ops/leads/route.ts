import { NextResponse } from "next/server";
import { opsAuthGuard } from "@/lib/api/ops-auth";
import { iso, listRegistrationLeads, parseSince } from "@/lib/api/ops-data";

export const dynamic = "force-dynamic";

/** GET /api/v1/ops/leads?since=<ISO>&limit=100 — 396red pull. OPS_API_KEY. */
export async function GET(request: Request) {
  const denied = opsAuthGuard(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const since = parseSince(url.searchParams.get("since"));
  if (!since) {
    return NextResponse.json({ error: "since must be an ISO timestamp" }, { status: 400 });
  }
  const requested = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(requested)
    ? Math.min(100, Math.max(1, Math.round(requested)))
    : 100;

  const leads = await listRegistrationLeads(since, limit);
  const last = leads[leads.length - 1]?.createdAt;
  return NextResponse.json({
    leads,
    nextSince: last ?? iso(since),
  });
}
