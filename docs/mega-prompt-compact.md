# MEGA PROMPT — COMPACT v2 · coding brief for branch `dre22sept` @ d0c277e

Full spec: `docs/mega-prompt-next-session.md` (read its §B/§C first if you need the "why").
This compact is the working brief. Every path, name, DDL and rule below was QA-verified
against code at **d0c277e** on 2026-09-23 — do not re-discover; trust-but-check if a name
moved. Migrations continue from **0056**. One independent commit per package (S0…S8), each
revertable alone. Nothing ships until its row in the full doc's §E rollout matrix is complete.

## Ground rules (violating any = rework)
- **F1** Auto-apply ONLY for managed URLs (resolve via `wp.findPostByUrl` / Shopify article id); else a recommendation issue with copy-paste-ready text. Never guess partial matches; never edit pages Netgrid didn't publish.
- **F2** Humans decide redirects, canonical changes, merges/deletes and ALL GBP actions (/review or gbp tab). Auto-safe = idempotent meta/link/ledger writes only, all budgeted.
- **F3** Real data only — every generated sentence traces to site_profiles / knowledge base / client_seo_dossiers / operator paste; missing fact → "not provided — do not invent".
- **F4** One ledger: `seo_issues` + `issue_key`; lifecycle enum fixed (detected→queued→approved→applied→verified / dismissed / failed); no parallel status tables.
- **F5** Reuse or justify in a comment: GSC reads via search_performance + weighted-position rule; dedupe via normalizeQueryKey; linking via semantic-linking exports; JSON-LD via wp-seo-injector; pings via index-now-pinger (skip ≠ fail); crons via verifyCronSecret with per-item isolation; ops endpoints via opsAuthGuard.
- **F6** Migrations sequential 0056→, additive first, through `db/migrate.mjs` conventions; drizzle definitions in schema.ts stay in lockstep.
- **F7** LLM calls per run capped + env-tunable (client-keywords.ts envInt pattern); zero DataForSEO spend this session.
- **F8** No client-facing number without both measurements behind it; "no measurable signal yet" is a valid state — never backfill silence with guesses.

## Verified seams (do not re-discover)
- **GSC data:** `search_performance` = one row per **(blog, date, query, page)** pair; columns: `date` string 'YYYY-MM-DD', `query` varchar(500), `page` varchar(2048) full URL, `rowHash`, `clicks int`, `impressions int`, **`position numeric(6,2)`** (already per-row avg). Ingest `services/gsc-sync.ts`: daily cron re-pulls trailing ~5-day window with upsert + one-time 16-month backfill; `blogs.gscLastSyncedAt`/`gscBackfilledAt`; **retention ceiling 16 months**. Sharding: copy the pattern from `src/app/api/cron/gsc-sync/route.ts`. Dates are America/Los_Angeles — always reuse `gscToday()` / `shiftDate()`, never server UTC. **Position aggregation everywhere = impressions-weighted:** `SUM(position::numeric * impressions) / NULLIF(SUM(impressions),0)` — plain AVG mis-ranks the goldmine list.
- **Issue pipeline:** `seo_scans` + `seo_issues` (schema.ts:317/:343). Every issue REQUIRES `scanId` NOT NULL; one scans row per run (score ints 0, real metadata in `rawData jsonb`). There is NO `kind` column — identity = `category` enum ['meta','content','technical','links','images','schema','performance'] + `severity` ['critical','warning','notice'] + title convention + fixPayload shape. Insert pattern to copy: `services/post-seo-runner.ts` ~170–230. **REGRESSION TRAP:** that runner DELETEs prior (blogId, pageUrl) issues with status detected/queued before re-inserting — migration 0056 ships WITH the one-line guard `AND issue_key IS NULL` on that delete so it only manages legacy keyless rows; test explicitly in S1.

- **Apply chain:** `services/seo-autofix.ts` → `autoFixIssue(issueId)` idempotent: loads blog, Shopify → `autoFixShopifyIssue`, WP → `wp.findPostByUrl(wpUrl,user,pass,pageUrl)` — **unresolvable URL = fix fails** (the F1 boundary). Dispatch via private `classifyFix` (~line 203) on kinds 'meta_title'|'meta_description'|'og_title'|'og_description'; values via `resolveMetaValue({source,generate})` (given text wins, no LLM; else `generateSeoFix`). Writers: `applyMetaTitle`/`applyMetaDescription`, pixel caps via `@/lib/seo/meta-suffix` (`measureTitlePx`/`capMetaDescription`), brand suffix only for yoast/rankmath (**copy lines 507–513**); plugin-less WP → JSON-LD Article fallback (`injectSchemaForPluginlessWp`); then `markApplied(issueId, summary)` + `rescanBlogScore` (~line 369) + `recomputeBlogQualityScore`.
- **Verify/ping:** `services/wp-meta-verify.ts` → `verifyLiveMeta(...)` (+ `readHeadMeta`, `titleMatches`, `descriptionMatches`). `services/index-now-pinger.ts` → `pingIndexNowFireAndForget(...)`: per-blog keys on `blogs.indexnowKey(+Location)`, verified via `indexnowKeyVerifiedAt`; every attempt lands in `index_ping_events` with outcome ok/failed/**skipped** (skip ≠ failure).
- **Cron skeleton:** routes at `src/app/api/cron/<name>/route.ts`; auth `verifyCronSecret(request)` from `@/lib/auth/helpers`; set `maxDuration`; per-item try/catch so one bad blog never kills the run; results array returned as JSON. Copy `src/app/api/cron/monthly-reports/route.ts`. Telemetry: cron_runs / pipeline_errors via run-telemetry, already surfaced on the `/pipeline` admin page.
- **Ops API (396red):** `opsAuthGuard(request)` from `@/lib/api/ops-auth`, data helpers in `@/lib/api/ops-data`; canonical example `src/app/api/v1/ops/leads/route.ts` (GET + since/limit + nextSince cursor). Never expose credentials, prompts or costs.

- **Winnability already exists — do not rebuild:** `content/client-keywords.ts`: one inspectable SQL winnability expression + env gates (`KEYWORD_MIN_VOLUME=20`, `MAX_VOLUME=20000`, `MAX_DIFFICULTY=35` (NULL difficulty never rejected), `NEUTRAL_DIFFICULTY=45`, `MIN_CANDIDATES=5` fallback to ungated pool, never empty); ordering = measured-volume rows first (`evidenceTier asc`) then winnability desc; two-pass in `activeClientKeywordRows`. Ledger snapshots it: `blog_keyword_targets.winnability numeric(12,4)` + `keywordDifficulty`, built by `buildKeywordTargetsForBlogInternal` (actions/keyword-target-actions.ts). **The ideation seam = `rankedQueriesForClient` in `content/topic-candidates.ts`** ("THIS IS THE T09 SEAM" comment; contract: ≤limit rows best-first, demand nullable, rank = index) — S0's pool filter lands inside that function body.
- **Local gate + ledgers:** `content/local-page-gate.ts` → single export `requireReadyLocalProfile(...)` (real operator facts only). `site_profiles` (schema.ts:1660): PK blogId, `neighborhood varchar(160)` = **SINGLE value today**, `signatureFacts jsonb[]`, `doesNot jsonb[]`, `placeNote text`. Target ledgers: `blog_keyword_targets` (schema.ts:1162; status pending/generating/generated/failed/skipped, `localFraming`, `priority` lower-is-better) and `peptide_location_targets` (schema.ts:1114). **QA finding:** no code outside schema.ts reads/writes either ledger in a cron — S3 builds the FIRST shared target-claiming drip and routes the existing ad-hoc blog_keyword_targets claim through it; regression test mandatory. Client flags already exist on `clients`: `locationCampaignEnabled`, `locationPagesPerDay` (default 2), `localPresence` (false → rows 'skipped' with reason, never generated).
- **Generation path:** `content/libraries/skeletons.ts` — `SKELETONS: Record<SkeletonId, Skeleton>` ids **1–12** (`SkeletonId` union in content/types.ts); S3 adds **#13**. Uniqueness: `content/story-reuse.ts` (5 story uses/30 days, never twice on same normalized query). `normalizeQueryKey` (content/topic-similarity) is THE dedupe key. Linking exports (`services/semantic-linking.ts`): `findRelated`, **`findTopicalLinkRefs`**, **`applyRelatedLinks`**, `relinkGeneratedPost`, `runSemanticLinkingBackfill`. JSON-LD (`services/wp-seo-injector.ts`): `buildArticleJsonLd`, `renderSchemaBlock`, `upsertSchemaBlock(body, block)` (idempotent), `injectArticleSchema`; FAQPage path exists.
- **Surfaces:** admin `(admin)/search` [GSC explorer → +Goldmine tab], `(admin)/review` [+S2/S8 item types, approve actions], `(admin)/opportunities`, `(admin)/seo/fix-queue`; NEW pages: `(admin)/locations` (S3), `(admin)/clients/[id]/gbp` (S4/S5); client header gains read-only dossier block (S6). Portal: `(portal)` cards per §E. Monthly PDF: `services/pdf-renderer.tsx` exports **`ReportPdfData`** + `renderReportPdf(data)`, built by `generateReportForCron(clientId, periodStart, periodEnd)` in actions/report-actions.ts — new sections = extend both. v1 API extends existing `api/v1/clients/[clientId]/search`.

## Migrations (write these four; additive; sequential numbers only)
**`src/lib/db/migrations/0056_issue_key_and_rescue.sql`** (serves S1–S2+S8):
```sql
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS issue_key varchar(255);
CREATE UNIQUE INDEX IF NOT EXISTS seo_issues_unique_idx
  ON seo_issues (blog_id, page_url, issue_key) WHERE issue_key IS NOT NULL;
-- Pre-fix snapshot for the before/after proof layer (S1-verify):
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS pre_snapshot jsonb;
```
Plus the one-line post-seo-runner delete guard from above (`AND issue_key IS NULL`).

**`src/lib/db/migrations/0057_location_page_targets.sql`:**
```sql
CREATE TABLE location_page_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blog_id uuid NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_key varchar(255) NOT NULL,      -- normalized commercial term
  place_name varchar(160) NOT NULL,       -- a REAL place from existing sources only
  combined_query varchar(400) NOT NULL,   -- "<service> <place>" (display + dedupe key)
  status keyword_target_status NOT NULL DEFAULT 'pending',  -- reuse existing enum!
  priority integer NOT NULL DEFAULT 0,    -- lower = earlier; from winnability snapshot
  last_attempt_at timestamp,              -- fairness cursor for rotation
  error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX location_page_targets_unique_idx
  ON location_page_targets (blog_id, service_key, place_name);
-- Optional multi-area support: operator-filled, same gate per area (additive only):
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS additional_areas jsonb;
```

**`src/lib/db/migrations/0058_gbp_packs.sql`:**
```sql
CREATE TABLE gbp_assets (            -- one generated pack row, re-generated on demand
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asset_type varchar(32) NOT NULL,   -- categories|attributes|services|description|posts|photos|reviews
  payload jsonb NOT NULL,            -- the full pack (see S4 generators)
  status varchar(16) NOT NULL DEFAULT 'ready',  -- ready|sent_to_client
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE gbp_description_versions (   -- A/B rotation with measurement hook
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  version integer NOT NULL,
  body varchar(750) NOT NULL,         -- GBP hard cap enforced in code AND DB check
  applied_at timestamp,               -- when the operator confirms it went live
  performance_note text,              -- filled by outcome pass if brand-query data exists
  UNIQUE (client_id, version)
);
```

**`src/lib/db/migrations/0059_client_seo_dossiers.sql`:**
```sql
CREATE TABLE client_seo_dossiers (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  business_model text,               -- what they actually sell & how (operator-verified)
  service_area jsonb NOT NULL DEFAULT '[]',   -- REAL places only (existing sources)
  differentiators jsonb NOT NULL DEFAULT '[]',-- from site_profiles.signatureFacts + KB
  audience text,                     -- who buys, what they fear, what they compare us to
  competitor_profiles jsonb NOT NULL DEFAULT '[]', -- S4 pasted data lives HERE
  recent_wins jsonb NOT NULL DEFAULT '[]',        -- resolved rescues + sprint outcomes (S1-verify feeds this!)
  gaps text,                         -- honest "we do not know" list — prompts must print it as a gap
  last_verified_at timestamp,        -- freshness stamp; stale (>90d) dossiers say so in output
  updated_at timestamp NOT NULL DEFAULT now()
);
```

## Packages (per-package DoD is binding)

### S0 — GSC-aware ideation + live ledger re-rank [~1 day]
Goal: stop creating competitors against our own pages; make priority reflect reality.
- **New module `src/lib/content/gsc-pool.ts`:** `rankedPageQueryPairs(blogId, opts)` → the (query, page) aggregates from the GSC-data seam for a trailing window (default 90d), impressions-weighted position, with floors as named constants + env override (`GSC_RESCUE_MIN_IMPRESSIONS`, default **50/90d**, client-keywords.ts envInt pattern). `queriesWeAlreadyRankFor(clientId)` → normalized set via `normalizeQueryKey` of every query with ≥1 page in positions 3–20 (the "we have a page for this" guard).
- **S0-a pool filter:** inside `rankedQueriesForClient`'s body, after the existing covered-query filtering: drop candidates whose normalized key is in `queriesWeAlreadyRankFor(clientId)` — they are S1's job (fix), not ideation's (new post). Log the count; return shape unchanged (contract above). Unit test with a seeded search_performance row proves a ranked query never reaches `candidates`.
- **S0-b ledger re-rank:** new action `rerankPendingTargetsByLivePosition(blogId)` called by the refresh-keywords cron AFTER its existing rebuild step: for pending rows whose keyword (or any variant) appears in GSC data — top-3 → deprioritize to bottom of new-build list (we already win); positions 8–20 → move their query into S1's queue instead. Document the exact comparator in code.
- **DoD:** both unit tests green + a seeded client shows zero ideation candidates that are live-ranked and pending ledger order matches a hand-computed expectation; zero behavior change for clients with no GSC data.

### S6 — Client SEO dossier: scratch prompts become server-side data [~1 day]
Every generated artifact in this session must be grounded in ONE per-client fact sheet, never re-asked and never invented. Today that context lives in operator chat prompts; it becomes table 0059 + a read path.
- **Service `src/lib/services/client-dossier.ts`:** `getDossierForClient(clientId)` → merged view: dossier row + site_profiles facts + top live GSC pairs (S0 module) + open issue counts + last sprint state. `buildDossierContextBlock(dossier)` → the single text block injected at the TOP of every prompt this session adds (rescue meta, GBP packs, location pages, sprint plans). Rules: nulls render as "not provided — do not invent"; stale (>90d) stamp renders a warning line; ≤ ~1200 tokens by construction (truncation order: competitor → wins → audience → area; differentiators and business_model never truncate).
- **Admin surface:** dossier editor in the client header per Surfaces seam (read-only for portal); every edit stamps `last_verified_at`.
- **DoD:** context block byte-stable for a fixture dossier (deterministic ordering, no timestamps inside); truncation order holds at 1200 tokens; all three consumers (S1/S3/S4) receive the identical block from one function — assert by spying on `buildDossierContextBlock` in each consumer's test.

### S1 — Page-2 goldmine rescue loop [~3 days] · THE CROWN JEWEL
The highest-ROI tactic, productized end-to-end with a proof layer. Uses migration 0056 (above).

> **IMPLEMENTED (S1 build) — what actually shipped:** `src/lib/services/page2-rescue.ts` = detector `detectPage2Rescues(blogId)` (raw SQL on the real columns, gsc-pool's named floors/window constants, impressions-desc) + detection-time generation via `generateRescueMeta()` (claude-client; S6 dossier block as the single facts source; RESCUE_META_PARSE_FAILED telemetry) + ledger persistence (one `seo_scans` row per run with rawData.kind='page2_rescue' and score ints 0; issues keyed `page2:<normQuery>`, category 'meta', preSnapshot = BEFORE measurement, managed → 'queued'/autoFixable, unmanaged → 'detected') + orchestrator `runPage2RescueForBlog` (upsert guard in one query; stateless F7 generation budget = this client's proposals opened TODAY). APPLY: a branch inside `seo-autofix.autoFixIssue` dispatching on fixPayload.kind='query_rescue' — zero LLM when the proposal exists, exactly one retry via generateRescueMeta otherwise; stateless apply budgets (`rescueApplyBudgetLeft`: today's applied count, network + per-blog); pixel caps/brand suffix identical to every other meta write; `verifyLiveMeta` BEFORE markApplied (verified===false → failed with observed title; null/unreachable → still applied, outcome loop measures via GSC). PROOF: `runPage2RescueOutcomes(clientId)` re-measures rows applied ≥ RESCUE_OUTCOME_MIN_DAYS=28d and writes `preSnapshot.outcome` ONLY when both measurements exist (F8 honest skip; delta ≥ -1 = resolved). CRON WIRING: gsc-sync route runs detection per synced blog right after sync, then drains this client's queued rescues through the shared pipeline (`autoFixIssuesForScan`, oldest first) + `rescanBlogScore` for affected blogs + the outcome loop; `rescue{...}` metrics in the response JSON. GUARDS: BOTH delete paths exempt keyed rows — post-seo-runner (migration 0056 comment) AND seo-scan `purgeCrawlerIssues` (`issue_key IS NULL`). TESTS: page2-rescue.test.ts — 21 pure-core tests pinning F8 boundaries (-1 stable / worse stays open / missing side → null delta), key stability, normalizeForMatch (F1), severity top-3-critical. Gates green: tsc · vitest 551/551 · eslint · next build.
> **Deviations from the plan below:** (a) apply dispatches on `fixPayload.kind` inside autoFixIssue rather than a new classifyFix kind — scanner titles never shape rescue rows; (b) budgets are stateless DB counts of today's generated/applied rows (shard-safe across the 4 cron services), not in-memory per-run counters; (c) unmanaged pairs still get a detection-time proposal for copy-paste-ready text but stay 'detected' + autoFixable=false.
> **S1 SURFACES SHIPPED (this session):** Goldmine tab = new server route `(admin)/search/[clientId]/goldmine` (top 50 pairs client-wide, impressions-desc, weighted position, per-pair issue-status chip matched on the exact `page2:<norm>\u0000normalizeForMatch(page)` identity; Overview/Goldmine tab links on the parent page). `/review` gains a "GSC loop issues" card (open keyed rows: detected/queued) with one-click Approve/Dismiss via `approveGscIssue`/`dismissGscIssue` (actions/review-actions.ts): auto-safe → runs `autoFixIssue` immediately; unmanaged rescue → operator attestation marks 'applied'; split → ledger consolidation first then decided; folded/dead → decision recorded. Portal dashboard gains "Search improvements this month" card from `rescueOutcomeSummaryForClient` (resolved outcomes measured since the 1st, avg Δ). v1 `api/v1/clients/[clientId]/search?rescues=1&since=` cursor endpoint over `listRescueOutcomes` (measuredAt asc, strict->, nextCursor; public-data.parseSince window convention). PDF "Queries That Moved" section: `ReportPdfData.queriesThatMoved` + renderer block, populated in emailReportPdfInternal from the same outcome rows for the report period (onlyResolved; fail-safe null omits the section).

**Detector `src/lib/services/page2-rescue.ts` → `detectPage2Rescues(blog): RescueFinding[]`** (raw SQL, real columns):
```sql
SELECT query, page,
       SUM(impressions)                              AS impressions_90d,
       SUM(clicks)                                   AS clicks_90d,
       SUM(position::numeric * impressions)
         / NULLIF(SUM(impressions), 0)               AS avg_position
FROM search_performance
WHERE blog_id = $1 AND date > (CURRENT_DATE - 90)   -- LA dates: use gscToday()/shiftDate()
GROUP BY query, page
HAVING SUM(impressions) >= :minImpressions          -- default 50/90d
   AND SUM(position::numeric * impressions) / NULLIF(SUM(impressions),0)
        BETWEEN 8.0 AND 20.4                          -- "page 2": article says 11–20; widened to 8+ for the meta-only era
ORDER BY impressions_90d DESC LIMIT 50;
```
Per pair: (a) join `generated_posts` on normalized URL — **managed** = row exists with a platform post id → autoFixable=true; unmanaged → recommendation issue, autoFixable=false. (b) Issue identity: `issue_key = 'page2:' || normalizeQueryKey(query)` + pageUrl = the CANONICAL stored URL (never the raw GSC string — findPostByUrl must resolve it). (c) Upsert with `onConflictDoNothing` on the unique index; never touch rows past detected/queued that carry a higher status. (d) One `seo_scans` row per run: category 'meta', severity 'warning' (top-3 by impressions = 'critical'), title convention `Page-2 rescue: "{query}" ({avg_position} avg, {impressions} imp/90d)`.

**Rescue copy generation — at DETECTION time, not apply time:** new prompt variant in `services/claude-client.ts` beside `generateSeoFix`, named `generateRescueMeta({ query, avgPosition, impressions90d, currentTitle, currentDescription, pageExcerpt, niche, siteFacts })`. Template core (siteFacts = S6 dossier block — real data only, gaps stated as gaps):
```
You are rewriting the meta title + description of ONE existing page that already ranks
#{{avgPosition}} for "{{query}}" ({{impressions90d}} impressions in 90 days). We are on
page two. The goal is a top-5 finish without changing what the page is about.
BUSINESS: {{niche}} — {{siteFacts or "no verified site facts; do not invent any"}}
CURRENT TITLE ({{currentTitle.length}} chars): {{currentTitle}}
CURRENT DESCRIPTION: {{currentDescription or "(none)"}}
PAGE CONTENT EXCERPT: {{pageExcerpt}}
RULES: title ≤ 58 chars, query or a natural variant in the first half, one differentiator
from the facts above (never invented); description ≤ 148 chars, states who/where/benefit,
ends with a soft CTA matching the business's real service area; no keyword stuffing, no
em-dash spam. Output JSON: {"title": "...", "description": "..."}
```
Store in `fixPayload`: `{kind:'query_rescue', targetQuery, proposedTitle, proposedDescription, windowDays:90}` and `pre_snapshot` (aggregation at detection time: {avgPosition, impressions90d, clicks90d, capturedAt}). If the model call fails, still open the issue with proposal=null — apply falls back to `generateSeoFix`'s today path.

**Apply:** new branch in `classifyFix` (seo-autofix.ts ~203): kind 'query_rescue' → use `fixPayload.proposedTitle/proposedDescription` when present (deterministic, zero LLM at apply time), else the existing generate path; then the SAME writers: pixel caps via `measureTitlePx`/`capMetaDescription`, brand suffix only for yoast/rankmath (copy lines 507–513), `applyMetaTitle` + `applyMetaDescription`, plugin-less WP JSON-LD fallback, Shopify → existing metafield path. After apply: `rescanBlogScore` + `recomputeBlogQualityScore` + `pingIndexNowFireAndForget(postUrl)` (event lands in index_ping_events; missing key/Shopify = 'skipped', not error). **WP pre-check:** if `seoPlugin='yoast' AND seoBridgeVersion IS NULL`, the REST meta write is silently dropped — route those to the JSON-LD fallback + a /review note instead of claiming success.

**Verify + BEFORE/AFTER PROOF LAYER (what makes this a system, not a script):**
- Immediate verify (same run): `verifyLiveMeta(...)` on the applied post → status 'verified' when live head matches; mismatch after apply = status 'failed', failureReason with the diff (catches dropped Yoast writes the pre-check couldn't predict).
- **Outcome loop:** new cron `src/app/api/cron/rescue-outcomes/route.ts` (weekly): for issues in ('applied','verified') whose appliedAt is ≥ 28 days old, re-run the pair's 30-day aggregation; write into `pre_snapshot.outcome = {afterPosition, afterImpressions, deltaPositions, measuredOverDays}` and set status 'resolved' when improved-or-stable. The monthly report builder reads these rows for the **"Queries that moved"** PDF section: one row per resolved rescue — query, page, before → after position, impressions trend, applied date. This is the renewal-conversation artifact; it must never show a delta without both measurements actually present (honest-skip rule).

**Cron `src/app/api/cron/page2-rescue/route.ts`:** verifyCronSecret + maxDuration 300; shard handling copied from gsc-sync route (N shards, one per invocation); candidates = `blogs.status='active' AND gsc_backfilled_at IS NOT NULL`, oldest-gscLastSyncedAt first (a blog without fresh GSC data produces stale rescues). Per-run budgets: ≤ 5 rescues generated (LLM cost), ≤ 3 applied per blog, ≤ 15 applied network-wide; every budget an envInt with safe defaults. A blog's daily apply budget must also respect the existing autofix budgets in seo-autofix.ts — check them first and take the minimum.

**Surfaces:** `(admin)/search` gains a "Goldmine" tab (top pairs per client, positions + impressions + issue status chip); `/review` lists page2 issues with one-click Approve for auto-safe ones and an explicit "apply recommendation manually" note for unmanaged URLs; portal card `Search improvements this month: N queries rescued (avg ΔX positions)` reading the same outcome rows; v1 API extends `api/v1/clients/[clientId]/search` with a `rescues?since=` cursor endpoint (ops-auth shape).

**Tests (fixture-based, no network):** seed search_performance rows for a fake blog: pair A ("drain cleaning old town", /blog/x, 210 imp/90d @ pos 14.2), pair B (30 imp → below floor, must NOT detect), pair C (pos 5 → out of window), pair D on an unmanaged URL (→ recommendation issue). Assert: detection set = {A managed, D unmanaged}; issue_key idempotent across two runs; post-seo-runner delete leaves keyed rows intact; classifyFix branch picks stored proposal without calling the model (mock claude-client and assert zero calls); verify step flips status on matched/mismatched live meta.

### S2 — Query hygiene: splits, Google-folded, accidental ranks [~1.5 days]
Detector `src/lib/services/query-hygiene.ts`, same scan-row/upsert pattern as S1 (runs inside the page2-rescue cron run — one detector pass, three families). All keyed, all category-accurate per the B.2 enum:
1. **`split:<normQuery>`** — category 'content', severity 'warning'. SQL: group the 90d pairs by `normalizeQueryKey(query)`; flag when ≥2 DISTINCT pages each clear a lower floor (≥ 25 imp/90d) for the same normalized query → "two posts split one query". fixPayload: both pages' URLs + their per-page impressions-weighted positions. Action is LEDGER-ONLY until T23 lands: consolidate `blog_keyword_targets` variants onto the stronger page (mark loser row 'skipped', reason 'query-split:<winnerUrl>') and queue a canonical/redirect RECOMMENDATION for /review — **humans approve redirects** (F2).
2. **`folded:<normPage>`** — category 'technical', severity 'critical' when `googleCanonical` ≠ userCanonical on `index_coverage` rows (the schema comment calls this "the single most diagnostic pair" — we are building exactly what that column was made for). SuggestedFix names the folded-into URL; action = recommendation only.
3. **`pin:<normQuery>`** — category 'meta', severity 'notice'. Query at position ≤ 5 with ≥ 200 imp/90d but whose post's stored meta does not contain the query (or a variant): "accidental ranker" — pin it with one S1-style rescue issue reusing S1's copy-generation + apply branch verbatim (same prompt, same classifyFix branch). This is where S2 and S1 compose: two detectors, one machine.
- **DoD:** fixture blog produces exactly the three expected families; no family fires on a clean blog; /review shows all three with working approve/dismiss; split consolidation never touches published content (assert post bodies unchanged); folded detection matches index_coverage truth table.

> **IMPLEMENTED (S2 build) — what actually shipped:** `src/lib/services/query-hygiene.ts` = four detector families in ONE pass per blog (`runQueryHygieneForBlog`, called from the gsc-sync cron right after S1's per-blog pass; one `seo_scans` row with rawData.kind='query_hygiene' + family counts). **split:** pairs ≥ HYGIENE_SPLIT_MIN_IMPRESSIONS=25/90d grouped by normalizeQueryKey, distinct pages judged on normalizeForMatch, deterministic winner via pure `pickSplitWinner` (position asc → impressions desc → url asc); fixPayload {kind:'query_split', targetQuery, winnerUrl, pages[]}; approve consolidates the ledger ONLY — losing pages' PENDING blog_keyword_targets rows → 'skipped' with failureReason `query-split:<winnerUrl>` (keyword-targets skip convention), redirect stays a human decision. **folded:** index_coverage rows where normalizeForMatch(googleCanonical) ≠ normalizeForMatch(userCanonical ?? inspectedUrl); critical/technical, recommendation only. **pin:** pairs ≤ pos 5 with ≥ HYGIENE_PIN_MIN_IMPRESSIONS=200/90d on managed posts whose stored metaTitle+metaDescription fails pure `metaContainsQuery` (token-subset of normalized forms) → EXACT S1 shape: fixPayload kind 'query_rescue' + preSnapshot BEFORE measurement, so the SAME apply branch/budgets/outcome loop carry it; proposals reuse S1's exported `generateProposalForFinding` verbatim (same prompt). **Budgets:** pin generation counts against the SAME client-day cap as page2 — both passes count `(page2:% OR pin:%)` rows with a proposal opened today (RESCUE_MAX_GENERATED_PER_RUN); apply budgets + outcome loop widened to `pin:` identically ("two detectors, one machine"). **Keys:** folded:/dead: use sha1 of normalizeForMatch(url) as `<normPage>` — full URLs don't fit issue_key varchar(255), same hash convention as search_performance.rowHash. TESTS: query-hygiene.test.ts (19 pure-core tests: key namespaces + digest stability, metaContainsQuery boundaries incl. the hyphen-JOINS-words pipeline behavior, pickSplitWinner total order).
> **Deviations:** (a) decided recommendation rows land status 'approved' (+resolvedAt/approvedBy/At) — the F4 lifecycle enum has no 'resolved' status; outcome "resolved" lives in pre_snapshot jsonb only. (b) dead's gate requires BOTH blogs.gscBackfilledAt present AND post.publishedAt ≥ 183d old (a young post on an old blog is new, not dead).

### S8 — Dead-weight triage: zero-traction pages get a decision, not a hope [~0.5 day]
Detector inside `query-hygiene.ts` (same run, same scan row): **`dead:<normPage>`** — category 'content', severity 'notice'. Rule: published post with ≥ 6 months of GSC history (`gscBackfilledAt` present) and total impressions over the FULL retained window < 50 → "no measurable search demand". Action is strictly a RECOMMENDATION for /review (humans decide merge/retarget/delete per F2): suggestedFix lists the three options with their trade-offs in one line each, plus any inbound semantic links that would need re-pointing (`findTopicalLinkRefs` against the page). No auto-merge, no auto-delete, ever. **DoD:** fixture post at 30 impressions/16mo detected; a post at 51 not detected (boundary documented, not vibes); /review approve records the decision in issue status and nothing on the live site changes until an operator executes it.

> **IMPLEMENTED (S8 build):** `detectDeadWeightPages` inside query-hygiene.ts (same run, same scan row as S2): gate 1 = blogs.gscBackfilledAt present; gate 2 = post published ≥ HYGIENE_DEAD_MIN_HISTORY_DAYS=183d ago; rule = SUM(impressions) over the FULL retained window < HYGIENE_DEAD_MAX_IMPRESSIONS=50 (per-page totals matched on normalizeForMatch). suggestedFix = merge/retarget/delete with one-line trade-offs each + inbound semantic links via `findTopicalLinkRefs` (capped: 3 findings/run get link research, 10 rows max per blog per run — the ledger is a queue, not a dump). Recommendation only; approve records the decision, nothing changes live until an operator executes.

### S7 — The 30-day sprint engine: week-by-week plans FROM live data [~1 day]
The playbook's operating rhythm, made concrete per client instead of a wall post.
**Service `src/lib/services/sprint-planner.ts` → `buildMonthlySprint(clientId)`:** reads the dossier (S6), last month's outcome rows (S1-verify), open issue ledger, and location matrix coverage; emits ONE plan: for each week W1–W4 a list of ≤5 concrete items, each tagged with its machine hook — `rescue:<issueId>` (auto-safe), `review-item:<issueId>` (human), `location-page:<targetId>` (drip will do it), or `manual:<note>` (GBP/operator). Item selection is deterministic: highest-impressions open rescues first, then critical folded/split issues, then matrix coverage gaps; ties broken by issue_key for stable plans. The plan itself is stored as a report-period artifact inside the monthly report's rawData so it survives re-renders.
**Surfaces:** (a) new "This month's sprint" section in the PDF built by `generateReportForCron` — week, items, owner (Netgrid auto / client / operator), and last month's completed-vs-planned score; (b) `(admin)/search` shows the active sprint with live completion ticks as issues resolve; (c) portal card "This month: N of M actions taken" — the client sees momentum without seeing mechanics.
**Constraint:** W2 content-depth items only appear when T23 (body-edit path) has merged; until then that slot is filled by meta + FAQ-JSON-LD suggestions, and the plan says so explicitly rather than promising edits we cannot make.
**DoD/tests:** planner output for a fixture client matches hand-computed week assignments exactly; re-running mid-month does not duplicate items (idempotent on period); a client with zero GSC data gets an honest "not enough live data — operator plan" fallback, never fabricated items; PDF section renders from stored artifact, not live recomputation.

### S3 — Service × Location page matrix + the shared claimer [~2 days]
"One page per [service]+[city]" at Netgrid scale, built on REAL data only. Uses migration 0057 (above).
**Matrix builder `src/lib/services/location-matrix.ts` → `buildLocationMatrixForClient(clientId)`:**
- Service terms from EXISTING sources only, in order: (1) the client's vertical config service list when present (`content/verticals/*`), else (2) commercial-intent rows of `client_keywords` for this client (intent detection already exists in keyword-targeting.ts).
- Places from EXISTING sources only: each blog's `blogs.city`, the client's other-blog cities (the network city-list pattern already hoisted in keyword-target-actions.ts), and `site_profiles.neighborhood` (+ `additional_areas` when present). No geocoding, no invented suburbs — a place that is not in those tables never becomes a page.
- Row = every (service × place) whose blog carries that city/area; skip rules written into the row as 'skipped' + reason: `no_local_presence` (clients.localPresence=false → informational-only rows), `already_covered` (normalizeQueryKey hit in blogCoveredQueries), `duplicate_cluster`. Priority = winnability snapshot of the service term via the existing formula — no new scoring invented.
**The shared claimer (the actual drip):** new function in actions/content-generation-actions.ts beside the existing ledger claim, e.g. `claimNextLocationTarget(blogId)` → one pending row per due blog per run, ordered by (priority asc, last_attempt_at asc NULLS FIRST) — that ordering IS the neighborhood rotation: every area gets turns over time without any new state. It MUST call `requireReadyLocalProfile` before generating (gate), force skeleton **#13** (`content/libraries/skeletons.ts`: add id 13 "Local Service Page" to SKELETONS + SkeletonId union, with the article's anatomy as its STRUCTURAL FLOW — H1 = [Service] in [Place], who-we-are paragraph from signatureFacts, service list from the real data, FAQ block via `buildArticleJsonLd`'s existing FAQPage path, local proof points only from siteProfiles/knowledge), and flow into the normal generator → publish → verify chain unchanged. Budget = `clients.locationPagesPerDay` (default 2) gated by `locationCampaignEnabled` — both already exist. The existing blog_keyword_targets claim goes through the SAME function signature so one code path owns "one targeted page per due blog".
**UI:** new `(admin)/locations` page: per-client matrix grid (services × places), status chips, coverage %, "Build matrix" button, and a live drip counter.
**DoD/tests:** builder is idempotent (re-run adds 0 rows); gate blocks an un-profiled blog with the row staying pending + reason; pagesPerDay respected exactly across two runs; existing ledger claim regression test passes byte-identical to pre-change behavior for a city blog; one dev blog publishes a real location page through the full generator chain with gate logs.

### S4 — GBP optimization packs: operator-assisted, zero credentials [~2 days]
Netgrid never touches a Google Business Profile; the operator does one paste per competitor and we hand back copy-paste-ready packs + a printable card for the client call. Uses migration 0058 (above).
**Input surface:** new tab `(admin)/clients/[id]/gbp` — per-competitor form: name, category string, attribute list, services with prices, description text, review count + a handful of review dates/ratings (paste-friendly textarea → parsed by the existing csv-parser patterns). Competitor facts land in `client_seo_dossiers.competitorProfiles` (S6 table — one home for "what we know about this client's world"). Everything stays inside the dossier; nothing is invented: a missing competitor field renders as "not provided — ask on next call".
**Generator `src/lib/services/gbp-packs.ts` → `buildGbpPacks(clientId)`** (one prompt family, seven outputs, all grounded in site_profiles + knowledge base + pasted competitor data):
1. **Categories:** primary + up to 3 secondary, ranked by which the client's REAL services support; each with a one-line "why this order" note.
2. **Attributes:** diff of (competitor union − ours) with add/remove/keep verdicts from real facts only — never mark an attribute we cannot verify as true.
3. **Services list:** every real service with a 40–60-word GBP description; cross-check note listing website services missing on GBP and vice versa (the gap IS the deliverable).
4. **Description A/B:** two versions ≤750 chars, both ending in a real CTA/area; version N+1 rows into gbp_description_versions with a 30-day rotation schedule; measurement = brand-query GSC impressions delta ONLY when that data exists, else "no measurable signal yet".
5. **Posts calendar:** 8 weekly posts, each: hook ≤100 chars, body ≤1500, CTA, suggested photo description, and a `targetUrl` = the specific website service page it should link to; week slots rotate neighborhoods from B.5's real place list, never repeating an area within 4 weeks.
6. **Photos:** audit of what exists (operator-pasted count) vs top competitor; upload queue with the filename convention `<type>-<area>-<date>.jpg` and a per-month target that beats competitor velocity by one.
7. **Reviews:** response templates banded 5★/4★/3★-and-below (each ≤80 words, no discount offers, sign-off = real business name), plus the response-time standard from S5.

**Surfaces:** packs render as a printable card in the gbp tab (one PDF page per pack via the existing pdf-renderer primitives); ops endpoint `GET /api/v1/ops/gbp-packs?clientId=&since=` (opsAuthGuard + cursor) so 396red can audit what we promised clients; portal shows a "GBP action plan: N items ready" summary line only (details stay operator-side until sent).
**DoD/tests:** generator is deterministic given the same inputs (seeded model mock); 750-char cap enforced before insert; re-generating after new competitor paste creates NEW gbp_assets rows without touching old ones; no pack text contains a fact absent from dossier/knowledge/pasted data (assert against a fixture corpus).

### S5 — Review-velocity math + response SLA [~0.5 day]
Lives inside the gbp tab, computed not generated: `monthsToParity = ceil((theirCount − ourCount) / max(1, theirRatePerMonth − ourRatePerMonth))` where rates come from pasted review-date history; edge cases explicit in UI — already ahead → "maintain mode: keep ≥ theirs' rate"; < 6 months of dates on either side → show the number BUT label it "estimate (short history)"; missing dates → no number, only a gap list. Response SLA card: target ≤24h first response, template pre-filled from S4 pack 7; per-client log table (client_id, reviewRef text, respondedAt, notes — folded into gbp_assets payload rows of type 'reviews' to avoid yet another table) so the operator can prove follow-through in renewals.

## Order + gates
**Build order: S0 → S6 → S1 → S2 → S8 → S7 → S3 → S4 → S5.** Rationale: S0 stops creating waste first; S6 grounds everything that generates copy; S1 is the proof-of-machine (detector→apply→verify→outcome) and its issue_key machinery underpins S2/S8; S7 then has real outcomes to plan from; S3 is the biggest new pipeline so it lands last with all shared machinery proven; S4/S5 depend on S6's dossier table.
**Per commit:** `npx tsc --noEmit` clean · full test suite green (existing tests included — a red legacy test is stop-the-line, not a skip) · migration applied + reverted cleanly in dev · the package's DoD above all green.
**End of session (all must pass):** migrations 0056–0059 replay on a fresh dev DB, each individually revertable; one fixture client end-to-end: S0 excludes its ranked query from ideation → S1 detects/generates/applies/verifies live with correct IndexNow event row → S2 fires split + folded → S8 flags the dead post → /review shows every row with working approve/dismiss → weekly outcome cron writes a real delta after simulated 30-day data → monthly PDF renders "Queries that moved" + sprint score + dossier page from that same client's rows; portal, v1 `rescues?since=` and ops gbp-packs endpoints return fixture data under correct auth (cron secret / session / OPS_API_KEY); F1 audit: every applied issue pageUrl ⊆ generated_posts.externalPostUrl set for WP / articles for Shopify; every new cron has a failing-shard test proving one bad blog can't kill the run; every LLM call site has a per-run budget constant.

<!-- END OF COMPACT MEGA PROMPT — build in Order above; when done, report per-package DoD status -->
