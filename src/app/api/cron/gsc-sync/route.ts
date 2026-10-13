import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { seoIssues } from "@/lib/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  findSuppressedBlogs,
  runGscSync,
  sendSuppressedBlogsAlert,
} from "@/lib/services/gsc-sync";
import { provisionPendingProperties } from "@/lib/services/gsc-verifier";
// S6 §E — the weekly-run dossier freshness counter ("stale-dossier counter").
import { runDossierFreshnessCheck } from "@/lib/services/client-dossier";
// S4 §E — the 30-day description rotation check, folded into this run.
import { checkDescriptionRotation } from "@/lib/services/gbp-packs";
import {
  RESCUE_MAX_APPLIED_NETWORK,
  runPage2RescueForBlog,
  runPage2RescueOutcomes,
} from "@/lib/services/page2-rescue";
import {
  hygieneLedgerTelemetry,
  runQueryHygieneForBlog,
} from "@/lib/services/query-hygiene";
import { autoFixIssuesForScan, rescanBlogScore } from "@/lib/services/seo-autofix";

// A daily shard of ~375 blogs at concurrency 5 is one searchanalytics call and
// one small upsert each — roughly 200-300s. Backfill mode walks ~17 windows per
// blog, which is why its default batch is 25 rather than 500. 600s covers both
// with headroom for a slow tail.
export const maxDuration = 600;

/**
 * Google Search Console sync cron.
 *
 * GET /api/cron/gsc-sync
 *
 * Query params (all optional, cron-secret protected):
 *   ?shard=N&shardCount=M   Shard assignment. Same convention as auto-publish —
 *                           the cron SERVICE encodes it in CRON_PATH because
 *                           cron services and the web service have separate env
 *                           var sets.
 *   ?limit=N                Blogs per run. Default 500 daily / 25 backfill.
 *                           0 skips syncing entirely (used by the alert cron).
 *   ?days=N                 Trailing window for the daily pull. Default 5.
 *   ?backfill=1             Pull the historical window for blogs that have
 *                           never been backfilled, then stamp gsc_backfilled_at.
 *   ?months=N               Backfill length, clamped to Google's 16-month
 *                           retention ceiling. Default 16.
 *   ?blogId=<uuid>          Restrict to one blog. For debugging a single site.
 *   ?verify=1               Before syncing, attempt property provisioning for
 *                           blogs that are not verified yet. This is what picks
 *                           up CSV-imported blogs and WordPress blogs whose DNS
 *                           TXT record has since been published.
 *   ?verifyLimit=N          Blogs per provisioning pass. Default 50.
 *   ?alert=1                Run the suppressed-or-unindexed query and email it.
 *
 * Returns 200 with a zeroed summary (configured: false) when the service
 * account is not set, so an unconfigured environment does not fail the job.
 */

/** Same clamping semantics as the other cron routes, so every route parses
 * params identically. */
function clampInt(
  v: string | undefined | null,
  min: number,
  max: number,
  def: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shardParam = url.searchParams.get("shard");
  const shardCountParam = url.searchParams.get("shardCount");
  const backfill = url.searchParams.get("backfill") === "1";
  const verify = url.searchParams.get("verify") === "1";
  const alert = url.searchParams.get("alert") === "1";
  const blogId = url.searchParams.get("blogId") ?? undefined;

  const limit = clampInt(
    url.searchParams.get("limit"),
    0,
    2000,
    backfill ? 25 : 500,
  );
  const days = clampInt(url.searchParams.get("days"), 1, 90, 5);
  const months = clampInt(url.searchParams.get("months"), 1, 16, 16);

  try {
    // Provisioning first: a blog verified in this pass is eligible for the sync
    // in the same run, which makes onboarding one cron tick rather than two.
    // Explicitly initialised: TS narrows an unassigned `let` to
    // "used before being assigned" at the read sites below, which only run
    // when `verify` is set — the compiler cannot see that correspondence.
    let provisioned: Awaited<ReturnType<typeof provisionPendingProperties>> | undefined =
      undefined;
    if (verify) {
      provisioned = await provisionPendingProperties(
        clampInt(url.searchParams.get("verifyLimit"), 1, 200, 50),
      );
    }

    const summary = await runGscSync({
      shardIndex: shardParam !== null ? Number(shardParam) : undefined,
      shardCount: shardCountParam !== null ? Number(shardCountParam) : undefined,
      limit,
      days,
      backfill,
      months,
      blogId,
    });

    // ── S1 page-2 goldmine loop (runs on fresh data, once per daily sync).
    // Per blog: detect → generate at detection time → open in the ledger.
    // Per client: drain queued rescues through the shared apply pipeline and
    // re-measure outcomes for rows applied ≥ 28 days ago. Every step is
    // idempotent + fail-safe — a rescue failure must never fail the sync job.
    const rescue = {
      considered: 0,
      detected: 0,
      opened: 0,
      skippedExisting: 0,
      generated: 0,
      applied: 0,
      outcomesMeasured: 0,
      outcomesResolved: 0,
    };
    // S2/S8 — query hygiene (split / folded / pin / dead), one detector pass per
    // blog in this same run. Same fail-safe contract: never fails the sync job.
    const hygiene = {
      considered: 0,
      split: 0,
      folded: 0,
      pin: 0,
      dead: 0,
      opened: 0,
      skippedExisting: 0,
      generated: 0,
      // §E S8 telemetry — per-family detected-vs-decided over the whole ledger
      // (cumulative network state at the end of the run; counts only).
      open: { split: 0, folded: 0, pin: 0, dead: 0 },
      decided: { split: 0, folded: 0, pin: 0, dead: 0 },
    };
    // S4 §E — description rotation, checked per client alongside the outcome
    // loop. Read-only; the operator flips the live version in the gbp tab (F2).
    const gbpRotation = { checked: 0, due: 0 };
    // S6 §E — dossier freshness counter for this run (network-wide read-only
    // count; every edit in the dossier editor stamps last_verified_at).
    let dossierFreshness: Awaited<ReturnType<typeof runDossierFreshnessCheck>> | null = null;
    if (summary.configured && summary.results.length > 0) {
      const clientsSeen = new Set<string>();

      for (const outcome of summary.results) {
        if (!outcome.clientId) continue; // defensive: pre-S1 outcome rows
        rescue.considered += 1;
        try {
          const m = await runPage2RescueForBlog({ id: outcome.blogId, clientId: outcome.clientId });
          rescue.detected += m.detected;
          rescue.opened += m.opened;
          rescue.skippedExisting += m.skippedExisting;
          rescue.generated += m.generated;
        } catch (err) {
          console.warn(
            `[gsc-sync] page-2 rescue detection failed for blog ${outcome.blogId}:`,
            err instanceof Error ? err.message : err,
          );
        }

        // S2/S8 hygiene — the same fresh data, one more detector pass (spec:
        // "runs inside the page2-rescue cron run"). Own try/catch so a hygiene
        // surprise can never shadow the rescue metrics above.
        try {
          const h = await runQueryHygieneForBlog({ id: outcome.blogId, clientId: outcome.clientId });
          hygiene.considered += 1;
          hygiene.split += h.split;
          hygiene.folded += h.folded;
          hygiene.pin += h.pin;
          hygiene.dead += h.dead;
          hygiene.opened += h.opened;
          hygiene.skippedExisting += h.skippedExisting;
          hygiene.generated += h.generated;
        } catch (err) {
          console.warn(
            `[gsc-sync] query-hygiene pass failed for blog ${outcome.blogId}:`,
            err instanceof Error ? err.message : err,
          );
        }

        clientsSeen.add(outcome.clientId);
      }

      for (const clientId of clientsSeen) {
        try {
          // Drain THIS client's queued rescues through the shared pipeline. The
          // branch-level budgets are authoritative and stateless (today's applied
          // count); this cap only bounds wall time inside the cron window.
          // pin:% rows drain here too — S2's accidental-ranker pins carry the same
          // query_rescue payload, so one queue carries both families (F4).
          const queued = await db
            .select({ id: seoIssues.id, blogId: seoIssues.blogId })
            .from(seoIssues)
            .where(
              and(
                eq(seoIssues.clientId, clientId),
                inArray(seoIssues.status, ["queued"]),
                sql`(issue_key LIKE 'page2:%' OR issue_key LIKE 'pin:%')`,
                sql`${seoIssues.autoFixable} = true`,
              ),
            )
            .orderBy(asc(seoIssues.detectedAt))
            .limit(RESCUE_MAX_APPLIED_NETWORK);

          if (queued.length > 0) {
            const blogOfIssue = new Map(queued.map((r) => [r.id, r.blogId]));
            const apply = await autoFixIssuesForScan(
              queued.map((r) => r.id),
              RESCUE_MAX_APPLIED_NETWORK,
            );
            rescue.applied += apply.applied;

            // Tag hygiene moved — refresh the affected blogs' composite score
            // (no network call; mirrors what /api/seo/fix does after an apply).
            const rescanned = new Set<string>();
            for (const result of apply.results) {
              if (!result.applied) continue;
              const bId = blogOfIssue.get(result.issueId);
              if (bId && !rescanned.has(bId)) {
                rescanned.add(bId);
                await rescanBlogScore(bId).catch(() => {});
              }
            }
          }

          // Proof layer: re-measure rows applied ≥ 28 days ago and write the
          // delta into pre_snapshot.outcome (F8 — no delta without both sides).
          const oc = await runPage2RescueOutcomes(clientId);
          rescue.outcomesMeasured += oc.measured;
          rescue.outcomesResolved += oc.resolved;

          // S4 §E — the 30-day description rotation check for this client.
          try {
            const rot = await checkDescriptionRotation(clientId);
            gbpRotation.checked += 1;
            if (rot.due) gbpRotation.due += 1;
          } catch (err) {
            console.warn(
              `[gsc-sync] description rotation check failed for client ${clientId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        } catch (err) {
          console.warn(
            `[gsc-sync] page-2 rescue apply/outcome pass failed for client ${clientId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (rescue.detected > 0 || rescue.applied > 0 || rescue.outcomesMeasured > 0) {
        console.info(
          `[gsc-sync] page-2 rescue: considered=${rescue.considered} detected=${rescue.detected} ` +
            `opened=${rescue.opened} skipped=${rescue.skippedExisting} generated=${rescue.generated} ` +
            `applied=${rescue.applied} outcomes=${rescue.outcomesMeasured}`,
        );
      }

      if (hygiene.split > 0 || hygiene.folded > 0 || hygiene.pin > 0 || hygiene.dead > 0) {
        console.info(
          `[gsc-sync] query-hygiene: considered=${hygiene.considered} split=${hygiene.split} ` +
            `folded=${hygiene.folded} pin=${hygiene.pin} dead=${hygiene.dead} opened=${hygiene.opened} ` +
            `skipped=${hygiene.skippedExisting} generated=${hygiene.generated}`,
        );
      }

      // §E S8 telemetry — one cheap ledger read per run. Own try/catch:
      // telemetry must never fail the sync job (same contract as every pass).
      try {
        const t = await hygieneLedgerTelemetry();
        hygiene.open = t.open;
        hygiene.decided = t.decided;
      } catch (err) {
        console.warn(
          "[gsc-sync] hygiene detected-vs-decided telemetry failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // S6 §E — the stale-dossier counter, once per run (cheap read-only count,
    // so it runs even on shard/alert-only invocations).
    try {
      dossierFreshness = await runDossierFreshnessCheck();
      if (dossierFreshness.stale > 0 || dossierFreshness.neverVerified > 0) {
        console.info(
          `[gsc-sync] dossier freshness: verified=${dossierFreshness.verified} ` +
            `stale=${dossierFreshness.stale} neverVerified=${dossierFreshness.neverVerified} ` +
            `of ${dossierFreshness.clients} clients`,
        );
      }
    } catch (err) {
      console.warn(
        "[gsc-sync] dossier freshness check failed:",
        err instanceof Error ? err.message : err,
      );
    }

    let suppressed;
    let alertSent;
    if (alert) {
      suppressed = await findSuppressedBlogs();
      alertSent = await sendSuppressedBlogsAlert(suppressed);
    }

    return NextResponse.json({
      ...summary,
      rescue,
      hygiene,
      gbpRotation,
      ...(dossierFreshness ? { dossierFreshness } : {}),
      ...(verify
        ? {
            provisioned: {
              considered: provisioned?.length ?? 0,
              verified: provisioned?.filter((p) => p.status === "verified").length ?? 0,
              pendingDns: provisioned?.filter((p) => p.status === "pending_dns").length ?? 0,
              failed: provisioned?.filter((p) => p.status === "failed").length ?? 0,
              results: provisioned,
            },
          }
        : {}),
      ...(alert ? { suppressed, alertSent } : {}),
    });
  } catch (error) {
    console.error("GSC sync cron error:", error);
    const message = error instanceof Error ? error.message : "GSC sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
