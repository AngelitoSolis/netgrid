import { NextResponse } from "next/server";
import { opsAuthGuard } from "@/lib/api/ops-auth";
import { listThreadsSince, parseSince } from "@/lib/api/ops-data";

export const dynamic = "force-dynamic";

/** GET /api/v1/ops/threads?since=<ISO> — portal threads touched since then. */
export async function GET(request: Request) {
  const denied = opsAuthGuard(request);
  if (denied) return denied;

  const since = parseSince(new URL(request.url).searchParams.get("since"));
  if (!since) {
    return NextResponse.json({ error: "since must be an ISO timestamp" }, { status: 400 });
  }

  const threads = await listThreadsSince(since);
  return NextResponse.json({ threads });
}
