import { NextResponse } from "next/server";
import { opsAuthGuard } from "@/lib/api/ops-auth";
import { isUuid, iso, parseSince } from "@/lib/api/ops-data";
import { listGbpPacksSince } from "@/lib/services/gbp-packs";

// S4 ops endpoint — GET /api/v1/ops/gbp-packs?clientId=<uuid>&since=<ISO>&limit=100
// lets 396red audit what we PROMISED clients (F2: a promise log, never a record
// of GBP edits — Netgrid does not touch GBPs). OPS_API_KEY; since/limit cursor
// pattern copied from the canonical leads route (F5).

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const EPOCH = new Date(0);

export async function GET(request: Request) {
  const denied = opsAuthGuard(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId") ?? "";
  if (!isUuid(clientId)) {
    return NextResponse.json({ error: "clientId must be a uuid" }, { status: 400 });
  }

  const since = parseSince(url.searchParams.get("since")) ?? EPOCH;
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : DEFAULT_LIMIT,
  );

  const rows = await listGbpPacksSince(clientId, since, limit);
  const last = rows.length > 0 ? rows[rows.length - 1].createdAt : null;

  return NextResponse.json({
    source: "netgrid",
    kind: "gbp_packs",
    clientId,
    count: rows.length,
    packs: rows.map((r) => ({
      id: r.id,
      assetType: r.assetType,
      status: r.status,
      createdAt: iso(r.createdAt),
    })),
    nextSince: iso(last),
  });
}