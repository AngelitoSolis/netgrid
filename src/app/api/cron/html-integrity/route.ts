import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { repairBlogHtmlIntegrity } from "@/lib/services/html-integrity-repair";

// One live read + one live write per post, at platform rate limits.
export const maxDuration = 600;

/**
 * Repair the HTML damage T23 fixed at generation time on already-published
 * posts: the " ,  " em-dash artifact and block tags the old word-count cut
 * left unclosed. Reports (never repairs) the <br> word welds.
 *
 * Usage:
 *   /api/cron/html-integrity?blogId=<uuid>            → fix one blog (live)
 *   /api/cron/html-integrity?blogId=<uuid>&dryRun=1   → preview only, no writes
 *   /api/cron/html-integrity?blogId=<uuid>&limit=20   → cap posts this run
 *
 * Guarded by CRON_SECRET. Single-blog scoped on purpose so it can be proved on
 * one blog before any network-wide rollout. This is a one-time remediation
 * driven per blog by an operator, so it is deliberately NOT a scheduled cron
 * in render.yaml.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const blogId = url.searchParams.get("blogId");
  if (!blogId) {
    return NextResponse.json(
      { error: "blogId query parameter is required" },
      { status: 400 },
    );
  }

  const limitParam = url.searchParams.get("limit");
  const dryRun =
    url.searchParams.get("dryRun") === "1" ||
    url.searchParams.get("dryRun") === "true";

  try {
    const result = await repairBlogHtmlIntegrity(blogId, {
      limit: limitParam !== null ? Number(limitParam) : undefined,
      dryRun,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("HTML integrity repair error:", error);
    const message = error instanceof Error ? error.message : "Repair failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}