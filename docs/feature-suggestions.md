# Feature suggestions — next cycle

Written against `main` at `f6bfca5` (2026-09-22, merge of PR #140).
This is a product brief, not a remediation SOP. It does not restate T23–T26.

## What is already built (do not re-propose)

NetGrid is an internal operator console plus a client portal for a multi-site
content network (WordPress + Shopify). Generation, publishing, keyword
targeting, Search Console, IndexNow, semantic internal links, author entities,
a real quality score, monthly PDFs, and a read-only marketing API are all in.

Already shipped, so these are not "new features":

- DataForSEO keyword pull, winnability ranking, city/keyword ledger
- Search Console sync (`search_performance`, `index_coverage`) and PageSpeed vitals
- IndexNow + sitemap submission, per-blog keys
- Scrubber publish gate (`SCRUBBER_ENFORCEMENT`)
- Real quality score (indexation / search / duplication / CWV / tag hygiene) — T19
- Author entities, FAQ + JSON-LD, cadence as one `posting_plan`
- Link exchange is **retired**. Do not build on it.
- Netgrid-side pageview pixel is **retired** (2026-09-08). Traffic is historic only.

Still the developer's current job, not a feature request:

| Left | What |
|---|---|
| T23 | Parser-based HTML post-processor (regex steps corrupt published HTML) |
| T25 | Autofix hardening |
| T24 | robots / canonicals / hreflang / publish jitter |
| T26 | Image pipeline |
| Ops | PageSpeed key + vitals backlog, and verify `search_performance.page` matches `generated_posts.external_post_url` byte for byte. Until both happen, T19 scores NULL everywhere and the portal honestly shows "—". |
| Small follow-up already named in the handoff | Apply the T09 winnability score to `rankedQueriesForClient` in `topic-candidates.ts`. The ledger uses it; the ideation seam does not. |

Do not start the features below until T23 has landed. It rewrites the chain every generated post passes through.
## P1 — Search performance the client can actually see

**Why.** T04 already stores clicks, impressions, and position per blog / date / query / page. The only reader is the quality-score rollup (`src/lib/services/quality/gsc-signals.ts`). Admin dashboard, portal, monthly PDF, and `/api/v1` never show a query, a position, or a click. The marketing API still returns historic pixel views and tells callers not to trust them. Clients are paying for rankings and cannot see rankings.

**Build.**

1. Admin: per-blog and per-client Search tab. Top queries (28d), clicks, impressions, avg position, indexed vs not-indexed post counts from `index_coverage`. Trend vs the previous 28d.
2. Portal: the same numbers, scoped to the logged-in client. Replace the "Network SEO Score" card as the hero metric once scores are non-null; until then this tab is the only honest performance view.
3. Monthly PDF: one page of "queries that moved" (gainers / losers by position, minimum impression floor so 3-impression noise does not lead the report).
4. Marketing API: `GET /api/v1/clients/{id}/search` with the same shape. Stop leading `/summary` with retired `views` / `clicks`, or label them `historicViews` so the marketing app cannot mistake a flat line for a collapse.

**Done when.** A client can open the portal and name their top query and whether position improved this month, without opening Search Console. A URL-join miss (the T19 operator check) shows as "not matched", not as zero.

**Do not.** Re-fetch GSC from the page render. Read the tables the cron already fills. Do not invent a rank-tracker vendor while this data is unused.

## P1 — Review queue that the gate can actually land in

**Why.** T07 holds a flagged post instead of publishing it, and the code comments say "the review queue filters on `flagged_for_review`". There is no such screen. `/all-posts` filters on status only (`all | active | failed | ready | working`). A held post is a `generated` row with `flagged_for_review = true` and a scrubber report, mixed into "Ready to publish". At network scale that is a silent backlog: the gate works, nobody is shown the pile.

**Build.**

1. `/all-posts?filter=held` (and a sidebar badge with the count).
2. Row shows domain, client, scrubber summary (the one-liner `scrubberSummary()` already builds), verdict, and age.
3. Actions that already exist: release via the ungated publish path, regenerate, dismiss the flag. Do not add a second publish function — `publishGeneratedPost` is intentionally ungated so a reviewer can release.
4. Alert when a hold is older than N days (reuse `pipeline-alerts` / `alert_log`, do not invent a mailer).

**Done when.** An operator can clear the day's holds without SQL, and a hold older than the threshold shows up in the existing alert channel.

**Do not.** Build a client-facing approval workflow in the same change. That is P2 and has a different trust model.

## P1 — Opportunity inbox (act on data you already rank)

**Why.** Ideation now picks an angle over a demand-ranked, de-duplicated candidate list, then publishes on the cadence. The operator never sees the list, never rejects a bad target, and never learns why a blog has nothing left to say. `blog_keyword_targets` and `blog_covered_queries` are the ledger; there is no UI on either.

**Build.**

1. Per-blog "Next targets" panel: next N pending ledger rows with keyword, city (only if `local_presence`), winnability, difficulty, volume, and why it ranked.
2. Operator actions: skip (with reason), pin to next publish, mark covered without generating.
3. Empty state that says which guard fired: no keywords, refresh failing (`keywords_refresh_failures`), city required but unset, or every candidate already covered. Today those failures are activity-log rows and easy to miss.
4. Network view: blogs with an empty candidate pool, sorted by days since last published post. That is the "this site will go silent" list.

**Done when.** An operator can explain, for any blog, what it will publish next and why, and can stop a bad target before the cron spends a generation on it.
## P2 — Content decay and cannibalization, driven by GSC

**Why.** The network's failure mode is no longer "we didn't publish". It is "we published, it is indexed, and it is invisible or fighting a sibling". T19 scores that. Nothing proposes an action. There is no refresh path that says "this URL lost 10 positions, update it" rather than "write another article".

**Build.**

1. A weekly cron (same `verifyCronSecret` + Render cron pattern) that emits a work list, not a rewrite:
   - Indexed + impressions above the volume floor + position worse than 20 for 28d → refresh candidate.
   - Two live posts on the same blog sharing a query with material impressions → cannibalization candidate. Use `blog_covered_queries` plus `search_performance.query`, not title similarity.
   - `not_indexed` past a maturity window → indexing failure, separate from "write more".
2. Admin queue with the evidence (query, position delta, the two URLs). Actions: queue a regenerate of the existing post, noindex/consolidate (only after T24 canonicals exist), or dismiss.
3. Never auto-publish a refresh. A refresh changes a URL Google already knows; that is a human decision until the queue has been watched for a month.

**Done when.** The weekly list is non-empty on a property that has GSC data, each row cites the query and the two URLs or the position delta, and dismiss sticks.

**Depends on.** P1 search tab (same queries) and the T19 URL-match check. Without the match, every row is a false "no data".

## P2 — Client portal: posts, schedule, and one optional approval mode

**Why.** The portal today is a score, a blog count, reports, messages, and settings. A client cannot see what was published this week, what is scheduled, or which query a post was written to win. Messages are the only feedback channel, and the email notification on a new message is still a `TODO` in `message-actions.ts`.

**Build, in this order.**

1. Portal "Posts" on each blog: title, live URL, target keyword, published date, index state, 28d clicks/impressions if matched. Read-only.
2. Portal schedule: the canonical `posting_plan` rendered as a week, plus "last published" / "next expected". Clients currently have no way to tell a paused blog from a healthy one.
3. Resend notification when an admin replies (the existing TODO). In-app unread already works; email does not.
4. Only after 1–3: an opt-in `clients.approval_mode`. Default off (current behavior: cron publishes). When on, the cron stops at `generated` and the client gets a 48h window to reject; silence publishes. Do not make approval the default — it will stall the 500-posts/day capacity model in `docs/scaling.md`.

**Done when.** A client can answer "what did you publish for me this week, and did Google see it?" from the portal. Approval mode is off unless the client row says otherwise.

## P2 — Pipeline health in the admin UI

**Why.** T22 already writes `cron_runs`, `pipeline_errors`, and `alert_log`, and exposes `/api/admin/pipeline-health` plus `/api/admin/recent-failures`. Neither is in the sidebar. The dashboard is client counts, a score average, open SEO issues, and an activity feed. The things that actually break the network (shard double-fire, scrubber holds, meta-write unverified, IndexNow rejected, keyword refresh failures, GSC sync lag) are JSON routes.

**Build.** A "Pipeline" page that renders those two routes: last run per cron, error counts by code, blogs whose `gsc_last_synced_at` is stale, holds older than N days, and IndexNow `rejected` vs `skipped` (skipped is Shopify-on-purpose and must not look like a failure — that distinction is already in the schema comments).

**Done when.** The on-call question "did last night's publish shard die?" is answered from the UI, not from Render logs.

## P3 — Worth doing later, not now

- **SEO sub-scores on the marketing API.** Already listed in `docs/marketing-api.md` roadmap. Do it only after the quality breakdown (T19 already stores per-component reasons) is what the API returns. Do not resurrect the old meta/content/technical/links/images split — that is the hygiene score T19 retired.
- **Per-client API keys.** Same roadmap note. Fine if a second consumer appears. One shared `MARKETING_API_KEY` is acceptable while there is one marketing app.
- **Ahrefs/Semrush sync.** `seo_third_party_data` has DA, backlinks, organic keywords, and the API already returns them — but nothing fills the table on a schedule. Only build this if a client report is blocked on referring domains. It is not blocking rankings work.
- **Multi-user client accounts.** One login per client is enough until a client asks for a teammate. Roles are `client | admin | super_admin` with no permission splits.
- **Link building / digital PR.** Out of scope. The link-exchange engine was retired on purpose.

## Suggested order to hand the developer

1. Finish T23, then T25, T24, T26. Do not interleave features into those PRs.
2. Apply winnability to `topic-candidates.ts` (already named, small).
3. P1 review queue — smallest, unblocks the gate you already shipped.
4. P1 search tab + portal + PDF + API — highest client-visible value, data already in Postgres.
5. P1 opportunity inbox — depends on the winnability follow-up.
6. P2 pipeline page — cheap, makes the next incident shorter.
7. P2 decay/cannibalization queue — only after the URL-match check is signed off.
8. P2 portal posts/schedule, then approval mode last.

If only two things get built this cycle: the review queue and the search tab.


**Do not.** Add a new keyword source. Wire the existing ledger. The `topic-candidates.ts` winnability follow-up should land first or in the same PR, or the panel and the generator will disagree.


## How to read the list

Each item says what exists today, what is missing, and what "done" means.
Priority is about client-visible value and wasted data, not engineering novelty.
