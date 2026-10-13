# MEGA PROMPT (v2, QA-verified) — next large coding session on `dre22sept`

Paste this entire document into the next coding session. Work on branch `dre22sept` or a
new branch cut from it. Written against HEAD **d0c277e**. Every file path, function name,
table/column name, enum value and pattern in §B was READ FROM THE CODE at that commit on
2026-09-23 — do not re-discover them; do trust-but-check if a name has moved. Migrations
continue from **0056** (last applied: `0055_ops_reply_keys.sql`). Ship independent commits
per package so each can be reverted alone.

**How to use this doc:** §B is the verified map — read it first, top to bottom. §C shows
how the nine packages compose into one system (the "why"). §D is the build spec: every
package has DDL, detection SQL against REAL column names, full prompt templates, the exact
apply/verify call chain, cron spec, UI routes, failure modes, and a fixture-based test
plan. Build in §G order. Nothing ships until its row in the §E rollout matrix is complete.

## A. Source material — what the two @bloggersarvesh articles actually say
Full extracted text: `docs/reference/sarvesh-chatgpt-astra-prompts.txt` (article 1, Sep 4,
2026, 3.5M views) and `docs/reference/sarvesh-grok-seo-playbook.txt` (article 2, Aug 16).

Article 1 = a 12-prompt ChatGPT "Astra" system: load business context once; audit GBP
categories/attributes/services/photos/posts/description/reviews against competitors; mine
the keyword gap; find **page-2 money pages** (positions ~11–20 with ≥100 impressions = the
highest-ROI fix in all of SEO — "you're already there, just better"); build one page per
[service]+[city] pair with a fixed anatomy. Article 2 = the same core as a repeatable
playbook: review-**velocity catch-up math** (reviews/month to reach the top competitor),
neighborhood content that rotates areas, "Google ranks pages not websites", and the
meta-claim that the moat is the SYSTEM (dossier + loop + proof), not any single prompt.

Tactics → packages map (each T lands in exactly one §D package):
| Tactic | Package |
|---|---|
| Business dossier, load once never repeat | S6 |
| GBP categories / attributes vs competitors (3 tiers) | S4-1/2 |
| GBP services cross-checked to website; 40–60-word descriptions | S4-3 |
| GBP description A/B, 750-char cap, rotate + measure | S4-4 |
| GBP posts calendar (8 weeks, neighborhood rotation) | S4-5 |
| Photo plan: beat top competitor velocity, filename convention | S4-6 |
| Review templates by star band; response-time target | S4-7 / S5 |
| Page-2 goldmine rescue loop | S1 |
| Cannibalization / query split detection | S2 |
| Google-folded (canonical disagreement) pages | S2 |
| Accidental-ranking pinning | S2 |
| Service × city page builder with fixed anatomy | S3 |
| 30-day sprint, week-by-week from live data | S7 |
| Dead-weight triage (zero impressions → merge/retarget) | S8 |
| Winnability: pick what you can win, not loudest | S0 (already half-built — see §B.4) |
| Before/after measurement as the proof layer | S1-verify (§D.1 step 4) |
| Neighborhood rotation at scale | S3/S4 (single `neighborhood` column today — see §B.5) |
| Human decision layer: humans approve redirects/canonicals, system does the rest | global constraint F2 |

## B. Verified system map (read from code at d0c277e)

### B.1 The GSC data we already have — `search_performance`
- Table (`schema.ts:1551`): one row per **(blog, date, query, page)** pair. Columns:
  `date` (string 'YYYY-MM-DD'), `query` varchar(500), `page` varchar(2048) — the full URL,
  `rowHash` varchar(64) = sha of (query,page); unique index `(blog_id, date, row_hash)`;
  `clicks int`, `impressions int`, **`position numeric(6,2)`** (already an average per row).
- Ingest (`services/gsc-sync.ts`): daily cron re-pulls a trailing ~5-day window with
  upsert (Google revises recent days), plus a one-time 16-month backfill in 30-day chunks;
  `blogs.gscLastSyncedAt` / `gscBackfilledAt` track state. **Retention ceiling: 16 months.**
- Sharding precedent: `gscShardForBlog(blogId, shardCount)` = sha1 bytes 16–23 % N — a
  blog's sync slot is deliberately uncorrelated with publish/refresh shards. New crons that
  iterate blogs must copy this pattern (read `src/app/api/cron/gsc-sync/route.ts` for the
  shard-invocation convention before writing your own). Dates are America/Los_Angeles —
  reuse `gscToday()` / `shiftDate()`, never server UTC, or you get silent zero-row days.
- **Aggregation rule (use everywhere in this session):** position is impressions-weighted:
  `SUM(position::numeric * impressions) / NULLIF(SUM(impressions),0)` — plain AVG dilutes
  high-volume pairs with long-tail noise and mis-ranks the goldmine list.

### B.2 The issue pipeline (the ONE place every detection result lands)
- `seo_scans` (`schema.ts:317`) + `seo_issues` (`schema.ts:343`). Every issue row REQUIRES
  `scanId` (FK, NOT NULL). Issue columns: `pageUrl`, **`category`** = seoCategoryEnum
  ['meta','content','technical','links','images','schema','performance'], **`severity`** =
  ['critical','warning','notice'], `title varchar(500)`, `description text`,
  `suggestedFix text`, **`fixPayload jsonb`**, **`status`** = issueStatusEnum
  ['detected','queued','approved','applied','verified','dismissed','failed'],
  `autoFixable bool`, `failureReason`, appliedAt/verifiedAt/resolvedAt. There is NO `kind`
  column — identity is (category, title convention) + fixPayload shape. Migration **0056**
  adds the missing stable identity: nullable `issue_key varchar(255)` + unique index on
  `(blog_id, page_url, issue_key)` so daily detectors upsert instead of re-detecting, and a
  row keeps its status across runs once applied/verified.
- Insertion pattern to copy (`services/post-seo-runner.ts` ~170–230): insert one `seo_scans`
  row per run (score ints are NOT NULL — GSC detectors pass 0 and put real metadata in
  `rawData jsonb`), then bulk-insert issues. **REGRESSION TRAP:** that runner DELETEs prior
  `(blogId, pageUrl)` issues with status detected/queued before re-inserting. Without a
  guard it will delete our GSC-loop issues on the next scan of the same post. The 0056
  migration ships WITH a one-line fix to that delete: add `AND issue_key IS NULL` so the
  per-post scanner only manages legacy keyless rows. Test this explicitly (see §D.1 tests).
- Apply path (`services/seo-autofix.ts`): `autoFixIssue(issueId)` — idempotent, loads blog,
  routes Shopify → `autoFixShopifyIssue`, WP → `wp.findPostByUrl(wpUrl,user,pass,pageUrl)`;
  **if the URL does not resolve to a post the fix fails** — that is our managed/unmanaged
  boundary (see F1). Dispatch via private `classifyFix(issue)` (~line 203) on existing kinds:
  'meta_title' | 'meta_description' | 'og_title' | 'og_description'. Value resolution via
  `resolveMetaValue({source, generate})` — prefers given source text (no LLM), else calls
  `generateSeoFix(...)` from claude-client. Writes through `applyMetaTitle/applyMetaDescription`
  (Yoast/RankMath by `blogs.seoPlugin`, pixel-capped via `@/lib/seo/meta-suffix` +
  `measureTitlePx`), plugin-less WP gets a JSON-LD Article fallback
  (`injectSchemaForPluginlessWp`). Then `markApplied(issueId, summary)`. S1 adds exactly ONE
  new branch here (see §D.1 step 4). Score recompute after apply: `rescanBlogScore` (same
  file, ~line 369) + `recomputeBlogQualityScore`.

### B.3 Verify / ping / telemetry chain (all exist — reuse, never rebuild)
- **Verify:** `services/wp-meta-verify.ts` → `verifyLiveMeta(...)` (+ `readHeadMeta`,
  `titleMatches`, `descriptionMatches`). S1 verification = fetch live head, compare applied
  title/description, stamp issue `verifiedAt`.
- **Ping:** `services/index-now-pinger.ts` → `pingIndexNow(...)` /
  `pingIndexNowFireAndForget(...)`. Per-blog keys on `blogs.indexnowKey(+Location)`, key file
  verified via `indexnowKeyVerifiedAt`; every attempt lands in `index_ping_events` with
  outcome ok/failed/**skipped** (skip ≠ failure — Shopify and missing-key cases are skips).
- **Cron skeleton:** routes at `src/app/api/cron/<name>/route.ts`, auth
  `verifyCronSecret(request)` from `@/lib/auth/helpers`, `maxDuration` set, per-item
  try/catch so one bad blog never kills the run, results array returned as JSON (copy
  `monthly-reports/route.ts`). Telemetry: cron_runs / pipeline_errors via run-telemetry +
  the `/pipeline` admin page already surfaces it.
- **Ops API for 396red:** `opsAuthGuard(request)` from `@/lib/api/ops-auth`, data helpers in
  `@/lib/api/ops-data`; canonical example `src/app/api/v1/ops/leads/route.ts` (GET + since/
  limit + nextSince cursor). New ops endpoints copy that shape; never expose credentials,
  prompts or costs.

### B.4 Winnability (T09) — ALREADY HALF BUILT; do not rebuild it
- `content/client-keywords.ts`: a single inspectable SQL expression computes winnability per
  row (magnitude discounted by difficulty and competition, bonused for long-tail), with
  env-tunable gates: `KEYWORD_MIN_VOLUME=20`, `KEYWORD_MAX_VOLUME=20000`,
  `KEYWORD_MAX_DIFFICULTY=35` (NULL difficulty never rejected — most rows are Autocomplete),
  `KEYWORD_NEUTRAL_DIFFICULTY=45` (scored value when unknown), `KEYWORD_MIN_CANDIDATES=5`
  (strict pass falls back to ungated pool, never empty). Ordering: measured-volume rows
  first (`evidenceTier asc`), then winnability desc. Two-pass in
  `activeClientKeywordRows(clientId, limit)`; wrappers `topActiveClientKeywords` /
  `topActiveClientKeywordsWithMeta`.
- The ledger snapshots it at build time: `blog_keyword_targets.winnability numeric(12,4)` +
  `keywordDifficulty`, built by `buildKeywordTargetsForBlogInternal` (actions/
  keyword-target-actions.ts) from embedding-clustered keywords (`clusterKey`, `variants`).
- **The real remaining gap S0 must close:** the pool is static — it knows nothing about
  where we ALREADY rank. Two concrete failures today: (1) ideation can write a NEW post for
  a query an existing page already ranks #15 on → instant cannibalization; (2) pending
  ledger rows keep their build-time priority even after GSC shows us at #3 or #40. S0 =
  make both the ideation pool and the ledger **GSC-aware** (§D.0). The documented T09 seam
  remains `rankedQueriesForClient` in `content/topic-candidates.ts` ("THIS IS THE T09 SEAM"
  comment, contract: ≤limit rows best-first, demand nullable, rank = index) — S0's pool
  filter lands inside that function body per its documented contract.

### B.5 Local content gates + target ledgers (the "never invent facts" machinery)
- `content/local-page-gate.ts` → single export **`requireReadyLocalProfile(...)`**: a local
  page may only be generated from real operator-entered facts, never the city string alone.
- `site_profiles` (`schema.ts:1660`, dre22sept): PK blogId; `neighborhood varchar(160)` —
  **SINGLE value today**, `signatureFacts jsonb[]`, `doesNot jsonb[]`, `placeNote text`.
  S4's "rotate neighborhoods" therefore rotates ONE real neighborhood + client_keywords'
  local-intent queries in v1; migration 0057 may add optional `additional_areas jsonb`
  (operator-filled, same gate applies to each) — additive only.
- Target ledgers: `blog_keyword_targets` (`schema.ts:1162`) = the generic "[keyword] in
  [city]" queue (status pending/generating/generated/failed/skipped; `localFraming`,
  `volumeScope`, `priority` lower-is-better) and `peptide_location_targets` (`schema.ts:
  1114`) = compounds × dosages × locations. **[RENAMED IN THE BUILD → see B.8: S3 shipped
  the shared ledger as `location_page_targets`, migration 0057.]** **QA FINDING — verified by full-tree search:**
  no code outside schema.ts reads or writes either table's rows in a cron; the client-side
  drip controls exist on `clients` (`locationCampaignEnabled`, `locationPagesPerDay`
  default 2, `peptideLocations`/`peptideDosages`). So S3 is not "generalize an existing
  drip" — it **builds the first target-claiming drip** and makes `blog_keyword_targets`'s
  claim path (currently claimed ad hoc by the auto-publish action per its schema comment)
  go through the same function. Both ledgers get one shared claimer; regression test on
  the existing ledger behavior is mandatory.
- `clients.localPresence` boolean (default false, deliberately not derivable): only these
  clients get city-framed transactional targets (`shouldApplyLocalFraming` in content/
  keyword-targeting.ts). S3's matrix respects it: no local presence → rows stay 'skipped'
  with reason, never generated.

### B.8 Post-build amendments (verified against code 2026-09-25, R8)
- **`peptide_location_targets` → shipped as `location_page_targets`** (migration 0057:
  `service_key` × `place_name`, status reuses `keyword_target_status`, winnability-rank
  priority, `last_attempt_at` fairness cursor). `blog_keyword_targets` unchanged; the one
  shared claimer is `claimNextTargetedPageForBlog` in
  `actions/content-generation-actions.ts`.
- **No separate `page2-rescue` / `rescue-outcomes` cron routes shipped.** S1 detect + drain
  + outcomes, S2/S8 hygiene, the S4 30-day description-rotation check and the S6 dossier
  freshness check ALL fold into `api/cron/gsc-sync` (per-blog/per-pass try/catch isolation;
  metrics in the response JSON as `rescue.*`, `hygiene.*` (+ `.open`/`.decided` since R5),
  `gbpRotation.*`, `dossierFreshness`). §I.6's failing-shard requirement therefore lands on
  the fold point — proven by `src/app/api/cron/gsc-sync-route.test.ts`. A missing dedicated
  route is NOT a bug; the fold is the trigger.
- **GBP tables = `gbp_assets` + `gbp_description_versions`** (migration 0058). The 750-char
  DB CHECK (`gbp_description_versions_body_cap`) dies with its table on revert.
- **R4 auth decision (resolves the §E "same, ops-auth" cells):** `apiAuthGuard`
  (`src/lib/api/auth.ts`) is a single shared `MARKETING_API_KEY` (app_settings or env) —
  key-based, NOT session-based, and it does NOT accept `OPS_API_KEY`. Ops audits S1/S3/S2/S8
  through the same v1 client-search cursor endpoints (`rescues=1` / `locationPages=1` /
  `hygiene=1`) with the marketing key; `/api/v1/ops/gbp-packs` keeps `opsAuthGuard` +
  `OPS_API_KEY` as shipped. Accepted deviation rather than widening apiAuthGuard (G1).
- **Migration tooling gained individual revert:** `node src/lib/db/migrate.mjs --revert 00NN`
  runs the sibling `<file>.down.sql` (exact name, name-without-extension or unique numeric
  prefix), refuses while any later migration is still applied, errors when the DOWN script
  is absent. Four DOWN scripts ship next to 0056–0059; the forward pass never sees them.

### B.6 The generation path (everything new must flow through it)
- Skeletons: `content/libraries/skeletons.ts` — `SKELETONS: Record<SkeletonId, Skeleton>`,
  ids **1–12**, each {id,name,distinctiveFeature,body template with {placeholders} +
  [BLOCK_*],sharedBlocks,affinity,tokenCostTier}; `SkeletonId` union lives in content/
  types.ts. S3's local-service page = **skeleton #13** added to the record + type, forced
  by the claimer (the ledger path already bypasses ideation with a pre-templated title —
  same mechanism).
- Uniqueness: `content/story-reuse.ts` enforces 5 story uses / 30 days and never twice on
  the same normalized query (`story_uses` table); `normalizeQueryKey` (content/
  topic-similarity) is THE dedupe key — reuse it for S2's split-query detection or variant
  queries will false-positive.
- Semantic linking exports (services/semantic-linking.ts): `findRelated`,
  **`findTopicalLinkRefs`**, **`applyRelatedLinks`**, `relinkGeneratedPost`,
  `runSemanticLinkingBackfill`. S1/S7 internal-link actions call `findTopicalLinkRefs` +
  `applyRelatedLinks` — no new linking engine.
- JSON-LD: `services/wp-seo-injector.ts` → `buildArticleJsonLd`, `renderSchemaBlock`,
  `upsertSchemaBlock(body, block)` (idempotent), `injectArticleSchema`. S3's city FAQs ride
  the existing FAQPage path; no new schema machinery.

### B.7 Surfaces that already exist (extend, don't fork)
- Admin routes: `(admin)/search` (GSC explorer — gains "Goldmine" tab), `(admin)/review`
  (issue queue — gains S2/S8 item types + approve-redirect action), `(admin)/opportunities`,
  `(admin)/seo/fix-queue`. New page: `(admin)/locations` (S3 matrix). Client header gains
  the read-only dossier block (S6); new tab `(admin)/clients/[id]/gbp` (S4/S5).
- Portal: `(portal)` client dashboard — cards added per §E. Monthly PDF: `services/
  pdf-renderer.tsx` exports **`ReportPdfData`** + `renderReportPdf(data)`; reports are built
  by `generateReportForCron(clientId, periodStart, periodEnd)` in actions/report-actions.ts
  (cron-safe variant of the admin flow) — new sections = extend ReportPdfData + that builder.
- v1 API: existing pattern at `api/v1/clients/[clientId]/search` extends for S1; ops
  endpoints under `api/v1/ops/*` per B.3.

## C. The system as a whole — why these nine pieces are one machine

The articles' real claim is that the moat is not any prompt but the loop: context →
decision → action → proof → better context. This session builds exactly that, and every
package exists because it feeds or consumes the same four data flows:

```
            ┌──────────── DATA IN (already live) ────────────┐
 GSC sync ─▶ search_performance        operator GBP tab ─▶ competitor_profiles
 site_profiles / knowledge base ──────────────────────────▶ client_seo_dossiers (S6)
                                                           │
  INTELLIGENCE: S0 winnability (B.4) + GSC-aware pool ◀────┘
          │                              │
          ▼                              ▼
  IDEATION (new posts, never    DETECTORS on live data (90d windows):
  against ranked pages)         S1 page-2 goldmine · S2 cannibal/folded/pinned
                                S8 dead weight ──────────────┐
                                                            ▼
                      ISSUE LEDGER (seo_issues + issue_key, one lifecycle:
                      detected→queued→approved→applied→verified / dismissed / failed)
                              │ auto-safe            │ human-approved (/review)
                              ▼                       ▼
  ACTION: S1 meta rescue · S2 ledger consolidation & links · S7 sprint items ·
          S3 location drip (shared claimer, gate-checked, story-cap intact)
                              │
                              ▼
  PROOF: verifyLiveMeta + IndexNow ping → before/after position deltas (S1-verify)
        → monthly PDF ("Queries that moved", sprint results, GBP pack appendix)
        → portal cards → ops endpoints for 396red oversight
                              │
                              └────────▶ feeds next cycle's dossier & winnability
```

**One client, one month (the integration test we are designing toward):** Monday — S6
refreshes the plumber's dossier from real tables. Tuesday — GSC sync lands; S0 notices the
plumber already ranks #14 for "drain cleaning old town" and keeps ideation away from it.
S1 detects that same (page, query) pair at 210 impressions/90d, generates a rescue title +
meta from the dossier, auto-applies through `autoFixIssue`, verifies live, pings IndexNow.
S2 finds two posts splitting "sewer inspection" and consolidates their ledger variants;
the canonical question waits in /review for a human. S3's drip publishes one neighborhood-
correct page/day (gate-checked against site_profiles). Thursday — the operator pastes two
competitors' GBP data into the new tab; all seven packs generate, description version 1
goes live, the review-velocity card shows "you need +9 reviews/month to reach parity in 6
months". End of month — the PDF's new pages show: 3 rescued queries with their actual
position deltas (14→7, 17→12, 19→15), 4 location pages added, sprint W1–W2 completed. The
client sees proof; the operator sees a queue that got shorter by itself; next month S0's
pool is smarter because this month's outcomes are in the dossier. THAT is what "combines
into something great" means here — no package has value alone; the PDF is where they meet.

## D. Build spec per package

### D.0 (S0) — GSC-aware ideation + live ledger re-rank  [~1 day]
Goal: stop creating competitors against our own pages; make priority reflect reality.
- **New module `src/lib/content/gsc-pool.ts`:**
  - `rankedPageQueryPairs(blogId, opts)` → the (query, page) aggregates from B.1's SQL for
    a trailing window (default 90d), impressions-weighted position, with floors:
    `minImpressions` default **50/90d** and window bounds as named constants + env override
    (`GSC_RESCUE_MIN_IMPRESSIONS`) following the client-keywords.ts envInt pattern.
  - `queriesWeAlreadyRankFor(clientId)` → normalized set via `normalizeQueryKey` of every
    query with ≥1 page in positions 3–20 (the "we have a page for this" guard).
- **S0-a pool filter:** inside `rankedQueriesForClient`'s body, after the existing covered-
  query filtering: drop candidates whose normalized key is in
  `queriesWeAlreadyRankFor(clientId)` — they are S1's job (fix), not ideation's (new post).
  Log the count; return shape unchanged (contract B.4). Unit test with a seeded
  search_performance row proves a ranked query never reaches `candidates`.
- **S0-b ledger re-rank:** new action `rerankPendingTargetsByLivePosition(blogId)` called by
  the refresh-keywords cron AFTER its existing rebuild step: for pending rows whose keyword
  (or any variant) appears in GSC data, set `priority = -1` bucket ordering — rows we rank
  top-3 on → deprioritize to bottom of new-build list (we already win); rows at 8–20 →
  move their query into S1's queue instead; document the exact comparator in code.
- **DoD:** both unit tests green + a seeded client shows zero ideation candidates that are
  live-ranked and pending ledger order matches a hand-computed expectation.

### D.1 (S1) — Page-2 goldmine rescue loop  [~3 days] — THE CROWN JEWEL
The article's highest-ROI tactic, productized end-to-end with a proof layer.

**Step 0 — Migration `0056_issue_key_and_rescue.sql`** (one migration serves S1–S2+S8):
```sql
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS issue_key varchar(255);
CREATE UNIQUE INDEX IF NOT EXISTS seo_issues_unique_idx
  ON seo_issues (blog_id, page_url, issue_key) WHERE issue_key IS NOT NULL;
-- Pre-fix snapshot for the before/after proof layer (S1-verify):
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS pre_snapshot jsonb;
```
Plus the one-line post-seo-runner delete guard from B.2 (`AND issue_key IS NULL`).

**Step 1 — Detector `src/lib/services/page2-rescue.ts`:**
`detectPage2Rescues(blog): RescueFinding[]` runs (raw SQL, real columns):
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
       BETWEEN 8.0 AND 20.4                          -- "page 2": article says 11–20; we
                                                     -- widen to 8+ for the meta-only era
ORDER BY impressions_90d DESC LIMIT 50;
```
Per pair: (a) join `generated_posts` on normalized URL — **managed** = row exists with a
platform post id → autoFixable=true; unmanaged → recommendation issue, autoFixable=false.
(b) Issue identity: `issue_key = 'page2:' || normalizeQueryKey(query)` + pageUrl = the
CANONICAL stored URL (never the raw GSC string — B.2's findPostByUrl must resolve it).
(c) Upsert with `onConflictDoNothing` on unique index; never touch rows past detected/
queued that carry a higher status. (d) One `seo_scans` row per run: category 'meta',
severity 'warning' (top-3 by impressions = 'critical'), title convention
`Page-2 rescue: "{query}" ({avg_position} avg, {impressions} imp/90d)`.

**Step 2 — Rescue copy generation (at DETECTION time, not apply time):** new prompt variant
in `services/claude-client.ts` beside `generateSeoFix`, named `generateRescueMeta({
query, avgPosition, impressions90d, currentTitle, currentDescription, pageExcerpt,
niche, siteFacts })`. Full template (interpolated fields from the S6 dossier — real data
only, gaps stated as gaps):
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
ends with a soft CTA matching the business's real service area; no keywords stuffing, no
em-dash spam. Output JSON: {"title": "...", "description": "..."}
```
Store in `fixPayload`: `{kind:'query_rescue', targetQuery, proposedTitle,
proposedDescription, windowDays:90}` and `preSnapshot` (B.1 aggregation at detection time:
{avgPosition, impressions90d, clicks90d, capturedAt}). If the model call fails, still open
the issue with proposal=null — apply falls back to `generateSeoFix` today's path.

**Step 3 — Apply:** new branch in `classifyFix` (seo-autofix.ts ~203): kind 'query_rescue'
→ use `fixPayload.proposedTitle/proposedDescription` when present (deterministic, zero LLM
at apply time), else the existing generate path; then the SAME writers: pixel caps via
`measureTitlePx`/`capMetaDescription`, brand suffix only for yoast/rankmath (copy lines
507–513), `applyMetaTitle` + `applyMetaDescription`, plugin-less WP JSON-LD fallback,
Shopify → existing metafield path. After apply: `rescanBlogScore` +
`recomputeBlogQualityScore` + `pingIndexNowFireAndForget(postUrl)` (event lands in
index_ping_events; missing key/Shopify = 'skipped', not error). WP pre-check: if
`seoPlugin='yoast' AND seoBridgeVersion IS NULL`, the REST meta write is silently dropped
(B.2) — route those to the JSON-LD fallback + a /review note instead of claiming success.

**Step 4 — Verify + BEFORE/AFTER PROOF LAYER (what makes this a system, not a script):**
- Immediate verify (same run): `verifyLiveMeta(...)` on the applied post → status 'verified'
  when live head matches; mismatch after apply = status 'failed', failureReason with the
  diff. This catches dropped Yoast writes that B.2's pre-check couldn't predict.
- **Outcome loop:** new cron `src/app/api/cron/rescue-outcomes/route.ts` (weekly): for
  issues in ('applied','verified') whose appliedAt is ≥ 28 days old, re-run the pair's
  30-day aggregation; write into `pre_snapshot.outcome = {afterPosition, afterImpressions,
  deltaPositions, measuredOverDays}` and set status 'resolved' when improved-or-stable.
  The monthly report builder (B.7) reads these rows for the **"Queries that moved"** PDF
  section: one row per resolved rescue — query, page, before → after position, impressions
  trend, applied date. This is the renewal-conversation artifact; it must never show a
  delta without both measurements actually present (honest-skip rule).

**Step 5 — Cron `src/app/api/cron/page2-rescue/route.ts`:** verifyCronSecret + maxDuration
300; shard handling copied from gsc-sync route (N shards, one per invocation); candidates =
`blogs.status='active' AND gsc_backfilled_at IS NOT NULL`, oldest-gscLastSyncedAt first
(same fairness logic as the sync cron — a blog without fresh GSC data produces stale
rescues). Per-run budgets: ≤ 5 rescues generated (LLM cost), ≤ 3 applied per blog, ≤ 15
applied network-wide; every budget is an envInt with safe defaults. A blog's daily apply
budget must also respect the existing autofix budgets in seo-autofix.ts — check them first
and take the minimum.

**Step 6 — Surfaces:** `(admin)/search` gains a "Goldmine" tab (top pairs per client,
positions + impressions + issue status chip); `/review` lists page2 issues with one-click
Approve for auto-safe ones and an explicit "apply recommendation manually" note for
unmanaged URLs; portal card `Search improvements this month: N queries rescued (avg ΔX
positions)` reading the same outcome rows; v1 API extends
`api/v1/clients/[clientId]/search` with a `rescues?since=` cursor endpoint (ops-auth shape).

**Step 7 — Tests (fixture-based, no network):** seed search_performance rows for a fake
blog: pair A (query "drain cleaning old town", page /blog/x, 210 imp/90d @ pos 14.2), pair B
(30 imp → below floor, must NOT detect), pair C (pos 5 → out of window), pair D on an
unmanaged URL (→ recommendation issue). Assert: detection set = {A managed, D unmanaged};
issue_key idempotent across two runs; post-seo-runner delete leaves keyed rows intact;
classifyFix branch picks stored proposal without calling the model (mock claude-client and
assert zero calls); verify step flips status on matched/mismatched live meta.

### D.2 (S2) — Query hygiene: splits, Google-folded, accidental ranks  [~1.5 days]
Detector `src/lib/services/query-hygiene.ts`, same scan-row/upsert pattern as S1, three
issue families (all keyed, all category-accurate per the enum in B.2):
1. **`split:<normQuery>`** — category 'content', severity 'warning'. SQL: group the 90d
   pairs by `normalizeQueryKey(query)`; flag when ≥2 DISTINCT pages each clear a lower
   floor (≥ 25 imp/90d) for the same normalized query → "two posts split one query".
   fixPayload: both pages' URLs + their per-page impressions-weighted positions. Action is
   LEDGER-ONLY until T23 lands: consolidate `blog_keyword_targets` variants onto the
   stronger page (mark loser row 'skipped', reason 'query-split:<winnerUrl>') and queue a
   canonical/redirect RECOMMENDATION for /review — **humans approve redirects** (F2).
2. **`folded:<normPage>`** — category 'technical', severity 'critical' when googleCanonical
   ≠ userCanonical on `index_coverage` rows (the schema comment calls this "the single most
   diagnostic pair" — we are building exactly what that column was made for). SuggestedFix
   names the folded-into URL; action = recommendation only.
3. **`pin:<normQuery>`** — category 'meta', severity 'notice'. Query at position ≤ 5 with
   ≥ 200 imp/90d but whose post's stored meta does not contain the query (or a variant):
   "accidental ranker" — pin it with one S1-style rescue issue reusing D.1 step 2–4
   verbatim (same prompt, same apply branch). This is where S2 and S1 compose: two
   detectors, one machine.
- **DoD:** fixture blog produces exactly the three expected families; no family fires on a
  clean blog; /review shows all three with working approve/dismiss; split consolidation
  never touches published content (assert post bodies unchanged).

### D.3 (S3) — Service × Location page matrix + the shared claimer  [~2 days]
The article's "one page per [service]+[city]" at Netgrid scale, built on REAL data only.

**Migration `0057_location_page_targets.sql`:**
```sql
CREATE TABLE location_page_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blog_id uuid NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_key varchar(255) NOT NULL,      -- normalized commercial term
  place_name varchar(160) NOT NULL,       -- a REAL place from the sources below
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
-- Optional multi-area support (B.5): operator-filled, same gate per area:
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS additional_areas jsonb;
```
**Matrix builder `src/lib/services/location-matrix.ts` → `buildLocationMatrixForClient(clientId)`:**
- Service terms come from EXISTING sources only, in order: (1) the client's vertical config
  service list when present (`content/verticals/*`), else (2) commercial-intent rows of
  `client_keywords` for this client (intent filter already exists in keyword-targeting.ts).
- Places come from EXISTING sources only: each blog's `blogs.city`, the client's other-blog
  cities (the network city-list pattern already hoisted in keyword-target-actions.ts), and
  `site_profiles.neighborhood` (+ `additional_areas` when present). No geocoding, no
  invented suburbs — a place that is not in those tables never becomes a page.
- Row = every (service × place) whose blog carries that city/area; skip rules written into
  the row as 'skipped' + reason: `no_local_presence` (clients.localPresence=false →
  informational-only rows, localFraming=false), `already_covered` (normalizeQueryKey hit in
  blogCoveredQueries), `duplicate_cluster`. Priority = winnability snapshot of the service
  term via B.4's existing formula — no new scoring invented.
**The shared claimer (the actual drip):** new function in actions/content-generation-actions.ts
beside the existing ledger claim, e.g. `claimNextLocationTarget(blogId)` → one pending row
per due blog per run, ordered by (priority asc, last_attempt_at asc NULLS FIRST) — that
ordering IS the neighborhood rotation: every area gets turns over time without any new
state. It MUST call `requireReadyLocalProfile` before generating (B.5 gate), force skeleton
#13 (`content/libraries/skeletons.ts`: add id 13 "Local Service Page" with the article's
anatomy as its STRUCTURAL FLOW — H1 = [Service] in [Place], who-we-are paragraph from
signatureFacts, service list from the real data, FAQ block via `buildArticleJsonLd`'s
existing FAQPage path, local proof points only from siteProfiles/knowledge), and flow into
the normal generator → publish → verify chain unchanged. Budget = clients.locationPagesPerDay
(default 2) gated by locationCampaignEnabled — both already exist (B.5). The existing
blog_keyword_targets claim goes through the SAME function signature so one code path owns
"one targeted page per due blog".
**UI:** new `(admin)/locations` page: per-client matrix grid (services × places), status
chips, coverage %, "Build matrix" button, and a live drip counter. **DoD/tests:** builder is
idempotent (re-run adds 0 rows); gate blocks an un-profiled blog with the row staying
pending + reason; pagesPerDay respected exactly across two runs; existing ledger claim
regression test passes byte-identical to pre-change behavior for a city blog.

### D.4 (S4) — GBP optimization packs: operator-assisted, zero credentials  [~2 days]
Netgrid never touches a Google Business Profile; the operator does one paste per competitor
and we hand back copy-paste-ready packs + a printable card for the client call.

**Migration `0058_gbp_packs.sql`:**
```sql
CREATE TABLE gbp_assets (            -- one generated pack row, re-generated on demand
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asset_type varchar(32) NOT NULL,   -- categories|attributes|services|description|posts|photos|reviews
  payload jsonb NOT NULL,            -- the full pack (see generators below)
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
**Input surface:** new tab `(admin)/clients/[id]/gbp` — per-competitor form: name, category
string, attribute list, services with prices, description text, review count + a handful of
review dates/ratings (paste-friendly textarea → parsed by the existing csv-parser patterns).
Competitor facts land in `client_seo_dossiers.competitorProfiles` (S6 table — one home for
"what we know about this client's world"). Everything stays inside the dossier; nothing is
invented: a missing competitor field renders as "not provided — ask on next call".
**Generator `src/lib/services/gbp-packs.ts` → `buildGbpPacks(clientId)`** (one prompt family,
seven outputs, all grounded in site_profiles + knowledge base + pasted competitor data):
1. **Categories:** primary + up to 3 secondary, ranked by which the client's REAL services
   support; each with a one-line "why this order" note.
2. **Attributes:** diff of (competitor union − ours) with add/remove/keep verdicts from real
   facts only — never mark an attribute we cannot verify as true.
3. **Services list:** every real service with a 40–60-word GBP description; cross-check note
   listing website services missing on GBP and vice versa (the gap IS the deliverable).
4. **Description A/B:** two versions ≤750 chars, both ending in a real CTA/area; version N+1
   rows into gbp_description_versions with a 30-day rotation schedule; measurement = brand-
   query GSC impressions delta ONLY when that data exists, else "no measurable signal yet".
5. **Posts calendar:** 8 weekly posts, each: hook ≤100 chars, body ≤1500, CTA, suggested
   photo description, and a `targetUrl` = the specific website service page it should link to
   (article prompt 6's "each post links to one page"); week slots rotate neighborhoods from
   B.5's real place list, never repeating an area within 4 weeks.
6. **Photos:** audit of what exists (operator-pasted count) vs top competitor; upload queue
   with the filename convention `<type>-<area>-<date>.jpg` and a per-month target that beats
   competitor velocity by one.
7. **Reviews:** response templates banded 5★/4★/3★-and-below (each ≤80 words, no discount
   offers, sign-off = real business name), plus the response-time standard from S5.
**Surfaces:** packs render as a printable card in the gbp tab (one PDF page per pack via the
existing pdf-renderer primitives); ops endpoint `GET /api/v1/ops/gbp-packs?clientId=&since=`
(opsAuthGuard + cursor, B.3) so 396red can audit what we promised clients; portal shows a
"GBP action plan: N items ready" summary line only (details stay operator-side until sent).
**DoD/tests:** generator is deterministic given the same inputs (seeded model mock);
750-char cap enforced before insert; re-generating after new competitor paste creates NEW
gbp_assets rows without touching old ones; no pack text contains a fact absent from dossier/
knowledge/pasted data (assert against a fixture corpus).

### D.5 (S5) — Review-velocity math + response SLA  [~0.5 day]
Lives inside the gbp tab, computed not generated: `monthsToParity = ceil((theirCount −
ourCount) / max(1, theirRatePerMonth − ourRatePerMonth))` where rates come from pasted
review-date history; edge cases explicit in UI — already ahead → "maintain mode: keep ≥
theirs' rate"; < 6 months of dates on either side → show the number BUT label it
"estimate (short history)"; missing dates → no number, only a gap list. Response SLA card:
target ≤24h first response, template pre-filled from S4 pack 7; per-client log table
(client_id, reviewRef text, respondedAt, notes — folded into gbp_assets payload rows of
type 'reviews' to avoid yet another table) so the operator can prove follow-through in
renewals — the proof-layer principle applied off-site.

### D.6 (S6) — Client SEO dossier: migrate scratch prompts into server-side data  [~1 day]
Every generated artifact in this session must be grounded in ONE per-client fact sheet,
never re-asked and never invented. Today that context lives in operator chat prompts; it
becomes a table + a read path.

**Migration `0059_client_seo_dossiers.sql`:**
```sql
CREATE TABLE client_seo_dossiers (
  client_id uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  business_model text,               -- what they actually sell & how (operator-verified)
  service_area jsonb NOT NULL DEFAULT '[]',   -- REAL places only (B.5 sources)
  differentiators jsonb NOT NULL DEFAULT '[]',-- from site_profiles.signatureFacts + KB
  audience text,                     -- who buys, what they fear, what they compare us to
  competitor_profiles jsonb NOT NULL DEFAULT '[]', -- S4 pasted data lives HERE (B.7/D.4)
  recent_wins jsonb NOT NULL DEFAULT '[]',        -- resolved rescues + sprint outcomes (S1-verify feeds this!)
  gaps text,                         -- honest "we do not know" list — prompts must print it as a gap
  last_verified_at timestamp,        -- freshness stamp; stale (>90d) dossiers say so in output
  updated_at timestamp NOT NULL DEFAULT now()
);
```
**Service `src/lib/services/client-dossier.ts`:** `getDossierForClient(clientId)` → merged
view: dossier row + site_profiles facts + top live GSC pairs (S0 module) + open issue counts
+ last sprint state; `buildDossierContextBlock(dossier)` → the single text block injected at
the TOP of every prompt this session adds (rescue meta, GBP packs, location pages, sprint
plans). Rules: nulls render as "not provided — do not invent"; stale stamp renders a warning
line; the block is ≤ ~1200 tokens by construction (truncation order: competitor → wins →
audience → area; differentiators and business_model never truncate). Admin surface: the
dossier editor lives in the client header per B.7 (read-only for portal); every edit stamps
last_verified_at. **DoD/tests:** context block is byte-stable for a fixture dossier
(deterministic ordering, no timestamps inside), truncation order holds at 1200 tokens, and
the three prompt consumers (S1/S3/S4) all receive the identical block from one function —
assert by spying on `buildDossierContextBlock` in each consumer's test.

### D.7 (S7) — The 30-day sprint engine: week-by-week plans FROM live data  [~1 day]
Article 2's operating rhythm, made concrete per client instead of a wall post.
**Service `src/lib/services/sprint-planner.ts` → `buildMonthlySprint(clientId)`:** reads the
dossier (D.6), last month's outcome rows (S1-verify), open issue ledger, and location matrix
coverage; emits ONE plan: for each week W1–W4 a list of ≤5 concrete items, each tagged with
its machine hook — `rescue:<issueId>` (auto-safe), `review-item:<issueId>` (human),
`location-page:<targetId>` (drip will do it), or `manual:<note>` (GBP/operator). Item
selection is deterministic: highest-impressions open rescues first, then critical folded/
split issues, then matrix coverage gaps; ties broken by issue_key for stable plans. The plan
itself is stored as a report-period artifact inside the monthly report's rawData so it
survives re-renders. **Surfaces:** (a) new "This month's sprint" section in the PDF built by
`generateReportForCron` — week, items, owner (Netgrid auto / client / operator), and last
month's completed-vs-planned score; (b) `(admin)/search` shows the active sprint with live
completion ticks as issues resolve; (c) portal card "This month: N of M actions taken" —
the client sees momentum without seeing mechanics. **Constraint:** W2 content-depth items
only appear when T23 (body-edit path) has merged; until then that slot is filled by meta +
FAQ-JSON-LD suggestions, and the plan says so explicitly rather than promising edits we
cannot make. **DoD/tests:** planner output for a fixture client matches hand-computed week
assignments exactly; re-running mid-month does not duplicate items (idempotent on period);
a client with zero GSC data gets an honest "not enough live data — operator plan" fallback,
never fabricated items.

### D.8 (S8) — Dead-weight triage: zero-traction pages get a decision, not a hope  [~0.5 day]
Detector inside `query-hygiene.ts` (same run, same scan row): **`dead:<normPage>`** —
category 'content', severity 'notice'. Rule: published post with ≥ 6 months of GSC history
(`gscBackfilledAt` present) and total impressions over the FULL retained window < 50 →
"no measurable search demand". Action is strictly a RECOMMENDATION for /review (humans
decide merge/retarget/delete per F2): suggestedFix lists the three options with their
trade-offs in one line each, plus any inbound semantic links that would need re-pointing
(`findTopicalLinkRefs` against the page). No auto-merge, no auto-delete, ever. **DoD:**
fixture post at 30 impressions/16mo detected; a post at 51 not detected (boundary is
documented, not vibes); /review approve records the decision in issue status and nothing on
the live site changes until an operator executes it.

## E. Rollout matrix — nothing ships until its row is complete
| Package | Admin UI | Portal | PDF section | v1 API | Ops API | Cron(s) | Telemetry |
|---|---|---|---|---|---|---|---|
| S0 GSC-aware pool | (search tab note "N ranked queries excluded from ideation") | — | — | — | — | refresh-keywords step | run-telemetry counter |
| S1 page-2 rescue | /search Goldmine + /review rows | "Queries rescued this month" card | **Queries that moved** (before→after) | `rescues?since=` cursor | same, ops-auth | page2-rescue (daily, sharded), rescue-outcomes (weekly) | cron_runs + pipeline_errors on every failure class |
| S2 query hygiene | /review rows ×3 families | — | consolidated under sprint notes | — | — | inside page2-rescue run (one detector pass, three families) | same |
| S3 location matrix | **/locations** page | "N service-area pages this month" | coverage % line | `location-pages?since=` | same | shared claimer in auto-publish (no new cron) | per-claim outcome logged |
| S4 GBP packs | client gbp tab + printable cards | "GBP action plan: N ready" | appendix page when packs sent | — | **gbp-packs** cursor endpoint | 30-day description rotation check (folds into rescue-outcomes weekly run) | generation cost counted in dataforseo_runs-adjacent log only if we spend money (we don't here) |
| S5 review velocity | gbp tab cards + SLA log | — | renewal one-liner when ahead/behind parity | — | same endpoint, type=reviews | — | — |
| S6 dossier | client header editor block | read-only summary line | "What we know about your business" (first page) | — | same | dossier freshness check in weekly run | stale-dossier counter |
| S7 sprints | /search sprint view with ticks | "This month: N of M actions" | **This month's sprint** + last-month score | — | same | plan built inside monthly-reports cron (existing) | plan-completion rate |
| S8 dead weight | /review rows | — | under sprint notes | — | — | inside page2-rescue run | detected-vs-decided ratio |

Parity rule: a package that writes to the ledger MUST appear in /review, in at least one
client-facing surface (portal or PDF), and in ops API output — operator-only features are
allowed only for S4/S5 inputs.

Post-build resolution (2026-09-25): S8's telemetry cell is REAL — per-family
detected-vs-decided counts (`hygieneLedgerTelemetry`) in the gsc-sync response
(`hygiene.open` / `hygiene.decided`) and as a one-line summary on the /review GSC-loop
card (omits while the ledger is empty, F8). S2/S8's v1 API "—" cells are CLOSED IN CODE by
the `?hygiene=1` cursor mode on `GET /api/v1/clients/[clientId]/search` (open + decided
hygiene rows, public fields only, same cursor conventions as `rescues=1`). The S1/S3 ops
cells reading "same, ops-auth" are resolved by the §B.8 R4 auth decision.

## F. Hard constraints (violating any one = rework)
- **F1 Managed/unmanaged boundary:** auto-apply ONLY when the URL resolves through the
  existing apply chain (`wp.findPostByUrl` for WP, platform-client article id for Shopify).
  Anything else becomes a recommendation issue with copy-paste-ready text. Never guess a
  post from a partial match; never edit pages Netgrid did not publish.
- **F2 Human decision layer:** redirects, canonical changes, merges/deletes, and any GBP
  action stay in /review or the gbp tab for a human. Auto-safe = idempotent meta/link/ledger
  writes only, all budgeted (S1 step 5 budgets are the template: per-blog AND network caps).
- **F3 Real data only:** every generated sentence must trace to site_profiles, knowledge
  base, client_seo_dossiers, or operator-pasted input. Missing fact → "not provided — do not
  invent" in output. Tests assert against fixture corpora (D.4 DoD is the model).
- **F4 One ledger:** every detection result lands in seo_issues with issue_key; no parallel
  status tables. The lifecycle enum is fixed (B.2); new states are a discussion, not a code
  change.
- **F5 Reuse or justify:** GSC reads via search_performance + B.1's weighted-position rule;
  dedupe via normalizeQueryKey; linking via semantic-linking exports; JSON-LD via
  wp-seo-injector; pings via index-now-pinger (skip ≠ fail); crons via verifyCronSecret with
  per-item isolation; ops endpoints via opsAuthGuard. A new mechanism needs a comment citing
  why the existing one cannot do the job.
- **F6 Migrations:** sequential numbers only (0056→), additive first — anything destructive
  gets its own later migration with a data-check query in the file header. Run through
  `db/migrate.mjs` conventions; never hand-edit applied history.
- **F7 Budgets & cost:** LLM calls per run are capped and env-tunable (client-keywords.ts
  envInt pattern); DataForSEO spend stays at zero this session unless the operator approves
  a specific query — nothing here requires paid data.
- **F8 Honesty in output:** every client-facing number needs both measurements behind it;
  estimates are labeled as estimates with their window; "no measurable signal yet" is a
  valid, expected UI state — never backfill silence with guesses.

## G. Execution order + per-package Definition of Done
Order (each step's DoD must be green before the next starts):
**S0 → S6 → S1 → S2 → S8 → S7 → S3 → S4 → S5.** Rationale: S0 stops creating waste first;
S6 grounds everything that generates copy; S1 is the proof-of-machine (detector→apply→
verify→outcome) and its issue_key machinery is a dependency of S2/S8; S7 then has real
outcomes to plan from; S3 is the biggest new pipeline so it lands last with all shared
machinery proven; S4/S5 are operator-facing and depend on S6's dossier table.

Global DoD per commit: `tsc --noEmit` clean, full test suite green (existing tests included —
a red legacy test is a stop-the-line event, not a skip), migration applied + reverted cleanly
in dev, no console.warn added without a reason comment, and the package's §D test list green.

Per-package DoD checklist (all must hold):
- **S0:** ranked query never reaches ideation candidates (test); pending ledger re-rank
  matches hand-computed order (test); zero behavior change for clients with no GSC data.
- **S6:** context block byte-stable + ≤1200 tokens (tests); all three consumers share one
  builder (spy test); editor stamps last_verified_at on save.
- **S1:** D.1 step-7 fixture suite green end-to-end including the post-seo-runner coexistence
  test; one real dev-client blog runs detect→apply→verify live with correct IndexNow event
  row; Goldmine tab, /review rows, portal card, PDF section and v1 endpoint all render from
  that same run's data (one fixture client proves the whole column of §E).
- **S2:** three families fire on fixtures, none on a clean blog; split action touches ledger
  only; folded detection matches index_coverage truth table.
- **S8:** boundary tests at 49/50/51 impressions; decision recorded without site change.
- **S7:** deterministic plan (test); idempotent mid-month re-run; honest fallback for no-data
  clients; PDF section renders from stored artifact, not live recomputation.
- **S3:** D.3 DoD list green including the byte-identical legacy-claim regression test; one
  dev blog publishes a real location page through the full generator chain with gate logs.
- **S4/S5:** D.4/D.5 DoD lists green; printable card renders all seven packs; ops endpoint
  returns cursor-paginated output for a fixture client.

## H. What NOT to build + risk register + rollback

**Not in this session (explicitly):** body/content editing of published posts (T23-gated —
meta, JSON-LD suggestions and ledger moves only); any GBP write automation or Google OAuth;
DataForSEO Local Pack purchases (only if the operator approves inside the $20 cap after S1's
first outcome cycle proves the loop); new embedding models or vector changes; multi-language
sprint planning (EN first, FR later); client self-serve issue approval (operators approve in
/review; portal is read-only for decisions).

**Risk register (risk → mitigation already embedded above):**
| Risk | Where it bites | Mitigation |
|---|---|---|
| GSC data lag/revision changes a "goldmine" after we act on it | S1 apply targets stale data | 90d window + impressions floor dampen single-day noise; outcome loop (S1-verify) measures truth at day ≥28 and the PDF shows only real deltas (F8) |
| post-seo-runner delete wipes keyed issues | every scan of a rescued post | B.2 one-line guard + explicit coexistence test in S1 DoD |
| Yoast REST meta write silently dropped (no bridge plugin) | S1 apply claims success it didn't earn | seoBridgeVersion pre-check → JSON-LD fallback; verifyLiveMeta is the final arbiter, mismatch = failed with diff |
| Cannibalization false positives from query variants ("buy X" vs "buy x online") | S2 split family | normalizeQueryKey everywhere (F5); per-page floor 25 imp keeps low-signal pairs out |
| Location pages become thin doorway content at matrix scale | S3 drip | gate requireReadyLocalProfile, skeleton #13 fixed anatomy, story-reuse cap intact, pagesPerDay budget, no invented places (B.5) |
| GBP packs contain unverifiable claims about the client | D.4 output | F3 fixture-corpus assertion: every fact must trace to dossier/knowledge/paste; gaps render as "not provided" |
| Sprint plans promise body edits T23 can't deliver yet | S7 W2 slot | explicit T23 gate in plan text (D.7 constraint) |
| Outcome math looks like fabricated ROI on thin data | PDF "Queries that moved" | both measurements required, window labeled, <28d rows excluded, no delta without data (F8) |
| Detector cost blowout on a large network | page2-rescue cron | sharding copied from gsc-sync, per-blog + network budgets env-tunable, LLM only at detection with ≤5/run default |

**Rollback:** each package is an independent commit; migrations are additive (0056–0059) so
reverting code never needs a schema rollback — the unique partial index in 0056 tolerates
both old and new writers. Feature-level kill switches: S1/S2 detectors read their floors and
budgets from env (set minImpressions absurdly high to disable); S3 drip respects the
existing clients.locationCampaignEnabled flag; sprints render "no plan" when the planner's
inputs are empty.

## I. End-of-session verification checklist (run ALL before declaring done)
1. `npx tsc --noEmit` clean; full test suite green with zero new skips.
2. Migrations 0056–0059 applied in order on a fresh dev DB and each individually reverted
   without error; `db/migrate.mjs` state matches schema.ts additions (drizzle definitions
   added for every new table/column — the repo keeps both in lockstep).
3. One fixture client end-to-end replay: S0 excludes its ranked query from ideation → S1
   detects, generates, applies, verifies → S2 finds its split + fold → S8 flags its dead
   post → /review shows every row with working approve/dismiss → weekly outcome cron writes
   a real delta after simulated 30-day data → monthly PDF renders Goldmine outcomes, sprint
   score and dossier page from that same client's rows.
4. Portal, v1 API cursor endpoints (rescues, location-pages) and ops gbp-packs endpoint all
   return the fixture client's data with correct auth (cron secret / session / OPS_API_KEY).
5. No package wrote to a live dev blog outside its managed-URL boundary (F1 audit: diff of
   applied issue pageUrls ⊆ generated_posts.externalPostUrl set for WP, articles for Shopify).
6. Every new cron appears in pipeline telemetry with a failing-shard fixture test proving
   one bad blog cannot fail the run; every LLM call site has a per-run budget constant.
7. Docs updated: this file's §B map amended if any name moved during implementation, and
   `docs/` gets a short "SEO loop v1" page linking the packages for future sessions.

<!-- END OF MEGA PROMPT — implement in §G order; when done, report per-package DoD status -->










