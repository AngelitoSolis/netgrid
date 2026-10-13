"use server";

import { revalidatePath } from "next/cache";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs, blogKeywordTargets, clients, locationPageTargets } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { topActiveClientKeywordsWithMeta } from "@/lib/content/client-keywords";
import { rerankPendingTargetsByLivePosition } from "@/lib/content/gsc-pool";
import { shardForBlog as shardForId } from "@/lib/cron/sharding";
import {
  buildKeywordTargetTitle,
  isEligibleKeywordTarget,
  normalizeTargetKeyword,
  shouldApplyLocalFraming,
} from "@/lib/content/keyword-targeting";
import {
  clusterKeywords,
  refineClustersWithEmbeddings,
} from "@/lib/content/keyword-clustering";

export type BlogKeywordTarget = typeof blogKeywordTargets.$inferSelect;

/** Cap on how many of a client's top-ranked keywords become ledger candidates. */
const CANDIDATE_LIMIT = 40;

// ─── Retry lifecycle + sweep tuning (T10) ────────────────────────────────────
// Read once at module load; change and redeploy the WEB service.

/** Read a bounded integer from env or an opts override. */
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

/**
 * How many times one ledger row may be attempted before it is dead-lettered
 * to 'failed'. Attempts include reaper requeues, so a keyword whose blog keeps
 * crashing mid-generation cannot loop forever.
 */
const MAX_TARGET_ATTEMPTS = envInt(process.env.KEYWORD_TARGET_MAX_ATTEMPTS, 3, 1, 10);

/** Cool-off before a requeued row becomes claimable again. */
const RETRY_DELAY_HOURS = envInt(process.env.KEYWORD_TARGET_RETRY_DELAY_HOURS, 6, 1, 168);

/**
 * A row claimed but never resolved for this long, with NO post attached, is
 * stranded. The auto-publish route's own ceiling is 600 s, so 90 minutes
 * cannot race a live run.
 */
const STUCK_GENERATING_MINUTES = envInt(process.env.KEYWORD_TARGET_STUCK_MINUTES, 90, 10, 1440);

/**
 * A row that DID produce a post but never resolved gets a much longer grace
 * window: it is mid-flight between generation and publish, and
 * resolveKeywordTargetForPublishedPost matches on status='generating' —
 * reaping it early would orphan that post's ledger row.
 */
const STUCK_WITH_POST_HOURS = 24;

/** Blogs one rebuild pass may touch, per shard. */
const REBUILD_MAX_BLOGS = envInt(process.env.KEYWORD_REBUILD_MAX_BLOGS, 400, 1, 5000);

/** Wall-clock budget for the rebuild phase. */
const REBUILD_TIME_BUDGET_MS = envInt(
  process.env.KEYWORD_REBUILD_TIME_BUDGET_MS,
  120_000,
  5_000,
  480_000,
);

export interface BuildResult {
  blogId: string;
  city: string | null;
  targeted: boolean;
  candidatesConsidered: number;
  eligible: number;
  /** Distinct clusters after near-duplicate variants were folded together. */
  clusters: number;
  /** How many of those clusters are written as CITY pages. */
  localFramed: number;
  upserted: number;
  message: string;
}

/**
 * The cities relevant to ONE client — its own blogs' assigned cities.
 *
 * This used to be a DISTINCT scan of every city in the network, which made
 * the collision filter cross-client: one client assigning a blog to Mobile or
 * Sale silently deleted unrelated keywords ("peptides for sale", "mobile
 * peptide delivery") for every OTHER client in the system. A keyword can only
 * collide with a city THIS client is actually writing about.
 */
async function clientCities(clientId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ city: blogs.city })
    .from(blogs)
    .where(and(eq(blogs.clientId, clientId), isNotNull(blogs.city)));
  return rows.map((r) => r.city).filter((c): c is string => Boolean(c));
}

/**
 * Build (or refresh) one blog's keyword-target ledger from its client's
 * scraped keywords. No-ops when the blog has no city — that IS the feature's
 * on/off switch (see docs/local-keyword-content-plan.md). A rebuild only ever
 * touches ranking/title metadata: a target already
 * generating/generated/failed/skipped keeps its status untouched, since that
 * column is deliberately absent from the upsert's `set`.
 */
export async function buildKeywordTargetsForBlogInternal(
  blogId: string,
  // knownCityList lets a bulk caller hoist the network-wide city list out of
  // its loop. knownCities() is a DISTINCT scan of the whole blogs table and
  // this function used to run it once PER BLOG — 1,500 identical scans per
  // sweep over a driver with one HTTPS round-trip per query. Omit it and the
  // old per-call behaviour is preserved for the single-blog callers.
  knownCityList?: string[],
): Promise<BuildResult> {
  const empty = {
    candidatesConsidered: 0,
    eligible: 0,
    clusters: 0,
    localFramed: 0,
    upserted: 0,
  };

  const [blog] = await db
    .select({
      id: blogs.id,
      clientId: blogs.clientId,
      city: blogs.city,
      localPresence: clients.localPresence,
    })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) {
    return { blogId, city: null, targeted: false, ...empty, message: "Blog not found." };
  }

  const city = blog.city;
  if (!city) {
    return {
      blogId, city: null, targeted: false, ...empty,
      message: "No city assigned — this blog stays on ordinary topic ideation.",
    };
  }

  const [candidates, cities] = await Promise.all([
    topActiveClientKeywordsWithMeta(blog.clientId, CANDIDATE_LIMIT),
    knownCityList ? Promise.resolve(knownCityList) : clientCities(blog.clientId),
  ]);

  const eligible = candidates.filter((c) => isEligibleKeywordTarget(c.keyword, cities));

  if (eligible.length === 0) {
    return {
      blogId, city, targeted: true, ...empty,
      candidatesConsidered: candidates.length,
      message:
        candidates.length === 0
          ? "This client has no active scraped keywords yet."
          : "Every scraped keyword was filtered out (navigational, or already names a city).",
    };
  }

  // Fold Autocomplete's near-duplicate phrasings into one target each. Without
  // this, "buy peptides" / "buy peptides online" / "where to buy peptides" /
  // "peptides for sale" become four near-identical posts on one site, which is
  // the textbook definition of doorway content. The variants ride along on the
  // surviving row as secondary keywords so coverage is unchanged.
  const clusters = await refineClustersWithEmbeddings(clusterKeywords(eligible));

  const now = new Date();
  const rows = clusters.map((cluster, index) => {
    const rep = cluster.representative;
    const localFraming = shouldApplyLocalFraming(rep.keyword, blog.localPresence);
    return {
      blogId: blog.id,
      clientId: blog.clientId,
      keyword: normalizeTargetKeyword(rep.keyword),
      city,
      topicTitle: buildKeywordTargetTitle(rep.keyword, city, { localFraming }),
      // Rank snapshot at build time — lower is better. Ordered by winnability,
      // not raw popularity (see content/client-keywords.ts).
      priority: index,
      keywordSource: rep.source,
      searchVolume: rep.searchVolume,
      // What that number actually describes. A city-framed row targets
      // "keyword + city" but the volume is the BARE keyword's national figure,
      // because DataForSEO is pulled at country-level location codes only.
      volumeScope: localFraming ? "bare_keyword" : "target_keyword",
      winnability: rep.winnability.toFixed(4),
      keywordDifficulty: rep.keywordDifficulty,
      localFraming,
      clusterKey: cluster.key.slice(0, 255),
      variants: cluster.variants,
      updatedAt: now,
    };
  });

  const upserted = await db
    .insert(blogKeywordTargets)
    .values(rows)
    .onConflictDoUpdate({
      target: [blogKeywordTargets.blogId, blogKeywordTargets.keyword, blogKeywordTargets.city],
      set: {
        topicTitle: sql`excluded.topic_title`,
        priority: sql`excluded.priority`,
        keywordSource: sql`excluded.keyword_source`,
        searchVolume: sql`excluded.search_volume`,
        volumeScope: sql`excluded.volume_scope`,
        winnability: sql`excluded.winnability`,
        keywordDifficulty: sql`excluded.keyword_difficulty`,
        localFraming: sql`excluded.local_framing`,
        clusterKey: sql`excluded.cluster_key`,
        variants: sql`excluded.variants`,
        updatedAt: now,
      },
    })
    .returning({ id: blogKeywordTargets.id });

  const localFramed = rows.filter((r) => r.localFraming).length;
  const folded = eligible.length - clusters.length;

  return {
    blogId, city, targeted: true,
    candidatesConsidered: candidates.length,
    eligible: eligible.length,
    clusters: clusters.length,
    localFramed,
    upserted: upserted.length,
    message:
      `${upserted.length} keyword target${upserted.length === 1 ? "" : "s"} up to date` +
      (folded > 0 ? ` (${folded} near-duplicate variant${folded === 1 ? "" : "s"} folded in)` : "") +
      `; ${localFramed} city-framed for ${city}.`,
  };
}

/** Admin-triggered on-demand rebuild for one blog (e.g. after assigning a city). */
export async function buildKeywordTargetsForBlog(blogId: string): Promise<BuildResult> {
  await requireAdmin();
  const result = await buildKeywordTargetsForBlogInternal(blogId);
  revalidatePath(`/blogs/${blogId}`);
  return result;
}

export interface RebuildSummary {
  shardIndex: number;
  shardCount: number;
  /** Blogs this run actually rebuilt. */
  blogsProcessed: number;
  blogsTargeted: number;
  targetsUpserted: number;
  /** S0-b live re-rank: pending rows pushed to the bottom of this run's
   * new-build queues because we already rank top-3 on their keyword. */
  liveRerankAlreadyWins: number;
  /** S0-b live re-rank: pending rows moved out of new-build order because the
   * page-2 rescue loop owns those queries now. */
  liveRerankRescueQueue: number;
  /** True when the run stopped on the blog cap or the time budget. */
  budgetExhausted: boolean;
  failed: Array<{ blogId: string; error: string }>;
}

/**
 * Rebuild active, city-bearing blogs' ledgers so newly-discovered keywords
 * become new targets. Called by the refresh-keywords cron right after the
 * scrape. Never throws — a failing blog is recorded and skipped so one bad
 * blog can't stall the run.
 *
 * Called with no arguments it does what it always did: a full sweep of every
 * active city-bearing blog — now bounded, so it cannot be the thing that makes
 * the request time out.
 *
 * The cron instead passes `clientIds` (the clients this tick actually scraped)
 * plus `includeUnbuilt: true`, which is both cheaper and more correct: a blog
 * whose client's keyword pool did not change has nothing new to upsert, while
 * a blog that has never been built (city assigned through the admin UI rather
 * than the CSV importer) must be picked up regardless.
 */
export async function rebuildAllKeywordTargetsInternal(
  opts: {
    /** Restrict to blogs of these clients. Omit for a full sweep. */
    clientIds?: string[];
    /** Additionally include active city blogs whose ledger is empty. */
    includeUnbuilt?: boolean;
    shardIndex?: number;
    shardCount?: number;
    maxBlogs?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<RebuildSummary> {
  const startedAt = Date.now();
  const shardCount =
    Number.isInteger(opts.shardCount) && (opts.shardCount as number) > 0
      ? (opts.shardCount as number)
      : 1;
  const shardIndex =
    Number.isInteger(opts.shardIndex) &&
    (opts.shardIndex as number) >= 0 &&
    (opts.shardIndex as number) < shardCount
      ? (opts.shardIndex as number)
      : 0;
  const maxBlogs = envInt(opts.maxBlogs, REBUILD_MAX_BLOGS, 1, 5000);
  const timeBudgetMs = envInt(opts.timeBudgetMs, REBUILD_TIME_BUDGET_MS, 5_000, 480_000);
  const scoped = opts.clientIds !== undefined;

  const empty: RebuildSummary = {
    shardIndex,
    shardCount,
    blogsProcessed: 0,
    blogsTargeted: 0,
    targetsUpserted: 0,
    liveRerankAlreadyWins: 0,
    liveRerankRescueQueue: 0,
    budgetExhausted: false,
    failed: [],
  };
  if (scoped && opts.clientIds!.length === 0 && !opts.includeUnbuilt) return empty;

  const rows = await db
    .select({ id: blogs.id, clientId: blogs.clientId })
    .from(blogs)
    .where(and(isNotNull(blogs.city), eq(blogs.status, "active")));

  // Which blogs already have ANY ledger row — ONE query, not one per blog.
  // Only needed for the scoped+includeUnbuilt path.
  let built = new Set<string>();
  if (scoped && opts.includeUnbuilt) {
    const builtRows = await db
      .selectDistinct({ blogId: blogKeywordTargets.blogId })
      .from(blogKeywordTargets);
    built = new Set(builtRows.map((r) => r.blogId));
  }

  const clientSet = scoped ? new Set(opts.clientIds) : null;
  const selected = rows.filter((r) => {
    if (shardCount > 1 && shardForId(r.id, shardCount) !== shardIndex) return false;
    if (!clientSet) return true;
    if (clientSet.has(r.clientId)) return true;
    return Boolean(opts.includeUnbuilt) && !built.has(r.id);
  });

  // Hoisted: ONE scan of (client_id, city) for the whole sweep instead of one
  // per blog. Grouped BY CLIENT, because the collision filter is client-scoped
  // now — a keyword can only collide with a city this client is itself writing
  // about (see clientCities). The old hoist handed every blog the network-wide
  // list, which is what made one client's "Mobile" or "Sale" blog delete
  // unrelated keywords for everybody else.
  const cityRows = await db
    .selectDistinct({ clientId: blogs.clientId, city: blogs.city })
    .from(blogs)
    .where(isNotNull(blogs.city));
  const citiesByClient = new Map<string, string[]>();
  for (const r of cityRows) {
    if (!r.city) continue;
    const list = citiesByClient.get(r.clientId);
    if (list) list.push(r.city);
    else citiesByClient.set(r.clientId, [r.city]);
  }

  let blogsProcessed = 0;
  let blogsTargeted = 0;
  let targetsUpserted = 0;
  let liveRerankAlreadyWins = 0;
  let liveRerankRescueQueue = 0;
  let budgetExhausted = false;
  const failed: Array<{ blogId: string; error: string }> = [];

  for (const { id, clientId } of selected) {
    if (blogsProcessed >= maxBlogs || Date.now() - startedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }
    blogsProcessed++;
    try {
      const result = await buildKeywordTargetsForBlogInternal(
        id,
        citiesByClient.get(clientId) ?? [],
      );
      if (result.targeted) blogsTargeted++;
      targetsUpserted += result.upserted;

      // S0-b live re-rank — right after this blog's ledger rebuild step: pending
      // rows we already rank on lose new-build priority so the drip never builds
      // a competitor against our own page. Never throws (fail-safe inside
      // gsc-pool); a GSC read failure simply leaves priorities as they were,
      // which is exactly today's behavior for blogs with no live data.
      const rerank = await rerankPendingTargetsByLivePosition(id);
      liveRerankAlreadyWins += rerank.alreadyWins;
      liveRerankRescueQueue += rerank.rescueQueue;
    } catch (err) {
      failed.push({
        blogId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    shardIndex,
    shardCount,
    blogsProcessed,
    blogsTargeted,
    targetsUpserted,
    liveRerankAlreadyWins,
    liveRerankRescueQueue,
    budgetExhausted,
    failed,
  };
}

// ─── Claim / lifecycle (called by runGenerateAndPublish) ────────────────────

export interface ClaimedKeywordTarget {
  id: string;
  keyword: string;
  city: string;
  topicTitle: string;
  /**
   * Whether this target is written as a CITY page. False means the row is
   * keyword-targeted but city-free — an informational/comparison keyword, or
   * a client with no real local presence. The caller must NOT build a
   * localTarget directive for a false row: `city` is still populated as the
   * build-time snapshot and as part of the uniqueness key, so reading it
   * without checking this flag is exactly the bug T09 fixes.
   */
  localFraming: boolean;
  /**
   * Near-duplicate phrasings folded into this target. Passed to the generator
   * as secondary keywords so ONE post covers all of them.
   */
  variants: string[];
}

/**
 * Claim the best pending keyword target for a blog — marks it 'generating'
 * and returns it, or undefined when there's nothing to claim (no city, or
 * every target already generating/generated/failed/skipped; see
 * buildKeywordTargetsForBlogInternal for how rows get here).
 *
 * Every sibling blog of a client builds its ledger from the SAME client-wide
 * ranked keyword pool (client_keywords, see topActiveClientKeywordsWithMeta),
 * so every sibling's own #1-priority pending row tends to be the identical
 * keyword — the only thing that differed was the city templated into the
 * title. Left unchecked, a client running many sibling blogs converges on
 * the same handful of topics network-wide. So: prefer this blog's best
 * pending row whose keyword no OTHER blog of the same client is currently
 * generating or has already generated (cross-sibling reservation) — this
 * spreads the network across the pool instead of every sibling picking the
 * same top keyword. Only once every one of this blog's pending keywords is
 * already reserved by a sibling (the pool has cycled through the whole
 * client) does it fall back to this blog's plain best pending row regardless
 * of sibling reservation — i.e. rotate through the ranked pool, wrap back to
 * #1 once exhausted, rather than starving a blog of new content forever.
 *
 * Select-then-conditional-update rather than a single locking statement:
 * each blog belongs to exactly one auto-publish shard (shardForBlog), so two
 * processes never race to claim the same BLOG's rows — the status='pending'
 * re-check on the update is a defensive guard, not a correctness
 * requirement. Two SIBLING blogs claiming in the same tick (different
 * shards) could in principle both compute the same "free" keyword before
 * either transitions to 'generating' — an accepted, rare race, not the
 * systemic every-sibling-picks-#1 problem this fixes. Never throws — a
 * lookup failure just means this post falls back to ordinary ideation, same
 * as "no city" or "ledger drained".
 *
 * A row that failed is REQUEUED to 'pending' with a cool-off in next_retry_at,
 * not buried in 'failed' (see markKeywordTargetFailed), so this query skips
 * rows whose cool-off has not elapsed and prefers rows that have never been
 * attempted. 'failed' now means only "burned its whole retry budget" and is
 * never claimable again.
 */
export async function claimKeywordTargetForBlog(
  blogId: string,
): Promise<ClaimedKeywordTarget | undefined> {
  try {
    const now = new Date();
    const pendingRows = await db
      .select({
        id: blogKeywordTargets.id,
        keyword: blogKeywordTargets.keyword,
        clientId: blogKeywordTargets.clientId,
      })
      .from(blogKeywordTargets)
      .where(
        and(
          eq(blogKeywordTargets.blogId, blogId),
          eq(blogKeywordTargets.status, "pending"),
          // Requeued rows serve a cool-off. A row that just failed must not be
          // re-claimed on the very next tick against whatever transient
          // condition (model 5xx, platform outage) just broke it.
          or(
            isNull(blogKeywordTargets.nextRetryAt),
            lte(blogKeywordTargets.nextRetryAt, now),
          ),
        ),
      )
      // Never-tried rows before retries, then by rank. Without the attempts
      // key a requeued row would keep beating fresh keywords on priority alone
      // and monopolise the blog's slot.
      .orderBy(asc(blogKeywordTargets.attempts), asc(blogKeywordTargets.priority));
    if (pendingRows.length === 0) return undefined;

    const clientId = pendingRows[0].clientId;
    const reservedRows = await db
      .selectDistinct({ keyword: blogKeywordTargets.keyword })
      .from(blogKeywordTargets)
      .where(
        and(
          eq(blogKeywordTargets.clientId, clientId),
          ne(blogKeywordTargets.blogId, blogId),
          inArray(blogKeywordTargets.status, ["generating", "generated"]),
        ),
      );
    const reserved = new Set(reservedRows.map((r) => r.keyword));

    const free = pendingRows.find((r) => !reserved.has(r.keyword));
    const chosen = free ?? pendingRows[0];

    const [claimed] = await db
      .update(blogKeywordTargets)
      .set({ status: "generating", updatedAt: new Date() })
      .where(and(eq(blogKeywordTargets.id, chosen.id), eq(blogKeywordTargets.status, "pending")))
      .returning({
        id: blogKeywordTargets.id,
        keyword: blogKeywordTargets.keyword,
        city: blogKeywordTargets.city,
        topicTitle: blogKeywordTargets.topicTitle,
        localFraming: blogKeywordTargets.localFraming,
        variants: blogKeywordTargets.variants,
      });
    if (!claimed) return undefined;
    return {
      id: claimed.id,
      keyword: claimed.keyword,
      city: claimed.city,
      topicTitle: claimed.topicTitle,
      localFraming: claimed.localFraming,
      // jsonb comes back untyped; coerce defensively — a malformed value must
      // not throw on a path that is claiming work.
      variants: Array.isArray(claimed.variants)
        ? (claimed.variants as unknown[])
            .map((v) => String(v ?? "").trim())
            .filter(Boolean)
        : [],
    };
  } catch (err) {
    console.warn(
      `[keyword-target] claim failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Mark a claimed target generated — the post actually targeted its keyword and published. */
export async function markKeywordTargetGenerated(
  id: string,
  generatedPostId: string,
): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(blogKeywordTargets)
      .set({
        status: "generated",
        generatedPostId,
        failureReason: null,
        // Terminal success: clear the retry gate so a later reaper pass or a
        // stray failure callback can never resurrect this row.
        nextRetryAt: null,
        lastAttemptAt: now,
        generatedAt: now,
        updatedAt: now,
      })
      .where(eq(blogKeywordTargets.id, id));
  } catch (err) {
    console.warn(
      `[keyword-target] failed to mark ${id} generated:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Record a failed attempt on a claimed target — either generation/publish
 * itself failed, or the run fell back to a generic re-ideated topic (so this
 * keyword was never actually covered).
 *
 * The row goes BACK INTO THE POOL ('pending', with a next_retry_at cool-off)
 * until it has burned MAX_TARGET_ATTEMPTS attempts, at which point it is
 * dead-lettered to 'failed' and never claimed again. The previous version set
 * 'failed' on the FIRST failure while claimKeywordTargetForBlog only ever
 * selected 'pending' and nothing anywhere reset it — so one transient model or
 * platform error permanently deleted that keyword from that blog, and every
 * blog's claimable pool only ever shrank (T10 §1.2).
 *
 * Single UPDATE, no read-modify-write: the neon-http driver has no
 * transactions, so the attempts increment and the status decision have to be
 * one statement to stay consistent under the rare two-sibling race documented
 * on claimKeywordTargetForBlog.
 */
export async function markKeywordTargetFailed(id: string, reason: string): Promise<void> {
  try {
    const now = new Date();
    const retryAt = new Date(now.getTime() + RETRY_DELAY_HOURS * 3_600_000);
    await db
      .update(blogKeywordTargets)
      .set({
        attempts: sql`${blogKeywordTargets.attempts} + 1`,
        status: sql`(case when ${blogKeywordTargets.attempts} + 1 >= ${MAX_TARGET_ATTEMPTS}::int then 'failed' else 'pending' end)::keyword_target_status`,
        nextRetryAt: sql`(case when ${blogKeywordTargets.attempts} + 1 >= ${MAX_TARGET_ATTEMPTS}::int then null else ${retryAt.toISOString()}::timestamp end)`,
        lastAttemptAt: now,
        failureReason: reason.slice(0, 2000),
        updatedAt: now,
      })
      // Never walk back a terminal success: a late failure callback for a post
      // that did publish must not un-generate the row.
      .where(and(eq(blogKeywordTargets.id, id), ne(blogKeywordTargets.status, "generated")));
  } catch (err) {
    console.warn(
      `[keyword-target] failed to mark ${id} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Retire a claimed target that must NOT be written: its templated title
 * duplicates an existing post, or the blog has already covered its keyword.
 * 'skipped' is terminal — claimKeywordTargetForBlog only ever selects
 * status='pending' — which is what we want here, unlike 'failed' (a transient
 * generation problem worth surfacing to the operator and retrying).
 */
export async function markKeywordTargetSkipped(id: string, reason: string): Promise<void> {
  try {
    await db
      .update(blogKeywordTargets)
      .set({
        status: "skipped",
        failureReason: reason.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(blogKeywordTargets.id, id));
  } catch (err) {
    console.warn(
      `[keyword-target] failed to mark ${id} skipped:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Operator skip. Same terminal status the generator uses, but gated: only a
 * pending row, only an admin, and the reason is recorded so the inbox can
 * show why the cron will not pick it. Does not touch claimKeywordTargetForBlog.
 */
export async function skipKeywordTargetAsAdmin(
  id: string,
  reason: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return { success: false, message: "A reason is required" };
  }

  const updated = await db
    .update(blogKeywordTargets)
    .set({
      status: "skipped",
      failureReason: `operator: ${trimmed.slice(0, 1800)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(blogKeywordTargets.id, id), eq(blogKeywordTargets.status, "pending")))
    .returning({ id: blogKeywordTargets.id });

  if (updated.length === 0) {
    return { success: false, message: "Target is not pending — leave it alone" };
  }
  revalidatePath("/opportunities");
  return { success: true, message: "Skipped. The cron will not generate this target." };
}


/**
 * Hand a claimed target straight back to the pool, untouched (T08).
 *
 * Used when the run that claimed it never actually started work — today the
 * only such case is losing the day-slot race in runGenerateAndPublish, where
 * a concurrent sweep already owns this blog's publishing slot for the UTC
 * day. Nothing was generated, so the keyword was not covered and the row
 * deserves its priority position back.
 *
 * 'pending', NOT 'failed': claimKeywordTargetForBlog only ever selects
 * status='pending', so 'failed' is terminal and would silently drain the
 * ledger. Draining the existing failed backlog is T10's job — this function
 * only avoids adding to it.
 *
 * The status='generating' guard makes this a no-op if something else already
 * resolved the row — never throws, the caller is on a publish hot path.
 */
export async function releaseKeywordTargetClaim(
  id: string,
  reason: string,
): Promise<void> {
  try {
    await db
      .update(blogKeywordTargets)
      .set({
        status: "pending",
        failureReason: reason.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(blogKeywordTargets.id, id),
          eq(blogKeywordTargets.status, "generating"),
        ),
      );
  } catch (err) {
    console.warn(
      `[keyword-target] failed to release ${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── location_page_targets lifecycle (S3 — migration 0057) ─────────────────────
//
// The S3 ledger reuses keyword_target_status but has no attempts/next_retry_at
// columns (spec DDL). Its circuit breaker is the fairness cursor itself: a
// failed row keeps status='pending' + error set, and the shared claimer refuses
// to re-claim a row whose last_attempt_at is inside LOCATION_RETRY_COOLDOWN —
// so one persistently failing pair rotates around instead of hot-looping, and
// an operator can always retire it via /locations (status → 'skipped').

/** Mark a claimed location target as generated. Terminal success: clear the
 * error history anchor so no cool-off predicate ever touches this row again. */
export async function markLocationTargetGenerated(id: string): Promise<void> {
  try {
    await db
      .update(locationPageTargets)
      .set({ status: "generated", lastAttemptAt: new Date(), updatedAt: new Date() })
      .where(eq(locationPageTargets.id, id));
  } catch (err) {
    console.warn(
      `[location-target] failed to mark ${id} generated:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Record a failed attempt — requeue with the cool-off anchor set. The claimer
 * refuses rows with error + recent last_attempt_at (see LOCATION_RETRY_COOLDOWN). */
export async function markLocationTargetFailed(id: string, reason: string): Promise<void> {
  try {
    await db
      .update(locationPageTargets)
      .set({
        status: "pending",
        error: reason.slice(0, 2000),
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      // Never walk back a terminal success (same guard as the keyword ledger).
      .where(and(eq(locationPageTargets.id, id), ne(locationPageTargets.status, "generated")));
  } catch (err) {
    console.warn(
      `[location-target] failed to mark ${id} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Retire a claimed target that must NOT be written (gate not ready, duplicate
 * title, already covered). 'skipped' is terminal — the claimer only selects
 * status='pending'. */
export async function markLocationTargetSkipped(id: string, reason: string): Promise<void> {
  try {
    await db
      .update(locationPageTargets)
      .set({ status: "skipped", error: reason.slice(0, 2000), updatedAt: new Date() })
      .where(eq(locationPageTargets.id, id));
  } catch (err) {
    console.warn(
      `[location-target] failed to mark ${id} skipped:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Hand a claimed target straight back to the pool untouched — used when the run
 * that claimed it never started work (lost day-slot race). 'generating' guard
 * makes this a no-op if something else already resolved the row. */
export async function releaseLocationTargetClaim(id: string): Promise<void> {
  try {
    await db
      .update(locationPageTargets)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(eq(locationPageTargets.id, id), eq(locationPageTargets.status, "generating")));
  } catch (err) {
    console.warn(
      `[location-target] failed to release ${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Operator skip from /locations — pending rows only, reason recorded. */
export async function skipLocationTargetAsAdmin(
  id: string,
  reason: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return { success: false, message: "A reason is required" };
  }

  const updated = await db
    .update(locationPageTargets)
    .set({
      status: "skipped",
      error: `operator: ${trimmed.slice(0, 1800)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(locationPageTargets.id, id), eq(locationPageTargets.status, "pending")))
    .returning({ id: locationPageTargets.id });

  if (updated.length === 0) {
    return { success: false, message: "Target is not pending — leave it alone" };
  }
  revalidatePath("/locations");
  return { success: true, message: "Skipped. The drip will not generate this target." };
}

export interface ReapResult {
  /** Stranded rows returned to the pool. */
  requeued: number;
  /** Stranded rows that had already burned their retry budget. */
  deadLettered: number;
}

/**
 * Return rows stranded in 'generating' to the pool (T10; supersedes T08's
 * single-window releaseStuckKeywordTargets).
 *
 * A claim sets status='generating' and only the very process that claimed it
 * ever transitions it out. When that process dies — container restart, deploy,
 * OOM, an uncaught throw above the resolution branch — the row sits in
 * 'generating' forever. That is worse than losing one row, because
 * 'generating' is ALSO a cross-sibling reservation (see the reservation query
 * in claimKeywordTargetForBlog): every sibling blog of that client permanently
 * loses that keyword from its own pool.
 *
 * Two windows, because 'generating' means two different things:
 *   - generated_post_id IS NULL — the run died before writing an article.
 *     Safe to reclaim after STUCK_GENERATING_MINUTES (90 min, far above the
 *     600 s auto-publish ceiling).
 *   - generated_post_id IS NOT NULL — an article exists and is waiting on
 *     publish; resolveKeywordTargetForPublishedPost will still match it on
 *     status='generating'. Give it STUCK_WITH_POST_HOURS (24 h) so a slow
 *     publish retry is never orphaned.
 *
 * DO NOT collapse these into one window. Reaping a row whose post is mid-flight
 * sends it back to 'pending' while the post publishes anyway — then a later
 * claim targets the same keyword a second time and the blog gets two
 * near-identical city pages.
 *
 * Requeue first, dead-letter second: the requeue UPDATE advances updated_at,
 * which drops those rows out of the second statement's own stale predicate, so
 * no row is processed twice.
 *
 * Never throws — the callers are cron paths and a reaper failure must not mask
 * their summaries.
 */
export async function reapStuckKeywordTargets(): Promise<ReapResult> {
  try {
    const now = new Date();
    const softCutoff = new Date(now.getTime() - STUCK_GENERATING_MINUTES * 60_000);
    const hardCutoff = new Date(now.getTime() - STUCK_WITH_POST_HOURS * 3_600_000);
    const retryAt = new Date(now.getTime() + RETRY_DELAY_HOURS * 3_600_000);

    const stranded = and(
      eq(blogKeywordTargets.status, "generating"),
      or(
        and(
          isNull(blogKeywordTargets.generatedPostId),
          lt(blogKeywordTargets.updatedAt, softCutoff),
        ),
        lt(blogKeywordTargets.updatedAt, hardCutoff),
      ),
    );

    const requeued = await db
      .update(blogKeywordTargets)
      .set({
        status: "pending",
        attempts: sql`${blogKeywordTargets.attempts} + 1`,
        nextRetryAt: retryAt,
        lastAttemptAt: now,
        failureReason: `Reaped: stranded in 'generating' with no resolution (claimed ${STUCK_GENERATING_MINUTES}+ minutes ago)`,
        updatedAt: now,
      })
      .where(and(stranded, lt(blogKeywordTargets.attempts, MAX_TARGET_ATTEMPTS - 1)))
      .returning({ id: blogKeywordTargets.id });

    const deadLettered = await db
      .update(blogKeywordTargets)
      .set({
        status: "failed",
        attempts: sql`${blogKeywordTargets.attempts} + 1`,
        nextRetryAt: null,
        lastAttemptAt: now,
        failureReason: `Reaped: stranded in 'generating' and out of attempts (${MAX_TARGET_ATTEMPTS})`,
        updatedAt: now,
      })
      .where(and(stranded, gte(blogKeywordTargets.attempts, MAX_TARGET_ATTEMPTS - 1)))
      .returning({ id: blogKeywordTargets.id });

    if (requeued.length > 0 || deadLettered.length > 0) {
      console.info(
        `[keyword-target] reaper — requeued ${requeued.length}, ` +
          `dead-lettered ${deadLettered.length} stranded 'generating' row(s)`,
      );
    }
    return { requeued: requeued.length, deadLettered: deadLettered.length };
  } catch (err) {
    console.warn(
      "[keyword-target] reaper failed:",
      err instanceof Error ? err.message : err,
    );
    return { requeued: 0, deadLettered: 0 };
  }
}

/**
 * T08 compatibility shim for the auto-publish sweep, which reports a single
 * "rows released" number alongside its own reaper counts.
 *
 * The thresholdMinutes argument is no longer honoured: T08 passed 30 minutes
 * and ignored generated_post_id entirely, which could reap a row whose post
 * was mid-publish and hand the same keyword out twice. reapStuckKeywordTargets
 * owns both windows now. Keeping the shim means the auto-publish hot path did
 * not have to change.
 */
export async function releaseStuckKeywordTargets(): Promise<number> {
  const { requeued, deadLettered } = await reapStuckKeywordTargets();
  return requeued + deadLettered;
}
