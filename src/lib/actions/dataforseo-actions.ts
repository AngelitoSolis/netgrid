"use server";

import { revalidatePath } from "next/cache";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clients, clientKeywords, dataforseoRuns } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { resolveNicheConfig } from "@/lib/content/niche-config-db";
import {
  keywordSuggestions,
  dataForSeoConfigured,
  DataForSeoError,
} from "@/lib/services/dataforseo/client";
import { parseDataForSeoItems } from "@/lib/services/dataforseo/parse";
import { normalizeShardOpts, shardForId } from "@/lib/cron/sharding";

// Real search volume for the SAME per-client keyword pool the free
// Autocomplete scraper (keyword-actions.ts) already writes into — see
// docs/dataforseo-keyword-pipeline.md and the 0037 migration's header
// comment for why this reuses client_keywords instead of a separate store.
// Two entry points: the admin-triggered on-demand pull (unchanged behaviour,
// capped by DATAFORSEO_MAX_RUN_COST), and an unattended cron
// (runDataForSeoRefreshCron) capped ADDITIONALLY by a month-to-date budget.
// A cron that only had a per-run cap would spend that cap every single run,
// forever.

/** Cap on how many seeds one pull processes — a real-money guardrail. */
const MAX_SEEDS_PER_RUN = 10;
/** Keywords requested per seed from keyword_suggestions. */
const RESULTS_PER_SEED = 200;
/** Hard ceiling on spend for one run. Overridable; see .env docs in render.yaml. */
const DEFAULT_MAX_RUN_COST = 5.0;
/**
 * Hard ceiling on spend for one UTC calendar month, across every run.
 *
 * $20 is the operator-approved figure. Sizing, so the number is not mistaken
 * for a throughput target: one full pass over N clients costs N ×
 * MAX_SEEDS_PER_RUN × C, where C is the measured USD per seed. At 1,500
 * clients and C = $0.01 that is ~$150 per pass, so $20/month covers roughly
 * 200 clients — about 13% of the network per month. At C = $0.05 it is ~40
 * clients, under 3%. Run the per-seed cost query against dataforseo_runs
 * before assuming which end of that range applies.
 *
 * The consequence is deliberate and worth stating: keyword_difficulty will be
 * ABSENT for most of the network for a long time. Anything consuming it (T09)
 * must treat it as usually-missing, not usually-present.
 */
const DEFAULT_MONTHLY_BUDGET = 20.0;

function positiveFloat(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envInt(
  raw: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function maxRunCost(): number {
  return positiveFloat(process.env.DATAFORSEO_MAX_RUN_COST, DEFAULT_MAX_RUN_COST);
}

function monthlyBudget(): number {
  return positiveFloat(process.env.DATAFORSEO_MONTHLY_BUDGET, DEFAULT_MONTHLY_BUDGET);
}

/** True only when the operator has explicitly armed the unattended cron. */
function dataForSeoCronEnabled(): boolean {
  return ["1", "true", "yes"].includes(
    (process.env.DATAFORSEO_CRON_ENABLED ?? "").trim().toLowerCase(),
  );
}

/**
 * USD billed for successful pulls so far this UTC calendar month, straight
 * from the cost DataForSEO itself reported on each task and this module
 * persists. Fail-safe to Infinity — an unreadable ledger must STOP spending,
 * not license it.
 */
export async function monthlyDataForSeoSpendUsd(): Promise<number> {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [row] = await db
      .select({ total: sql<string | null>`coalesce(sum(${dataforseoRuns.cost}), 0)` })
      .from(dataforseoRuns)
      .where(
        and(
          eq(dataforseoRuns.status, "success"),
          gte(dataforseoRuns.startedAt, monthStart),
        ),
      );
    const n = Number(row?.total ?? 0);
    return Number.isFinite(n) ? n : Infinity;
  } catch (err) {
    console.error(
      "[dataforseo] could not read month-to-date spend — refusing to spend:",
      err instanceof Error ? err.message : err,
    );
    return Infinity;
  }
}

/** Split a free-text seed field (newlines and/or commas) into clean terms. */
function parseSeeds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/**
 * DataForSEO location/language for a client — mirrors the same en/fr split
 * keyword-actions.ts's localeForLanguageMode already uses for Autocomplete,
 * so a client's market doesn't shift between the two keyword sources.
 * 2840 (United States) / 2124 (Canada) are DataForSEO's country-level
 * location codes — stable, unlike granular city-level codes; still worth
 * confirming against the live /locations endpoint per the plan's own
 * "verify before coding" caveat before trusting this for a new market.
 */
function localeForLanguageMode(mode: string | null | undefined): {
  locationCode: number;
  languageCode: string;
} {
  return mode === "fr" || mode === "en_fr"
    ? { locationCode: 2124, languageCode: "fr" }
    : { locationCode: 2840, languageCode: "en" };
}

export interface DataForSeoScrapeResult {
  success: boolean;
  seedsProcessed: number;
  seedsSucceeded: number;
  seedsFailed: number;
  keywordsUpserted: number;
  totalCost: number;
  message: string;
}

/**
 * Pull real search volume for a client's keywords via DataForSEO and upsert
 * them into client_keywords (source='dataforseo'). Seeds are sequential, not
 * concurrent — this is an on-demand admin action over a small (<=10) capped
 * seed list, not the background, many-blog cron the original plan's
 * concurrency-5-10 recommendation was written for. Sequential also keeps the
 * cost ceiling's guarantee exact: this run can overshoot MAX_RUN_COST by at
 * most one call's cost, never more.
 *
 * A failing seed does not abort the run — it's recorded in dataforseo_runs
 * and the next seed is attempted, mirroring the free Autocomplete scraper's
 * own fail-safe behavior.
 */
export async function scrapeClientKeywordsViaDataForSeo(
  clientId: string,
): Promise<DataForSeoScrapeResult> {
  await requireAdmin();
  const result = await scrapeClientKeywordsViaDataForSeoInternal(clientId);
  revalidatePath(`/clients/${clientId}`);
  return result;
}

/**
 * The shared body. NO admin guard and NO revalidatePath: called by the wrapper
 * above (which guards) and by runDataForSeoRefreshCron (which runs under
 * CRON_SECRET). `ceiling` lets the cron hand down whatever is left of the
 * monthly budget when that is smaller than DATAFORSEO_MAX_RUN_COST.
 */
export async function scrapeClientKeywordsViaDataForSeoInternal(
  clientId: string,
  opts: { ceiling?: number } = {},
): Promise<DataForSeoScrapeResult> {

  if (!dataForSeoConfigured()) {
    return {
      success: false,
      seedsProcessed: 0,
      seedsSucceeded: 0,
      seedsFailed: 0,
      keywordsUpserted: 0,
      totalCost: 0,
      message: "DataForSEO is not configured — set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.",
    };
  }

  const [client] = await db
    .select({
      id: clients.id,
      niche: clients.niche,
      keywordSeeds: clients.keywordSeeds,
      languageMode: clients.languageMode,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) {
    return {
      success: false,
      seedsProcessed: 0,
      seedsSucceeded: 0,
      seedsFailed: 0,
      keywordsUpserted: 0,
      totalCost: 0,
      message: "Client not found.",
    };
  }

  const nicheConfig = await resolveNicheConfig(client.niche).catch(() => undefined);
  const nicheTopics = nicheConfig?.keyTopics ?? [];
  const manualSeeds = parseSeeds(client.keywordSeeds);
  const seeds = Array.from(
    new Set([...manualSeeds, ...nicheTopics.map((t) => t.toLowerCase())]),
  ).slice(0, MAX_SEEDS_PER_RUN);

  if (seeds.length === 0) {
    return {
      success: false,
      seedsProcessed: 0,
      seedsSucceeded: 0,
      seedsFailed: 0,
      keywordsUpserted: 0,
      totalCost: 0,
      message: "No seeds — add manual seeds or set a niche with key topics first.",
    };
  }

  const { locationCode, languageCode } = localeForLanguageMode(client.languageMode);
  const ceiling = Math.min(opts.ceiling ?? Number.POSITIVE_INFINITY, maxRunCost());

  let seedsSucceeded = 0;
  let seedsFailed = 0;
  let keywordsUpserted = 0;
  let totalCost = 0;

  for (const seed of seeds) {
    if (totalCost >= ceiling) {
      await db.insert(dataforseoRuns).values({
        clientId,
        seed,
        endpoint: "dataforseo_labs/google/keyword_suggestions/live",
        locationCode,
        languageCode,
        status: "failed",
        error: `Run cost ceiling ($${ceiling.toFixed(2)}) reached — skipped without calling the API.`,
        finishedAt: new Date(),
      });
      seedsFailed++;
      continue;
    }

    const [run] = await db
      .insert(dataforseoRuns)
      .values({
        clientId,
        seed,
        endpoint: "dataforseo_labs/google/keyword_suggestions/live",
        locationCode,
        languageCode,
        status: "pending",
      })
      .returning({ id: dataforseoRuns.id });

    try {
      const result = await keywordSuggestions({
        keyword: seed,
        locationCode,
        languageCode,
        limit: RESULTS_PER_SEED,
      });
      totalCost += result.cost;

      const parsed = parseDataForSeoItems(result.items);
      const now = new Date();
      if (parsed.length > 0) {
        const upserted = await db
          .insert(clientKeywords)
          .values(
            parsed.map((p) => ({
              clientId,
              keyword: p.keyword,
              searchVolume: p.searchVolume,
              cpc: p.cpc != null ? p.cpc.toString() : null,
              source: "dataforseo",
              keywordDifficulty: p.keywordDifficulty,
              competition: p.competition != null ? p.competition.toString() : null,
              lowTopOfPageBid: p.lowTopOfPageBid != null ? p.lowTopOfPageBid.toString() : null,
              highTopOfPageBid: p.highTopOfPageBid != null ? p.highTopOfPageBid.toString() : null,
              monthlySearches: p.monthlySearches,
              mainIntent: p.mainIntent,
              locationCode,
              raw: p.raw,
              fetchedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [clientKeywords.clientId, clientKeywords.keyword],
            // is_active (operator toggle) deliberately excluded — same
            // contract the Autocomplete scraper's upsert already honors.
            set: {
              searchVolume: sql`excluded.search_volume`,
              cpc: sql`excluded.cpc`,
              source: sql`excluded.source`,
              keywordDifficulty: sql`excluded.keyword_difficulty`,
              competition: sql`excluded.competition`,
              lowTopOfPageBid: sql`excluded.low_top_of_page_bid`,
              highTopOfPageBid: sql`excluded.high_top_of_page_bid`,
              monthlySearches: sql`excluded.monthly_searches`,
              mainIntent: sql`excluded.main_intent`,
              locationCode: sql`excluded.location_code`,
              raw: sql`excluded.raw`,
              fetchedAt: now,
              updatedAt: now,
            },
          })
          .returning({ id: clientKeywords.id });
        keywordsUpserted += upserted.length;
      }

      await db
        .update(dataforseoRuns)
        .set({
          status: "success",
          itemsReturned: parsed.length,
          cost: result.cost.toString(),
          finishedAt: new Date(),
        })
        .where(eq(dataforseoRuns.id, run.id));
      seedsSucceeded++;
    } catch (err) {
      const message =
        err instanceof DataForSeoError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      await db
        .update(dataforseoRuns)
        .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() })
        .where(eq(dataforseoRuns.id, run.id));
      seedsFailed++;
    }
  }

  return {
    success: seedsSucceeded > 0,
    seedsProcessed: seeds.length,
    seedsSucceeded,
    seedsFailed,
    keywordsUpserted,
    totalCost,
    message:
      seedsSucceeded === 0
        ? `All ${seeds.length} seed(s) failed — see the run log.`
        : `${keywordsUpserted} keyword(s) upserted from ${seedsSucceeded}/${seeds.length} seed(s). Cost: $${totalCost.toFixed(4)}.`,
  };
}

/** Recent DataForSEO run history for a client — cost/debugging visibility. */
export async function listDataForSeoRuns(clientId: string) {
  await requireAdmin();
  return db
    .select()
    .from(dataforseoRuns)
    .where(eq(dataforseoRuns.clientId, clientId))
    .orderBy(dataforseoRuns.startedAt);
}

// ─── cron: budgeted, sharded network refresh ─────────────────────────────────

/** Clients one cron tick may pull, per shard. */
const CRON_MAX_CLIENTS = envInt(process.env.DATAFORSEO_CRON_MAX_CLIENTS, 5, 1, 200);
/** Wall-clock budget for one cron tick. */
const CRON_TIME_BUDGET_MS = envInt(
  process.env.DATAFORSEO_CRON_TIME_BUDGET_MS,
  240_000,
  10_000,
  540_000,
);

export interface DataForSeoCronSummary {
  enabled: boolean;
  shardIndex: number;
  shardCount: number;
  monthlyBudget: number;
  spentThisMonthBefore: number;
  spentThisRun: number;
  clientsProcessed: number;
  clientsSucceeded: number;
  keywordsUpserted: number;
  stoppedOn: "disabled" | "budget" | "cap" | "time" | "done";
  message: string;
}

/**
 * Pull DataForSEO volume/difficulty for the clients whose data is oldest,
 * spending no more than what is left of this month's budget.
 *
 * Selection is least-recently-pulled-first (MAX(dataforseo_runs.started_at)
 * per client, nulls first) so the network is covered in rotation rather than
 * the same few clients being refreshed forever. Sharding matches the keyword
 * refresh so the two crons partition the network identically.
 *
 * Hard-gated on DATAFORSEO_CRON_ENABLED. Every guard fails CLOSED: unset flag,
 * unconfigured credentials or an unreadable spend ledger all mean "spend
 * nothing".
 */
export async function runDataForSeoRefreshCron(
  opts: {
    shardIndex?: number;
    shardCount?: number;
    maxClients?: number;
  } = {},
): Promise<DataForSeoCronSummary> {
  const startedAt = Date.now();
  const { shardIndex, shardCount } = normalizeShardOpts(opts);
  const maxClients = envInt(opts.maxClients, CRON_MAX_CLIENTS, 1, 200);
  const budget = monthlyBudget();

  const base: DataForSeoCronSummary = {
    enabled: false,
    shardIndex,
    shardCount,
    monthlyBudget: budget,
    spentThisMonthBefore: 0,
    spentThisRun: 0,
    clientsProcessed: 0,
    clientsSucceeded: 0,
    keywordsUpserted: 0,
    stoppedOn: "disabled",
    message: "",
  };

  if (!dataForSeoCronEnabled()) {
    return { ...base, message: "DATAFORSEO_CRON_ENABLED is not set — nothing was spent." };
  }
  if (!dataForSeoConfigured()) {
    return { ...base, message: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set." };
  }

  const spentBefore = await monthlyDataForSeoSpendUsd();
  if (!(spentBefore < budget)) {
    // NB: written as !(a < b) so an Infinity sentinel from an unreadable
    // ledger also stops the run.
    return {
      ...base,
      enabled: true,
      spentThisMonthBefore: Number.isFinite(spentBefore) ? spentBefore : 0,
      stoppedOn: "budget",
      message: `Month-to-date spend ($${
        Number.isFinite(spentBefore) ? spentBefore.toFixed(4) : "unknown"
      }) has reached the $${budget.toFixed(2)} budget.`,
    };
  }

  // Candidate pool: every client with a seed source. Small rows; one query.
  const allClients = await db
    .select({ id: clients.id, niche: clients.niche, keywordSeeds: clients.keywordSeeds })
    .from(clients);

  const lastRunRows = await db
    .select({
      clientId: dataforseoRuns.clientId,
      lastRunAt: sql<string | null>`max(${dataforseoRuns.startedAt})`,
    })
    .from(dataforseoRuns)
    .groupBy(dataforseoRuns.clientId);
  const lastRunByClient = new Map(
    lastRunRows.map((r) => [r.clientId, r.lastRunAt ? new Date(r.lastRunAt).getTime() : 0]),
  );

  const queue = allClients
    .filter((c) => parseSeeds(c.keywordSeeds).length > 0 || Boolean(c.niche?.trim()))
    .filter((c) => shardForId(c.id, shardCount) === shardIndex)
    .sort(
      (a, b) =>
        (lastRunByClient.get(a.id) ?? 0) - (lastRunByClient.get(b.id) ?? 0) ||
        a.id.localeCompare(b.id),
    );

  let spentThisRun = 0;
  let clientsProcessed = 0;
  let clientsSucceeded = 0;
  let keywordsUpserted = 0;
  let stoppedOn: DataForSeoCronSummary["stoppedOn"] = "done";

  for (const c of queue) {
    const remaining = budget - spentBefore - spentThisRun;
    if (remaining <= 0) {
      stoppedOn = "budget";
      break;
    }
    if (clientsProcessed >= maxClients) {
      stoppedOn = "cap";
      break;
    }
    if (Date.now() - startedAt >= CRON_TIME_BUDGET_MS) {
      stoppedOn = "time";
      break;
    }

    clientsProcessed++;
    try {
      const res = await scrapeClientKeywordsViaDataForSeoInternal(c.id, { ceiling: remaining });
      spentThisRun += res.totalCost;
      keywordsUpserted += res.keywordsUpserted;
      if (res.success) clientsSucceeded++;
    } catch (err) {
      console.error(
        `[dataforseo-cron] client ${c.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    enabled: true,
    shardIndex,
    shardCount,
    monthlyBudget: budget,
    spentThisMonthBefore: spentBefore,
    spentThisRun,
    clientsProcessed,
    clientsSucceeded,
    keywordsUpserted,
    stoppedOn,
    message: `${keywordsUpserted} keyword(s) upserted for ${clientsSucceeded}/${clientsProcessed} client(s). Spent $${spentThisRun.toFixed(
      4,
    )} this run; $${(spentBefore + spentThisRun).toFixed(4)} of $${budget.toFixed(
      2,
    )} month-to-date.`,
  };
}
