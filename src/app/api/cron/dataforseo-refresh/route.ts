import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { runDataForSeoRefreshCron } from "@/lib/actions/dataforseo-actions";

// Each client pull is up to MAX_SEEDS_PER_RUN sequential API calls with
// retries and a per-call timeout (services/dataforseo/client.ts), so a tick
// that processes its full client cap needs real headroom. The runner's own
// time budget (DATAFORSEO_CRON_TIME_BUDGET_MS, 240 s) is what actually bounds
// it: on Render `maxDuration` is documentation, not enforcement — the web
// service is a long-lived `next start` process, not a serverless function.
export const maxDuration = 600;

/**
 * GET /api/cron/dataforseo-refresh?shard=0&shardCount=4[&limit=5]
 *
 * SPENDS REAL MONEY. Hard-gated on DATAFORSEO_CRON_ENABLED and capped by
 * DATAFORSEO_MONTHLY_BUDGET; with the flag unset this is a no-op that reports
 * why. Safe to leave scheduled while disabled.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const numeric = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  try {
    const result = await runDataForSeoRefreshCron({
      shardIndex: numeric("shard"),
      shardCount: numeric("shardCount"),
      maxClients: numeric("limit"),
    });
    if (result.enabled && result.stoppedOn === "budget") {
      console.warn(`[dataforseo-cron] budget stop — ${result.message}`);
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error("DataForSEO refresh cron error:", error);
    const message = error instanceof Error ? error.message : "DataForSEO refresh failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
