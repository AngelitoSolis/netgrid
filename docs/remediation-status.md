# NetGrid remediation programme — status

Where we left off, for whoever picks this up next.

**Source of truth for the work itself:** the 27 SOPs (`T00`–`T26`) from
`netgrid-remediation-sops.zip`. `T00` is the roadmap and dependency map; read it
before assigning anything. This file only tracks *what has been done against
them* — it does not restate the tasks.

**Branch:** `claude/dazzling-maxwell-7qwt7b` — **fully merged, 0 commits ahead
of `main`.** Verified with `git merge-base --is-ancestor <sha> origin/main` on
every sha named below, not from the merge notifications.

**All four PRs opened from this branch are MERGED:**

| PR | Merged | Carried |
|---|---|---|
| [#137](https://github.com/rosicjacob-sys/netgrid-1/pull/137) | 2026-09-18 | T03, T04, T07, T08, T10, T11, T13, T14, T15, T16, T17, T18 |
| [#138](https://github.com/rosicjacob-sys/netgrid-1/pull/138) | 2026-09-21 | T05 |
| [#139](https://github.com/rosicjacob-sys/netgrid-1/pull/139) | 2026-09-21 | T09, T10 §10 |
| [#140](https://github.com/rosicjacob-sys/netgrid-1/pull/140) | 2026-09-22 | T12, T19, T20, T21, and this document |

The four stragglers named in the previous revision of this file — `f0210ca`
(T12), `dec4480` (T20), `44b215b` (T21), `a57e0a4` (T19) — were opened as a
**new** PR against current `main`, which is **#140**; all four are ancestors of
`origin/main` (`f6bfca5`, the #140 merge commit). Nothing from this branch is
outstanding.

> **#138 merged a snapshot that did not include a push made minutes earlier**,
> stranding the T09 commit outside it. Detected with
> `git merge-base --is-ancestor <sha> origin/main`, fixed by merging `main`
> back into the branch (no history rewrite). **Verify every merge
> notification against the actual commit graph rather than trusting it.**

**Last updated:** 2026-09-22 (T23 landed — see below)

---

## Verification status

**The branch compiles, lints, tests and builds clean.**

The npm registry was unreachable for most of the work on this branch
(`503 upstream connect error` on every attempt, direct and proxied), so
everything from T07 through T16 was written without a compiler. The registry
came back after T16 landed, and the full suite has now been run:

| Check | Result |
|---|---|
| `npm ci` | **Was broken.** T04 added `googleapis` to `package.json` without regenerating the lockfile, so `npm ci` — which Render's build command uses — failed with `EUSAGE ... Missing: googleapis@144.0.0 from lock file`. Fixed by committing the regenerated `package-lock.json`. |
| `npx tsc --noEmit` | Clean. Two real errors found and fixed — see below. |
| `npm run lint` | Clean, no warnings. |
| `npx vitest run` | **37 files, 485 tests, all passing** (was 22/277). |
| `npm run build` | Succeeds. |

### What the compiler caught that the hand-rolled checks did not

The substitute checks used while the registry was down (TypeScript *syntactic*
diagnostics plus executing pure functions under a vitest shim) caught three
real defects during the work, but they cannot see types. The full compiler
found three more:

1. **`npm ci` was broken on this branch** — the lockfile/manifest mismatch
   above. This would have failed the Render build on the next deploy,
   regardless of any code change.
2. **`gsc-sync/route.ts` — `provisioned` used before assignment** (T04).
   Declared as a bare `let` and read inside a `verify`-gated block; TS cannot
   see that correspondence.
3. **`wp-client.ts` — `META_NOT_LIVE` was not in `PipelineErrorCode`** (T14).
   The new telemetry code was emitted but never added to the union.

A stale `tsconfig.tsbuildinfo` initially masked the third one after it was
fixed — `incremental: true` is set in `tsconfig.json`, so delete that file if a
type error survives an edit that plainly fixes it.

### Still not verified by any of this

`tsc`/`lint`/`vitest`/`build` prove the code is internally consistent. They say
nothing about behaviour against live systems. The acceptance sections of each
SOP — the `psql` probes and the live smoke tests — are still outstanding, and
the operator actions below are still required.

---

## Status: 23 of 26 done, 3 remaining — **Phase 3 complete, Phase 4 in progress**

### Done before this session

| | Task | Notes |
|---|---|---|
| **T01** | Reddit token removal | `src/lib/seo/meta-suffix.ts` replaced the injector |
| **T02** | Shared tracking host | Direct UTM links; `link-tracker.ts` retired; backfill tooling in `scripts/t02-*` |
| **T06** | Token clamp / truncation | `content-token-budget.ts` + `DEEPSEEK_MAX_OUTPUT_TOKENS` |
| **T22** | Pipeline telemetry | `cron_runs`, `pipeline_errors`, `alert_log`, `/api/admin/pipeline-health` |

### Done this session

| | Task | What landed |
|---|---|---|
| **T07** | Scrubber publish gate | **The gate had no caller.** `shouldHoldForReview()` was exported and unit-tested but never invoked, so `SCRUBBER_ENFORCEMENT=enforce` changed one word in a log line and blocked nothing. Now called on both automatic publish paths. `publishGeneratedPost` stays ungated — it is how a reviewer *releases* a held draft. |
| **T08** | Publish idempotency | `publish_day` + `day_slot` with a partial unique index; `cron/invoke.sh` retry/timeout fix; strict shard validation (400, not silent default); `reapStuckPublishes()`; `transient` on the result type so the worker-pool retry is reachable. Migration `0040`. |
| **T03** | Link exchange shutdown | Engine hard-retired behind `LINK_EXCHANGE_RETIRED`; route returns 410 and imports nothing from the service; admin toggle refuses to re-enable; new `link-exchange-removal.ts` stripper + queue + cron. Migration `0041`. |
| **T04** | Search Console feedback loop | `gsc-client.ts`, `gsc-verifier.ts`, `gsc-sync.ts`, `gsc-index-coverage.ts`, two cron routes, `search_performance` + `index_coverage` tables, 7 Render cron services. Migration `0042`. |
| **T15** | IndexNow + sitemaps | IndexNow could not have worked on either platform. The WordPress key went into the media library and Shopify's was a themed HTML page — and IndexNow **scopes a key file to its own directory**, so neither authorised a single post URL. Failures were `console.warn` only, so a 100% failure rate looked exactly like a 100% success rate. Now: per-blog keys, a root-served key file via a new MU-plugin, verification of the actual file before any ping, an `index_ping_events` audit table, and the Google path via Search Console sitemap submission. Shopify is deliberately sitemap-only. Migration `0049`. |
| **T16** | Internal linking wiring | The relink hook had two call sites, both in the manual admin UI — it never fired for the auto-publish cron, which is the dominant publish path. So a cron-published post waited for the hourly backfill and its older siblings never linked forward at all. Now called from `runGenerateAndPublish`, behind a `SEMANTIC_LINK_ON_PUBLISH` kill switch that covers all three paths. Also: inline link candidates are chosen topically instead of by recency (same hybrid formula as the Related-posts engine), the full-text dictionary follows the post's language instead of always `english`, related posts are restricted to the same language, every link target is canonicalised, and the backfill budget is split into a new lane and a stale-refresh lane. Migration `0048`. |
| **T14** | Yoast meta no-op | Every Yoast WordPress post published with the theme's default title and no meta description, while the log said "(SEO meta set)". Three independent reasons, all returning HTTP 200. Fixed: new `docs/wordpress/netgrid-seo-bridge.php` MU-plugin registers the real `_yoast_wpseo_*` keys for REST with an `auth_callback` and refreshes Yoast's indexable cache; `updateYoastMeta` writes those keys and throws when the bridge is absent; every write is now confirmed against the live `<head>` before anything is called a success. `metaStatus: "written"` now requires live verification. Per-post result persisted on `generated_posts`, bridge version per blog, and a measure-then-repair backfill. Migration `0047`. |
| **T10** | Keyword pipeline at scale + ledger draining | The weekly refresh scraped every client in one unordered sequential pass (~5 h at 1,500 clients), so it never returned and the ledger rebuild after it never ran at all. Now 4-way sharded, hourly, staggered, with a staleness cursor on `clients.keywords_refresh_attempted_at` stamped *before* the scrape. `markKeywordTargetFailed` no longer buries a row in `failed` on the first transient error — bounded retries with a cool-off, dead-lettering only once the budget is spent, plus a two-window reaper that respects in-flight posts. Scrape locales now come from the client's own blogs instead of guessing from `language_mode`. A blocked scrape is reported instead of looking like "no results". The DataForSEO provenance downgrade is fixed. Migration `0046`, which also releases the existing permanent graves. |
| **T18** | Post-verification at scale | The sweep was a single unordered sequential loop over every active blog under `curl --max-time 660 --retry 3` — it never finished, and curl retried it three more times while the abandoned handler kept running. Now 4-way sharded (same hash partition as auto-publish, pinned by golden-value tests), concurrency-capped, wall-clock budgeted, ordered least-recently-verified-first so nothing starves, with batched writes, a persisted run summary in `activity_log`, coverage/silence alerts, and a retention prune. `posts_in_period` is a real 7-day count for the first time. The sweep no longer stamps `blogs.lastPostVerifiedAt` — that column is the auto-publish priority key. `vercel.json` deleted (two of its five schedules 404'd, two exactly duplicated Render). Migration `0045`. |
| **T20** | Structured data | The FAQ field was declared in schema 3 and thrown away on every post, so no FAQ data existed to emit. Meanwhile the JSON-LD that *was* emitted was four loose objects with no `@id`, so nothing could be merged into a knowledge-graph node — and both the WordPress block and the Shopify theme block fenced themselves with the literal string **`netgrid-seo`**, printing the vendor name into every page of the network and making the whole estate enumerable with one search operator. Now: one builder emits a connected `@graph` (Organization → Person → WebPage → Article → BreadcrumbList → FAQPage) with stable `@id`s, so the same byline on two posts is the **same entity**; the FAQ is rendered as a **visible** Q/A section and then read back **out of the finished body** to feed the markup, so it can never claim an answer the reader cannot see; and both sets of fences are now an opaque per-site FNV-1a token that upgrades the branded ones out of the live page on first re-run. No migration. |
| **T12** | Author entities / E-E-A-T | The system told the model to impersonate licensed healthcare professionals, then published the result under a byline **generated by hashing the store handle over a 30x30 table of invented names**, on domains with no author page, no archive and no author markup. 22 of the 77 peptide voices asserted a credential the writer does not have ("You are a practising physician…" reaches the prompt verbatim). Template W20 asked for a **fabricated interview** with a "composite/fictional researcher"; quirk 23 asked for an invented anecdote ("A clinician I spoke with mentioned…"); and the persona generator's own instruction asked the model for "why they're credible". Now: all 22 personas describe what the writer **reads and does**, never what they are licensed as; W20 is a sourced Q&A and quirk 23 requires a named document or skips itself; the persona generator rejects and retries on any credential word and falls back to the library voice rather than persisting a fabricated licence; and a real `authors` table backs a resolvable `Person` node with `@id`/`url`/`sameAs`. **A YMYL blog with no author on file now refuses to publish** rather than inventing one. Migration `0052`. |
| **T09** | Keyword winnability | The only ranking in the system was `search_volume desc, hit_count desc` — a popularity contest. Volume and organic difficulty are strongly correlated, so that sort deterministically selected the **hardest** terms in a client's universe: the head terms a fresh domain has no path to ranking for. `keyword_difficulty` and `competition` were already on the row and read by nothing but one admin display cell. Worse, the ledger made **one post per near-duplicate Autocomplete variant** — "buy peptides", "buy peptides online", "where to buy peptides", "peptides for sale" became four near-identical articles on one site, which is the textbook definition of doorway content. Intent detection matched **substrings**, so "order" fired inside "sleep dis**order**", "cost" inside "**cost**ume", "best" inside "as**best**os" — and intent decides the title template, so "Where to Buy Sleep Disorder Treatment in Montreal: Pricing & Availability" was a reachable, shipping title. And the city collision filter was network-wide, so one client assigning a blog to *Sale* or *Mobile* silently deleted "X for sale" keywords for **every other client**. Now: a gated winnability score (magnitude ÷ difficulty ÷ competition × long-tail bonus), intent-scoped clustering that folds variants into one target carrying the rest as secondary keywords, word-boundary intent matching, a client-scoped city filter with a locative-preposition rule for ambiguous names, and a per-client `local_presence` switch that gates city framing entirely. Migration `0051`. |
| **T10 §10** | DataForSEO budgeted cron | The step deliberately deferred from T10 pending a budget sign-off. Now built at the approved **$20/month**: a month-to-date cap read from the cost DataForSEO itself reports, enforced before every call, on top of the existing per-run ceiling. Least-recently-pulled-first so the network is covered in rotation. Every guard fails **closed** — unset flag, missing credentials, or an unreadable spend ledger all mean "spend nothing". |
| **T05** | Article prompt rewrite | The prompt spent 44% of its instruction budget (36 of 81 lines) on a forbidden-word list and **zero** of it on the query the page had to win. The complete "what should this article contain" guidance was three bullets, and the first of them — "exact prices, real brand/tool names, concrete numbers" — instructed a model with **no retrieval of any kind** to produce specifics it could only invent. Every fabricated price, dosage and statistic in the network traces to that one line. Now: every prompt path opens with a SEARCH BRIEF (target query, classified intent, the searcher's goal, and the real sub-questions from T11), the fabrication mandate is replaced by a strict FACTS POLICY, and ANSWER-FIRST / INFORMATION GAIN blocks require a snippet-eligible opening and something a generalist could not have written from the query alone. The `faq` field schema 3 had declared since forever — and the generator had always thrown away — is now parsed, which is what unblocks T20. All 8 schemas drop the identical keyword-first `metaTitle` grammar and put the site's own brand back into the title tag. No migration, no DB writes; fully revertable by `git`. |
| **T11** | Ideation grounding | Topic ideation asked a model to invent both the subject and the target keywords from a niche label, then — when its own duplicate check failed three times — **published the duplicate anyway** with a `console.warn`. The database already held real query data (`client_keywords`, with volume and difficulty from the DataForSEO pull); ideation reached none of it in a usable shape. The dedup window was 24 titles, so a blog posting daily forgot what it wrote 13 days ago and the collision rate rose with the blog's age. And the tokenizer split on `[^a-z0-9]`, treating every accented letter as a delimiter — two identical French sentences scored **0.08**, so every French blog had no duplicate detection at all. Now: `ideateTopic` selects an **angle** over a supplied, demand-ranked, already-filtered candidate list; a permanent `blog_covered_queries` table replaces the 24-title window; the accept-the-duplicate branch is gone (exhaustion refuses to publish instead); the ledger path is no longer exempt from duplicate detection; and `temperature` drops 0.9 → 0.35 for what should be the least creative decision in the pipeline. Migration `0050`. |
| **T13** | Composer repair | Every non-peptide blog in the network was writing from **one** template. `buildStructuralPool` filtered on `subNicheFit` at all three tiers, and no template declares a sub-niche above 13 — so the pool came back `[]` for sub-niches 14-90 and `pickTemplateForPost` silently served `TEMPLATES[1]`, peptide section labels ("Mechanism — how the compound works at cellular level") included, on every roofing, loans and casino post ever published. Separately `archetypeForVoice` scanned only the `voiceRange` bands, which stop at V77, so all 50 cross-niche voices collapsed onto archetype 1 and 5 of 12 skeletons were unreachable. Now: 22 niche-neutral flow variants (`CROSS_NICHE_FLOWS`), a 6-tier pool ladder with a sub-niche-agnostic floor, `archetypeForVoice` reading the voice's declared archetype, and the three dead compatibility guards (`SubNiche`, `Cadence`, `Strictness`) finally called. Two strings that were being ordered into published HTML are gone: the literal `(no compliance phrase required for this niche)` and the raw token `{citation.style}`. No migration — data repair only, via `src/lib/db/repair-structural-pools.ts`. |
| **T21** | Prompt contradictions | Five instructions in the assembled system prompt told the model to do two incompatible things at once, and because the prompt is built by **string concatenation**, the later block silently won every time — the earlier one still burned its tokens. (a) A fixed "split any sentence over 35 words" ceiling was appended *after* the style profile's cadence, so the four longest-form cadences could never produce the rhythm they specify; the ceiling is now derived from the cadence itself (`buildSeoQualityDirective`), and the SOP's single-block form had to be adapted because T05 had already grown that directive to four blocks — ANSWER-FIRST / INFORMATION GAIN / FACTS POLICY are preserved verbatim and only the rhythm bullet varies. (b) Quirk 21 ("Aggressive em-dash usage") asked for the one character the AI-tells block bans outright; repurposed to "Aggressive interruption" rather than deleted, because deleting an id throws in `quirksByCategory` on **every** blog assignment. (c) The custom-prompt path omitted the vocabulary blocklist entirely while still banning the punctuation, so a custom-prompt blog got "delve/tapestry/moreover" back; `BLOCK_AI_TELLS` is now split into VOCAB + PUNCTUATION halves (recomposed losslessly) and the custom path interpolates the VOCAB half. (d) The French directive demanded typographic punctuation that Layer 1C's `applyPunctuationFixes` strips on the way out — it now enumerates exactly what survives, verified against the live normaliser. (e) `pickWordBand` ignored its seed, so **every blog in the network** drew the same word band; it now derives a tier from the structural pool and cadence lean and offsets within it from a seeded RNG — taking the seed as a **string** so the shared stream stays byte-identical and no existing assignment shifts. No migration. |
| **T19** | Real quality score | Three per-post columns and one per-blog headline number, all client-facing, and none of them a measurement. `generateContent` wrote the literal **70/70/70**; `readability_score` and `brand_voice_score` were written by nothing else, so their value was 70 for **every row in the table, forever**. Three independent scoring engines disagreed: engine A (per-issue penalties) scores a unique article and the same article duplicated onto forty sibling sites **identically at 100** — it has no input that could tell them apart; engine B (`seo-scorer` + `seo-crawler`, ~800 lines) had **zero reachable callers** and 10% of its output was a hardcoded 50 for a category it never measured; engine C wrote **Lighthouse's SEO category** — a binary on-page checklist, audited against the **site root** rather than the article — into the client-facing number on every fix Apply. None of the three takes an input that changes when a page is deindexed, which is why ~1,500 blogs could score 70–100 for years while ranking for nothing. Now one engine: an **indexation gate** (`not_indexed` → 0, `unknown` → **NULL**, never 0) over search performance 35 / duplication 25 / Core Web Vitals 25 / tag hygiene 15. A component with no data is dropped and the rest renormalised; below 40% coverage the score is NULL, so hygiene alone can never produce a number. Every score carries a full per-component breakdown with a reason string. Also fixed: CLS was `Math.round`ed, collapsing every real value (0.04–0.31) to **0**; the portal and the monthly PDF both `coalesce(avg, 0)`, which would have shown every client a 6xl **"0 out of 100"** on deploy day; the PDF's trend arrow subtracted last period's *hygiene* average from this period's *composite* average; `regenerateAndUpdatePost` never triggered a re-scan, so a regenerated post kept its old score forever. Migration `0053`. |
| **T17** | Cadence integrity | One canonical `blogs.posting_plan integer[7]` replaces four disagreeing columns. New pure module `src/lib/posting-plan.ts`; publisher, verifier, pipeline-alerts, validators, CSV importer, form, admin + portal UIs all read it. Publish window narrowed to 0–17h so no blog has a single tick of runway. `?dry=1` on the auto-publish route. "No posting plan" is now a critical notification and an `activity_log` row, not a discarded JSON string. Migration `0043`; `0044_drop_legacy_cadence.sql.pending` written but inert. |
| **T23** | HTML post-processor | Six regex post-processing steps corrupt the HTML they clean. `capWordCount` counted tags and attributes as words — a 1900-real-word body with 40 anchors measured 2060 and was truncated to **1840**, below the very band Layer 1F then flags — and cut mid-element, leaving `<ul>`/`<li>`/`<h2>` open so the theme swallowed the CTA button and the tracking pixel into the list. `applyPunctuationFixes` stamped `" ,  "` into the prose of every post that used an em dash **and** into `href`/`title` attributes, breaking links — an identical, rare, machine-detectable byte sequence on all ~1,500 domains. The `<br>` strip deleted the tag with an **empty** replacement, welding "line one<br>line two" into "line oneline two", a token that then entered the embedding and `search_tsv` and degraded related-post selection. The `<div>` unwrap was one non-greedy pass, so nested wrappers survived *and were then exempted from the unknown-tag scan that exists to catch exactly that*; on crossed tags it silently reordered content. Every disallowed heading collapsed to the **first** allowed level, so `<h4>`–`<h6>` were promoted past the `<h3>` they sat under and the outline inverted. `injectMoneyLink` handed the paragraph's own prose to `String.replace`, which interprets `$$`/`$&`/`` $` ``/`$'` — `$&` duplicated the whole opening paragraph inside itself — and patched the first occurrence of that text *anywhere* in the body, so a heading with the same wording received a nofollow money link. The markdown guard tested for `#`, so `**bold**` with no `#` published literal asterisks. Now: one parser-based module (`src/lib/content/html-utils.ts`) owning the single word counter, text-node-only typography, a fixed-point unwrap, nearest-heading remap (ties downward, attributes preserved) and an honest unknown-tag scan; `injectMoneyLink` splices by index and skips attribute hits; plus a dry-runnable repair pass (`html-integrity-repair.ts` + `CRON_SECRET`-guarded `/api/cron/html-integrity`) for the artifacts already published. No migration. |

### Remaining: 3

Grouped by the phase plan; ordering follows T00's dependency map.

**Phase 3 — content & targeting — COMPLETE**

`T13`, `T11`, `T05`, `T09`, `T12`, `T20` and `T21` are all **done**.

**`rankedQueriesForClient` (T11's seam) is deliberately still the simple
ordering.** T09 replaced the ranking in `client-keywords.ts`, which is what the
ledger and the ideation keyword pool read. The T11 candidate seam in
`topic-candidates.ts` is a separate, narrower query and is the obvious next
place to apply the winnability score — a small, self-contained follow-up.

**Phase 4 — hygiene (5)**

`T19` and `T23` are **done**. Remaining: `T24`
robots/canonicals/hreflang/jitter · `T25` autofix hardening · `T26` image
pipeline. **Full handoff instructions for all three are in
[What is left to implement](#what-is-left-to-implement) below** — read that
section before opening any of those SOPs, because T19 moved ground under
three of them and T23 rewrote the post-processing chain all three touch.

---

## What is left to implement

**Read this whole section before opening any of the three remaining SOPs.**
They were written against the repository as it stood at the start of the
programme. Twenty-three tasks have landed since, and two of the three remaining
SOPs reference code that no longer exists or has already been changed. Every
such collision is listed below. Where a SOP and this document disagree about
the *current* state of the repo, this document is right and the SOP is stale;
where they disagree about *intent*, the SOP is right.

### Ground rules that apply to all three

1. **Migration numbering.** T24, T25 and T26 each call their migration
   `0039_*.sql`. The highest prefix on this branch is **`0053`**. Take the
   next free number in landing order and say so in a header comment in the
   file, exactly as `0053_quality_score.sql` does. Migrations here are
   hand-written and idempotent, applied by `src/lib/db/migrate.mjs` from
   Render's `preDeployCommand`. **`drizzle-kit` is not the source of truth** —
   do not run `drizzle-kit generate`, and do not trust `meta/_journal.json`,
   which only covers the first few files.
2. **No interactive transactions.** The DB driver is `drizzle-orm/neon-http`:
   every statement is its own HTTPS round trip. `db.transaction()` is not
   available, and `SET LOCAL` does not persist across statements. Design for
   idempotent, individually-safe writes.
3. **Verify before you believe a line number.** Every line number in every SOP
   is stale by hundreds of lines. Grep for the symbol.
4. **Run the full gate before committing:**
   `rm -f tsconfig.tsbuildinfo && npx tsc --noEmit && npm run lint && ANTHROPIC_API_KEY=dummy npx vitest run && npm run build`.
   Delete `tsconfig.tsbuildinfo` first — `incremental: true` is set, and a
   stale buildinfo has masked a real type error on this branch before.
   `npm run build` exceeds a 2-minute tool timeout; run it in the background
   and poll.
5. **Update this file after every task.** That is a standing instruction from
   the programme owner, not a nicety: it is the only handoff artifact.

### Suggested order

**T23 → T25 → T24 → T26.** T23 rewrites the post-processing chain every
generated post passes through, so landing it first means the other three are
written against the final shape of that chain rather than being rebased onto
it. T25 is next because it is the one whose SOP has decayed most and the
decay is all in T19's favour (three of its seven defects are already fixed).
T24 and T26 are independent of everything else and of each other.

---

### T23 — HTML post-processor (`T23-html-integrity.txt`) — **DONE 2026-09-22**

**Read these notes first.** They record what actually shipped and the semantics
that must not be re-broken; the original handoff text below them is kept for the
reasoning, but it is now wrong about the *current* state of the repo in three
places (see "Resolved collisions").

#### What actually landed

**Verified:** `npx tsc --noEmit` clean · `npm run lint` clean, no warnings ·
`npx vitest run` **40 files / 525 tests passing** (was 37/485) · `npm run build`
succeeds, with `/api/cron/html-integrity` built as a dynamic route.

| File | Change |
|---|---|
| `src/lib/content/html-utils.ts` | **NEW.** The one word counter (`countHtmlWords`), fragment load/serialize, the text-node walker, sentence-aligned trimming, and the parser-based `capWordCount`. |
| `src/lib/content/scrubber/layer1.ts` | 1C rewritten (text nodes only; the em dash consumes its whitespace) and 1D rewritten (real strip/unwrap/remap + honest unknown-tag scan). `stripHtmlToPlainText` / `countWords` now delegate to the shared module. |
| `src/lib/services/content-generator.ts` | Local `capWordCount` and `closeOpenTags` **deleted**; `countWordsInHtml` delegates; `injectMoneyLink` splices by index; the markdown guard is unconditional. |
| `src/lib/services/html-integrity-repair.ts` | **NEW.** `repairBlogHtmlIntegrity` + the three pure helpers. Reads the LIVE body, writes only on change. |
| `src/app/api/cron/html-integrity/route.ts` | **NEW.** `CRON_SECRET`-guarded, `?blogId=` required (400), `?dryRun=1`, `?limit=`. Deliberately **not** in `render.yaml` — it rewrites live client sites and is operator-driven, one blog at a time. |
| 3 test files | `html-utils.test.ts` (17), `scrubber/layer1.test.ts` (12), `html-integrity-repair.test.ts` (13), plus 8 rewritten `injectMoneyLink` tests in `content-generator.test.ts`. |

#### Resolved collisions (the notes below are history)

- **`capWordCount` was already half-fixed.** T06 had shipped a version that counted markup correctly and closed open tags with a hand-rolled regex walk — and exported it. T23 replaced it outright with the parser version: the T06 one still amputated the conclusion and closed tags by guesswork. **`closeOpenTags()` is deleted**, and its five unit tests with it: `loadFragment(...).html()` is what closes tags now, and keeping a regex tag-closer beside the parser that replaces it is the drift this task exists to remove.
- **`injectMoneyLink` no longer takes a `seed`** (T02 removed the per-blog rel pool), so the SOP's `relForBlog(seed)` signature was stale. The index-splice fix and the `isInsideTag` guard landed against the current `(body, url, terms)` signature.
- **`seo-crawler.ts` is still gone** (T19 deleted it); `post-seo-scanner.ts` and `news-fetcher.ts` remain as the cheerio idioms and both still pass.

#### Semantics that changed on purpose — do not re-break these

- **`wordCount` shifts network-wide.** The cap measures real words and, when it trims, shaves the tail of the **middle** sections at a sentence boundary — never the opening paragraph, never the conclusion. Link-heavy bodies get longer than they used to; some posts lose a sentence they previously kept.
- **The meta title / description does NOT go through the parser.** parse5 escapes `&` as `&amp;` in serialized text, which belongs in a body and not in a `<title>`. `applyPunctuationFixes` therefore takes the plain-text path (no `<` in the input) and rewrites the string directly. Keep that branch.
- **Every generated body is re-serialized**, so byte-level output changes slightly (void tags lose `/`, attribute quoting and entity escaping normalize). Rendering is identical; the UTF-8 test guards French.
- **1D's unknown-tag scan no longer exempts `ALWAYS_UNWRAP` / `ALWAYS_STRIP` members.** A surviving `<div>` now raises `schema_violation` instead of being waved through. If a blog floods with those after deploy, the scan is reporting damage that was previously hidden — read the tag names before reverting, and coordinate with T07 before flipping `SCRUBBER_ENFORCEMENT`.
- **`countSuspectedBrWelds` is a ranking, not a verdict.** It keys on a lowercase→UPPERCASE junction, so it sees `theStudy` and `netGrid` but not `line oneline`. Flagged posts go to `needsRegenerate`; missed welds are simply not counted, and nothing pretends to repair them.
- **The repair pass is idempotent and additive**, and every run starts with `dryRun=1&limit=10` on one blog. It cannot undo three of the six defects: the space a `<br>` occupied, the original depth of a flattened heading, and the text a `$&` replacement overwrote — those need regeneration.

**What it is.** Six regex-based post-processing steps corrupt the article HTML
they are meant to clean. `capWordCount` counts HTML tags as words, then
truncates mid-element and leaves block tags unbalanced. `applyPunctuationFixes`
rewrites inside tags and attributes, not just text nodes. `applyTagWhitelist`
is a regex whitelist that cannot see nesting. The task replaces all six with
parser-based implementations (cheerio, already a dependency at `^1.2.0`) and
adds a repair pass for the artifacts already stamped into published posts.

**Effort:** 6–9 hours. **Risk:** medium — it rewrites the path every generated
post passes through, but the repair pass is additive and dry-runnable.

**Collisions with what has already landed:**

- **The chain the SOP quotes has grown.** The SOP reproduces the chain at
  `content-generator.ts:3182-3235`. T05 inserted FAQ parsing, T20 appends a
  visible FAQ section **before** `dedupeHeadings`, and T12 resolves the byline
  earlier in the same function. Re-read the real chain end to end before
  touching it. In particular the T20 FAQ section is emitted as HTML and then
  **read back out of the finished body** to build the JSON-LD — so if a
  parser rewrite changes how that section serializes, `extractFaqFromHtml`
  in `src/lib/seo/structured-data.ts` must still match it. There is a test
  (`structured-data.test.ts`) that will catch this; make sure it still runs
  against the real post-processed output and not a hand-written fixture.
- **`seo-crawler.ts` is gone.** The SOP's prerequisites cite
  `src/lib/services/seo-crawler.ts:2` as one of three existing cheerio call
  sites. T19 deleted that file. The other two (`post-seo-scanner.ts`,
  `news-fetcher.ts`) are still there and still show the repo idioms.
- **`capWordCount`'s cap now comes from a seeded word band.** T21 rewrote
  `pickWordBand` so each blog draws its own band. `capWordCount` is called
  with `styleProfile.wordBandMax`, so a change to the word counter changes
  where every blog's articles get truncated. The T23 SOP's own note that the
  counter is currently wrong is the reason this matters: fixing the counter
  will make articles *longer*, not shorter, because tags stop being counted.
  Expect `wordCount` in the DB to shift network-wide and say so in the commit.

**Two cheerio behaviours the SOP is right to flag, and both are load-bearing:**
`cheerio.load(html, null, false)` — the third argument is `isDocument`, and
`false` is what stops parse5 inventing `<html>/<head>/<body>` wrappers around
every article body. And in HTML mode the parse5 serializer escapes only
`& < >` in text, leaving non-ASCII as UTF-8 — which this network needs,
because it publishes French.

**Do not touch `paragraphsFromHtml`** (`src/lib/content/scrubber/layer1.ts`).
Layer 2's paragraph-uniformity checks import it, and changing how it splits
changes violation counts for every blog.

**Deliverables:** `src/lib/content/html-utils.ts` (new, shared parser helpers
and the rewritten `capWordCount`), rewrites of `applyPunctuationFixes` and
`applyTagWhitelist` in `layer1.ts`, `src/lib/services/html-integrity-repair.ts`
(new), `src/app/api/cron/html-integrity/route.ts` (new, `CRON_SECRET`-guarded,
with `dryRun`), and three new test files.

---

### T25 — Autofix hardening (`T25-autofix-hardening.txt`)

**What it is.** The fix queue writes model output onto clients' live sites with
no validation. An empty model completion is written to the live site **as the
literal string "Reddit"**. Seven defects; the task puts a validation gate in
front of every meta write, retries the fix model instead of publishing its
empty completions, rewrites the fix prompt to the pixel policy the rest of the
system already enforces, and moves the PageSpeed rescan out of the request
path.

**Effort:** 1–2 days. **Risk:** medium — it touches a live-write path, but
every change fails closed (an issue is marked `failed` rather than written).

**This SOP has decayed the most. Three of its seven defects are already
fixed, and two of its file edits are impossible as written:**

- **The `"Reddit"` literal is already gone.** T01 removed the Reddit suffix
  injector and replaced it with `src/lib/seo/meta-suffix.ts`
  (`appendBrandToTitle` / `capMetaDescription`). The *empty-completion* half of
  defect A is still entirely real and still unfixed — `callFixModel` still
  returns `""` with no retry on a refusal or a `max_tokens` stop, and
  DeepSeek still routinely returns empty `content` with populated
  `reasoning_content`. What lands on the live site now is the brand suffix
  alone rather than `"Reddit"`, which is less absurd and exactly as broken.
  **Keep the guard; rewrite the test name.**
- **`EDIT src/lib/services/seo-scorer.ts` is impossible — T19 deleted that
  file.** The SOP wants it to stop flagging alt-text and Open Graph issues as
  auto-fixable. Those flags now originate in **`src/lib/seo/scanner.ts`** and
  **`src/lib/services/post-seo-scanner.ts`**. Apply the change there. (The
  underlying point stands: an issue marked `auto_fixable` that no fixer
  implements is a queue item that can only ever fail.)
- **`rescanBlogScore` no longer calls PageSpeed.** The SOP's step to move the
  PSI rescan out of the request path is **half-done**: T19 rewrote
  `rescanBlogScore` to recompute the blog aggregate from its posts' quality
  scores — no network call at all, so the request-path latency problem is
  already solved. What T25 still adds that T19 did not is the **`seo_rescan_queue`
  table and its drain cron**, so that applying a fix triggers a real re-scan
  of the affected *posts* (which is what actually moves the score now, via the
  15%-weighted hygiene component). Build the queue; do not re-introduce a PSI
  call.
- **`EDIT src/lib/services/pagespeed-client.ts` — refuse without a key.** T19
  put exactly this guard in the **blog-vitals cron route** instead (it returns
  503 rather than persisting rate-limited failure rows). Decide whether you
  want the guard in the client as well; if you do, make sure the cron's own
  check still fires first so the error message stays specific.
- **`GOOGLE_PAGESPEED_API_KEY` is already declared in `render.yaml`** (T19
  added it to the web service). Do not add it twice.
- **The UI copy change is now more important, not less.** The SOP asks the
  fix-queue Apply toast to report a queued rescan instead of an inline score
  delta. With T19's `rescanBlogScore`, an immediate delta of **0 is correct
  behaviour** — applying a meta fix moves the score only through the
  15%-weighted hygiene component, and only after the affected posts are
  re-scanned. There is a comment saying so on `rescanBlogScore`. Do not
  "fix" the zero by re-introducing a fast proxy metric; that is precisely the
  mistake T19 exists to undo.

**Still fully valid and unfixed:** the empty-completion hole in `callFixModel`
(both branches), the missing retry, the DeepSeek timeout, the fix prompt's
disagreement with the pixel policy, the "too long" fixer trimming the body
instead of the real current value, and the missing validation gate itself
(`src/lib/seo/meta-guard.ts`).

---

### T24 — Technical SEO hygiene (`T24-technical-seo-hygiene.txt`)

**What it is.** Four independent defects that together form a machine-readable
signature of the network: every property links out to the same host, none
declares which URL is authoritative, they all publish on the same minute of
the hour forever, and the bilingual ones interleave two languages in one URL
space. Ships `robots.txt` + `X-Robots-Tag: noindex` on the control-plane host,
real canonical tags on both platforms, a deterministic per-(blog, day) publish
slot, and a per-blog language mode.

**Effort:** 10–14 hours. **Risk:** medium — it touches the auto-publish
scheduler, the Shopify theme writer, and the publish persist path.

**Collisions with what has already landed:**

- **`link-tracker.ts` is retired.** The SOP cites
  `src/lib/services/link-tracker.ts:19-23` as the default for the shared host.
  T02 retired that module in favour of direct UTM links. **The four tracking
  routes it names — `/r/{postId}`, `/r/blog/{blogId}`,
  `/api/track/px/{postId}`, `/api/track/px/blog/{blogId}` — still exist and
  are still unauthenticated and still crawlable.** Confirm which are still
  referenced from published HTML before deciding whether the answer is
  `robots.txt` + `noindex` (the SOP's answer) or deletion. `robots.txt` and
  the header are worth shipping either way: old published pages still carry
  old links.
- **`SEO_BLOCK_VERSION 2 → 3` — check the current value first.** T20 rewrote
  the Shopify theme block (opaque per-site marker tokens replacing the
  branded `netgrid-seo` fences) and may have already bumped it. Read
  `src/lib/services/shopify-theme-client.ts` before assuming `2`.
- **The Shopify theme block is now marker-token fenced.** T24 wants to add
  `<link rel="canonical">`, `og:locale` and JSON-LD `inLanguage` to that
  block. It must go **inside** the managed fences (`markerBegin`/`markerEnd`)
  or the upsert will not replace it on re-run and you will stack blocks. Also
  note `ANY_BLOCK_SRC` still matches the legacy branded fences on purpose, so
  a first re-run upgrades them out of the live page — do not break that.
- **`blogs.languageMode` may not be the right column.** The SOP says to add
  it to `blogs`. `languageMode` already exists on **`clients`**. T24's intent
  is a *per-blog override* of the client-level mode, so a new column is
  correct — but name it so the two are not confused, and make
  `src/lib/content/post-language.ts` resolve blog → client → default in that
  order.
- **JSON-LD `inLanguage` is deliberately omitted today.** T20 dropped it
  rather than guess, because `generated_posts` has a `language` column but
  `blogs` does not, and a wrong language tag is worse than no tag. Once T24
  lands a per-blog language mode, **wire it into
  `buildArticleGraph` in `src/lib/seo/structured-data.ts`** — that is the
  blocked follow-up, and it is recorded in Known gaps below.
- **The publish-window narrowing already happened.** T17 narrowed the publish
  window to 0–17h so no blog has a single tick of runway. T24's jitter slot
  must stay inside that window, not replace it.
- **`cron/invoke.sh` retry/timeout was already changed by T08.** Re-read it;
  the env-driven retry count T24 wants may be partly there.

---

### T26 — Image pipeline (`T26-image-pipeline.txt`)

**What it is.** Every post gets a hero and a body image from Gemini. The
aspect ratio is **never requested** on the model actually in use (the one
`"16:9"` in the codebase sits on the Imagen path, which has not executed in
production since the default model became a `gemini-*` id), so a 1:1 hero
rendered at 100% of a 700px column is 700px tall and pushes the first
paragraph below the fold on mobile. Base64 `data:` URIs ship into published
HTML. Alt text is generic. Image spend and image failures are in no number
anywhere.

**Effort:** 10–14 hours. **Risk:** medium — publish-path behaviour changes on
both platforms; DB columns are additive only.

**This is the cleanest of the four — it barely overlaps anything that landed.**
Two things to know:

- **The SOP corrects its own audit brief, and it is right to.** The brief
  claims returned images are "stretched by hero markup that assumes wide".
  That is false — all three hero variants and both body variants set
  `height:auto`, so the intrinsic ratio is preserved. Do not go looking for a
  stretch bug.
- **Do not delete `src/lib/services/image-compress.ts`** when you remove its
  two publish-path importers. `knowledge-converter.ts` also imports
  `compressImageDataUri` and is unrelated. Remove only the imports in
  `wp-client.ts` and `shopify-client.ts`.
- **Image cost belongs in the T22 telemetry tables**, which already exist
  (`cron_runs`, `pipeline_errors`, `alert_log`, `/api/admin/pipeline-health`).
  Prefer extending those over inventing a parallel counter.
- **`GOOGLE_API_KEY` is dashboard-only** and not declared in `render.yaml`.
  Generation runs inside the **web service** via the cron HTTP call, so the
  web service is the one that needs it — not the cron services, whose env
  vars are consumed by `curl` in the cron container and never reach the
  handler. This is the same trap T10 hit with sharding.

---

### Before T19 can actually produce a number

T19 shipped an engine that is correct and wired, but it scores **NULL for
every post** until two operational things happen. Neither is code, both are
in Operator actions below, and until they are done the portal will honestly
read "n/a" everywhere:

1. `GOOGLE_PAGESPEED_API_KEY` set on the web service, and the blog-vitals
   backlog drained.
2. The URL-matching assumption verified —
   `search_performance.page` must match `generated_posts.external_post_url`
   byte for byte, or the 35-weight search component reads "no data" for the
   entire network.


---

## Bugs found while implementing

Three defects the SOPs' own code carried, caught by executing it rather than
reading it. Worth knowing about because the SOPs are otherwise reliable.

1. **`a ?? b || c` is a JS syntax error** — appeared three times in T04's code
   (`gsc-sync.ts` concurrency, `gsc-index-coverage.ts` budget and perSite).
   Mixing `??` with `||` without parentheses does not parse. Would have failed
   `npm run build`. Fixed by parenthesising the `||` group.

2. **`tagOpenIndex` was not quote-aware** (T03 stripper). It walked *backwards*
   from the marker looking for `<`, bailing on the first `>` — but a `>` inside
   a quoted `href` is not a tag end. `tagCloseIndex` scanning forward *was*
   quote-aware, so the two disagreed. Behaviour was safe (it refused to splice
   rather than corrupting) but it dumped ordinary posts into manual triage.
   Rewritten to scan forward with the same quote-aware boundary logic.

3. **A raw `0x00` byte landed in `gsc-sync.ts`** instead of the ``\u0000``
   escape, making it a binary file. Functionally identical, invisible in
   review, and hostile to tooling. Replaced with the escape sequence.

---

## Operator actions that are NOT code

These block acceptance and nobody but a human can do them.

- **T23 — roll the repair pass out per blog, measure first, and do not schedule it.**
  The generation-side fix only affects posts generated *after* the deploy; every post already published still carries whatever the old post-processor stamped into it. Sequence, per blog:
  1. Snapshot the stored bodies before touching anything (`T23` §8.2 has the `CREATE TABLE t23_body_backup AS …` statement) — `backfillPostSeo` overwrites the live article and there is no automatic undo.
  2. `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/html-integrity?blogId=<uuid>&dryRun=1&limit=10"` and read the diff. Expect the em-dash artifact (`" ,  "`) to be present on most blogs that have generated since the scrubber shipped — if the count is near zero, check the query ran against the right database before concluding there is nothing to repair.
  3. Run the same call live on that one blog, then let `?limit=` drain it. `needsRegenerate` lists the posts whose damage a repair cannot undo; hand those to regeneration, do not "repair" them.
  4. Only sweep the network once one blog shows `failed: 0` and a second run reports `updated: 0`.
- **T19 — this ships a score designed to produce LOWER numbers than the one it
  replaces, and they are visible to paying clients.** Sequence matters:
  1. **Do not deploy in the last week of a month.** `netgrid-cron-monthly-reports`
     fires 01:00 UTC on the 1st, and the PDF reads these numbers.
  2. **Do not deploy during business hours in the client's timezone.** The
     migration runs in `preDeployCommand`, i.e. *before* the new code is live,
     so there is a window of seconds-to-a-minute where the **old** UI renders
     the newly-nulled scores. The old portal page coalesced null to 0 and
     would show a 6xl "0 out of 100" during that window.
  3. **Send the client note ahead of the change, not with it.** The honest
     framing is that the previous number was a placeholder that could not fall,
     that it is being replaced by one that can, and that "n/a" means not yet
     measured rather than zero. Whoever owns the client relationship decides
     the wording; do not send it from a pull request.
  4. Migration `0053` snapshots both score sets into `t19_blog_score_snapshot`
     and `t19_post_score_snapshot` **before** nulling anything, so the change
     is reversible for as long as those tables exist. Do not drop them until
     the new scores have been accepted.
- **T19 — set `GOOGLE_PAGESPEED_API_KEY` on the web service, then drain the
  vitals backlog.** Without a key PSI runs on the unauthenticated tier (~50
  requests per 100s per IP) and the new cron **refuses to run** rather than
  persisting rate-limited failure rows — so Core Web Vitals, 25 of the 100
  weight, stays unavailable forever and many posts fall under the 40% coverage
  floor and score NULL. Create the key in Google Cloud Console (enable
  "PageSpeed Insights API"), set it on the **web service** (the handler reads
  it, not the cron container), then prove the wiring on one blog before
  batching:
  `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/blog-vitals?blogId=<uuid>"`.
  Two things to check in the response: `url` must be an **article** URL, not
  the site root (a root URL on an established blog means the publish path is
  not setting `external_post_url`); and `clsX1000` must be a two-digit number,
  not 0 — a fleet of zeros means the CLS fix did not deploy.
- **T19 — verify the URL match before trusting the search component.** The
  search rollup joins `search_performance.page` to
  `generated_posts.external_post_url` as an exact string. Search Console
  reports the **canonical** URL, which can differ by a trailing slash, by
  protocol, or by `www`. A mismatch silently produces "no data" for the entire
  network and is indistinguishable from a property that was never verified.
  Run a spot check on one blog that is known to have impressions before
  drawing any conclusion from a fleet of nulls.
- **T19 — calibrate the duplication threshold on the real corpus before
  enabling the flag.** The shipped defaults (clean below 0.80, zero at 0.95,
  flag at 0.92) are reasonable for `text-embedding-3-small` but cosine
  distributions are corpus-specific, and a network where every blog writes
  about peptides sits higher on the scale than a general-interest corpus. Run
  the percentile query in the T19 SOP §4.4 over a random sample of 300
  published posts. If `would_flag` exceeds ~10% of the sample, **pull five
  flagged pairs and read them before moving the threshold** — moving a
  threshold to silence a true positive is exactly how the hardcoded 70
  happened. `QUALITY_DUPLICATE_FLAG` overrides it without a deploy.
- **T19 — the duplication report is likely the most valuable output of the
  task.** Once `max_sibling_similarity` is populated it answers a question
  nobody at NetGrid has been able to answer: how much of the network is
  publishing the same article. The distribution and worst-offenders queries
  are in the T19 SOP §7.3. Publish the result internally.

- **T12 — create a real author per YMYL client, or those blogs stop
  publishing.** That refusal is the feature, not a regression: peptides,
  gambling, online_casino, loans and tax_lawyer now require an active author
  with recorded consent. `ALLOW_UNATTRIBUTED_YMYL=true` opts out and publishes
  under "<Brand> Editorial Team" instead — an operational decision with a
  compliance consequence, so record who set it and why. Non-YMYL blogs are
  unaffected and fall back to the organisational byline automatically.
- **T12 — an author row must be a real, consenting person.** `activateAuthor`
  refuses without a consent record URL, and refuses to activate a row that
  lists credentials with no evidence URL. Do not work around either: an
  undocumented credential in that table is the same fabricated-expertise claim
  that was just removed from the prompt library, only harder to find.
- **T10 §10 / T09 — arm the DataForSEO cron carefully; it spends real money.**
  Deploy with `DATAFORSEO_CRON_ENABLED` **unset** (the route is then a no-op
  that reports why, so the schedule is safe to leave in place). Invoke once by
  hand with `?limit=1`, read `dataforseo_runs` and confirm the billed cost,
  derive the real per-seed cost C, and only then set the flag. The
  `$20` ceiling is committed in `render.yaml` as
  `DATAFORSEO_MONTHLY_BUDGET` rather than `sync: false`, because it is a
  policy decision that belongs in review — change it there, not in the
  dashboard.
- **T09 — decide `local_presence` per client before the next ledger rebuild.**
  It defaults to **false**, which is the safe direction: every client's
  commercial keywords become city-FREE posts until someone confirms the
  business actually operates somewhere. Clients that genuinely have a
  storefront or service area need the toggle turned on in the client form, or
  they lose city pages they should have.
- **T11 — run the covered-query backfill immediately after `db:migrate`, and
  before the next hourly auto-publish tick.** `npm run db:backfill-covered-queries
  -- --dry-run`, then without the flag. Without it every live blog starts with
  an empty covered-query history and will happily re-cover subjects it
  published last month. Idempotent — a second run must insert 0.
- **T11 — ship with `IDEATION_REQUIRE_CANDIDATES` unset.** Grounding is on
  wherever a keyword pool exists; clients with no pool keep publishing via the
  ungrounded fallback. Watch the grounding-coverage rate
  (`primary_query IS NOT NULL` on `generated_posts`) for 48 hours, trigger
  keyword refreshes for the clients with no pool, and only flip the flag to
  `true` once coverage is above ~95%. From then on an ungrounded post is
  impossible.
- **T13 — run the structural-pool repair after this deploys, not before.**
  `npx tsx src/lib/db/repair-structural-pools.ts --dry-run`, read the sample,
  then run it without the flag. It rebuilds the empty `structural_pool` arrays
  every non-peptide profile was written with, and re-picks any `skeleton_id`
  the newly-live guards reject. It calls `buildStructuralPool` and
  `pickSkeleton` directly, so **run against the old code it would rewrite
  every row with the same empty arrays it exists to repair.** Idempotent, so
  re-running is safe. If `src/lib/db/repair-compounds.ts` is also queued, run
  that one first — different columns, neither reads the other's output. Snapshot
  first if you want an undo path: `CREATE TABLE style_profiles_backup_t13 AS
  SELECT blog_id, structural_pool, skeleton_id FROM style_profiles;`
- **T13 — grep the logs for `[composer] empty structuralPool` for 24h after
  the backfill.** Any hit is a profile the repair missed; re-run it.

- **T03 — the removal sweep touches ~1,500 live client sites.** The code, the
  queue and the dry-run mode are built; *running* it is a deliberate trigger,
  not something to schedule blindly. Start with
  `?blogId=<uuid>&dryRun=1&limit=25` on one blog, read the diff, then go live
  on that one blog, then let the `*/10` cron drain. T03 §7.3–7.5.
- **T03 — suspend `netgrid-cron-link-exchange` in the Render dashboard now.**
  `render.yaml` no longer defines it, but until the blueprint syncs, the daily
  05:40 UTC run keeps placing links. Delete the service after the deploy lands.
- **T04 — Google Cloud setup.** Create the project, enable
  `searchconsole.googleapis.com` and `siteverification.googleapis.com`, mint a
  service-account key, and set `GSC_SERVICE_ACCOUNT_EMAIL` /
  `GSC_SERVICE_ACCOUNT_PRIVATE_KEY` on the **web** service only. T04 §4.1.
  Until both are set every GSC route no-ops with a 200 — that is the kill switch.
- **T04 — ~1,400 DNS TXT records.** WordPress blogs cannot be verified
  automatically (an application password cannot write site-wide `<head>` markup
  or install a plugin). The code fetches and stores each token; an operator or
  a registrar-API script publishes it. The worklist query is in T04 §7.1. **This
  is the long pole of the whole programme** and it can start before any of this
  code deploys — tokens are stable per domain.
- **T04 — run the 16-month backfill on day one.** Search Console retains 16
  months on a rolling window. Every day of delay permanently loses a day of the
  network's only objective history. Driver script in T04 §7.2.
- **T04 — record the baseline** (T04 §8.3 query D) *before* T01–T03's effects
  land, and keep it outside the database. It is the only before-picture this
  programme will ever have.
- **T07 — decide when to flip `SCRUBBER_ENFORCEMENT` to `enforce`.** It ships
  as `shadow`. Now that the gate is actually wired, flipping it will start
  holding posts. Read a week of `[scrubber-gate]` log lines first to see what
  fraction of the network it would stop.
- **T17 — sign off on two behaviour changes BEFORE `0043` is applied.** Migration
  `0043` re-interprets a bare number in `posting_frequency` as posts-per-**week**
  (it currently means posts-per-**day**, i.e. 7x more), and starts honouring the
  `posts_per_day` column for blogs that publish nothing today. Run the audit
  queries in T17 §7.1–7.2 and get the affected domain list agreed. Pause
  `netgrid-cron-auto-publish-0..3` for the deploy window.
- **T17 — work the triage queue.** Everything migration `0043` could not
  classify lands on the zero plan and raises the new critical notification.
  Query in T17 §7.4; fix each in the blog form.
- **T17 — add a Render log alert on `[auto-publish][ALERT]`** against the web
  service. Shard 0 emits it at most once an hour, only when the count is
  non-zero.
- **T18 — delete `netgrid-cron-post-verification` in the Render dashboard.**
  Removing a service from the blueprint does not delete it. Until someone
  suspends it by hand it keeps firing at `0 0,6,12,18` with no shard
  parameters — the full unsharded sweep, on top of the four new sharded ones.
- **T18 — confirm no Vercel deployment is live before this merges.** This
  commit deletes `vercel.json`. Two of its five schedules pointed at routes
  that do not exist and two exactly duplicated Render, but if some Vercel
  deployment is serving traffic for a domain nobody mentioned, deleting the
  file stops five jobs there rather than two duplicates here.
- **T18 — repair `blogs.last_post_verified_at`.** The sweep has been
  overwriting it with "time of last check" for every blog it reached; it means
  "time of our last publish" and is the auto-publish priority key. Re-derive it
  from `MAX(generated_posts.published_at WHERE status='published')` once, after
  deploy. T18 §7.
- **T18 — set `ALERT_EMAIL_TO`** on the web service, or coverage and
  silent-blog alerts are console + `activity_log` only.
- **T10 — delete `netgrid-cron-refresh-keywords` in the Render dashboard**, and
  populate `CRON_SECRET` on the four new `...-refresh-keywords-N` services
  (it is `sync: false`, so Render prompts rather than copying it).
- **T10 — watch `activity_log` for `keywords.scrape_blocked`** after deploy. If
  it appears, halve `KEYWORD_SCRAPE_CONCURRENCY` first, then
  `KEYWORD_REFRESH_MAX_CLIENTS`. Do not "fix" it by spoofing a browser
  User-Agent — that hides the next block instead of reporting it.
- **T14 — deploy `docs/wordpress/netgrid-seo-bridge.php` to every Yoast site.**
  It goes at `wp-content/mu-plugins/netgrid-seo-bridge.php`, directly in that
  directory (WordPress does not recurse into subdirectories). **Nothing in T14
  works on a site without it** — `updateYoastMeta` now throws there instead of
  silently succeeding, which is the point, but it means Yoast meta writes fail
  loudly until the rollout lands. T14 §5 Step 3 covers doing this at 1,500-site
  scale. Run a connection test afterwards to populate `blogs.seo_bridge_version`.
- **T14 — then run the backfill, per blog, measure first.**
  `/api/cron/yoast-meta-backfill?blogId=<uuid>&dryRun=1` reports the real damage
  without writing; drop `dryRun` to repair. Only sweep the network once one blog
  shows `stillBroken: 0`. It skips un-bridged blogs by default.
- **T15 — roll out the second MU-plugin.** `docs/indexnow/netgrid-indexnow.php`
  goes at `wp-content/mu-plugins/netgrid-indexnow.php`. Without it a site has
  no spec-compliant key file and every IndexNow ping is rejected — but now it
  is *recorded* as rejected instead of looking fine. `docs/indexnow/README.md`
  has the install and verification commands.
- **T15 — run `npm run db:backfill-indexnow` (dry run first).** It mints
  per-blog keys, deletes the junk "IndexNow Verification" page the old code
  published on every Shopify storefront, and prints the MU-plugin worklist.
  **Then delete `INDEXNOW_KEY` from Render** — in that order, because the old
  value is the only way to find the junk media uploads it names.
- **T15 — the service account needs Full user on each Search Console
  property.** `sitemaps.submit` returns 403 with no useful hint otherwise, and
  Restricted is not enough. The property must already be verified by a human;
  the API cannot verify one.
- **T19, when you get to it, needs a communications plan.** It makes
  client-facing scores drop sharply. T00 §4 is explicit that it should be
  scheduled, not shipped opportunistically.

---

## Migration numbering

The SOPs assume the next free migration is `0039`. It was not — `0039` is
`pipeline_telemetry` from T22. Actual numbering on this branch:

| File | Task |
|---|---|
| `0040_publish_idempotency.sql` | T08 |
| `0041_link_exchange_shutdown.sql` | T03 |
| `0042_search_console.sql` | T04 |
| `0043_posting_plan.sql` | T17 |
| `0045_post_verification_retention.sql` | T18 |
| `0046_keyword_pipeline_scale.sql` | T10 |
| `0047_yoast_meta_verification.sql` | T14 |
| `0048_semantic_linking_refresh.sql` | T16 |
| `0049_indexnow_per_blog_keys.sql` | T15 |
| `0050_covered_queries.sql` | T11 |
| `0051_keyword_winnability.sql` | T09 |
| `0052_authors.sql` | T12 |
| `0053_quality_score.sql` | T19 — the SOP calls it `0039` |
| `0044_drop_legacy_cadence.sql.pending` | T17 follow-up — **inert**, the runner globs `*.sql` |

**T24, T25 and T26 each also call their migration `0039`.** Next free is
`0054`. **T23 landed without a migration** — it changes how a body is
processed, not what is stored, so this is unchanged.

If you apply an SOP verbatim, **check the highest existing file first.**

---

## Known gaps in what was shipped

Flagged deliberately rather than quietly left.

- **T19 scores NULL for every post until two operational things happen** —
  a PageSpeed key plus a drained vitals backlog, and a verified URL match
  between `search_performance.page` and `generated_posts.external_post_url`.
  Both are in Operator actions above. This is the honest state, not a bug:
  the engine is wired and tested, and it declines to publish a number it
  cannot justify.
- **T19's `readability_score` and `brand_voice_score` have no implementation
  and are now permanently NULL.** They were 70 for every row in the table
  before. Nothing reads them except one cell in the public API. Either build
  a real readability measure or drop the columns — leaving two nullable
  columns nothing ever writes is how the 70 survived in the first place.
- **T19 keys indexation by `post_id`, not by URL.** The SOP assumed an
  `index_coverage(page_url, indexed boolean)` contract; T04 actually shipped
  `index_coverage(post_id UNIQUE, inspected_url, verdict varchar)`. Keying by
  post id is strictly better — it is uniquely indexed and survives a URL
  rewrite — but it means the verdict is interpreted from Google's
  `PASS/PARTIAL/NEUTRAL/FAIL` vocabulary rather than read from a boolean. The
  mapping is documented in `gsc-signals.ts`; if Google changes that
  vocabulary, that function is the single place to change.
- **T19's "measured zero" inference is an addition to the SOP, not a
  transcription of it.** Search Console never emits a row for a page with
  zero impressions, so the SOP's expected `impressions = 0` row does not
  physically exist in GSC data, and "no rows for this URL" would have read as
  "no data" for exactly the invisible pages the score exists to catch. A
  blog-level probe resolves the ambiguity: if the blog is reporting and this
  URL drew nothing, that is scored as a real zero. If that inference is ever
  judged too aggressive, it is one branch in `getSearchRollup`.
- **T19 left the blog-aggregate backfill as SQL, not a script.** The migration
  nulls `blogs.current_seo_score`, and `recomputeBlogQualityScore` refreshes
  it on every post scored — so the aggregate follows automatically as the
  cron drains. To force a full pass without re-scanning posts, the T19 SOP
  §7.2 has a single `UPDATE ... FROM` that performs the same arithmetic. Use
  it for the initial backfill only; after that let the application own the
  column so there is one writer.
- **JSON-LD `inLanguage` is still omitted** (T20). `generated_posts` has a
  `language` column but `blogs` does not, and a wrong language tag is worse
  than no tag. **T24 adds a per-blog language mode — wire it into
  `buildArticleGraph` when it lands.**

- **T20 reads the FAQ back out of the rendered body, not from the model's
  array.** By the time the markup is built, `dedupeHeadings` may have deleted a
  question that restated an earlier heading and `capWordCount` may have trimmed
  the tail — so the raw `faq[]` can name answers that are no longer on the
  page. Markup claiming an answer the reader cannot see is the most common
  cause of a structured-data manual action. The body is the source of truth;
  the raw array is used only when the body carries no Q/A section at all.
- **T20's pre-publish body block deliberately omits the Article node.** It
  emits FAQPage + BreadcrumbList only, because Yoast or the Shopify theme
  already emits an Article on those pages and a second one is duplication, not
  enrichment. The full graph is written *after* publish and *only* on
  plugin-less WordPress, where our block is the only structured data the page
  will ever have.
- **The `netgrid-seo` literal is gone from both emitters, and upgrades itself
  out.** Fences are now an opaque per-site FNV-1a token — stable per site so
  idempotency holds, different across sites so there is no shared string to
  search for. Both upsert paths still MATCH the legacy branded fences, which is
  what makes the vendor name physically leave a live page on the first re-run
  rather than lingering beside a new block. Verified against both forms.
- **T20's SOP expects `author_name` / `author_url` / `author_same_as` columns
  on `blogs`, which T12 did not add.** T12 made an author a first-class row in
  the `authors` table instead, because one person can write for several of a
  client's blogs and because consent and evidence must live next to the
  identity they authorise. `structured-data.authorIdentityFrom()` is the seam,
  so the builder stays pure and the lookup stays in `author-entity.ts`.
- **T12's author PAGES are not built — steps 7 of its SOP is deferred, and the
  code degrades correctly without it.** `authorJsonLdNode` omits `@id` and
  `url` when `authors.author_page_url` is null, so the Person node is emitted
  without a dangling identifier rather than pointing at a 404. The byline, the
  YMYL gate, the credential strip and the JSON-LD author all work today; what
  is missing is publishing `/pages/author-{slug}` on Shopify and the matching
  WP page, plus `ensureAuthorUser` for the WP `author` field. Until then an
  author is named and described but not linkable, which is a weaker entity
  signal than the design allows for — not a broken one.
- **T12 found two defects my own T13 work had introduced.** T13 added
  `CROSS_NICHE_FLOWS` and a cross-niche quirk table, and both carried copies of
  the very strings T12 exists to remove — a "composite/fictional practitioner"
  interview flow and an "A practitioner I spoke with" anecdote. The T12 SOP
  predates T13 and could not know. Both are fixed; the lesson is that a
  prompt-library fix has to grep the whole library, not the lines the SOP names.
- **The SOP's `authors` schema does not compile as written.** It puts a
  `.references(() => authors.id)` on `blogs.default_author_id` while
  `authors.blog_id` references `blogs`, and asserts "the arrow defers
  evaluation, so this is fine". The arrow defers the *value*, not the *type*:
  tsc fails with TS7022 on both tables. Since drizzle-kit is not the source of
  truth here, the column is a plain `uuid` in the schema and the FK constraint
  is declared in migration `0052`, where Postgres enforces it identically.
- **At $20/month, `keyword_difficulty` will be absent for most of the network
  for a long time — and T09 is built for that.** One full pass over N clients
  costs `N x MAX_SEEDS_PER_RUN x C`, where C is the measured USD per seed. At
  1,500 clients that is ~$150 per pass at C=$0.01 and ~$750 at C=$0.05, so $20
  buys roughly 200 clients/month (13% of the network) in the cheap case and
  ~40 (under 3%) in the expensive one. **Measure C from `dataforseo_runs`
  before assuming which end applies.** The winnability score handles this by
  design: NULL difficulty is *scored* at a neutral prior (45) and **never
  filtered**, and within the Autocomplete-only population the difficulty and
  competition factors are the same constant for every row and cancel out of
  their relative order — so the ranking reduces to `log(hit_count) x long-tail
  bonus`, which is still a large improvement on the popularity sort, and
  sharpens automatically as real difficulty data arrives. The SOP's advice to
  "not start T09 until Step 10 has covered a meaningful share of the network"
  was written assuming a budget that covers the network quickly; at $20 that
  would mean waiting years, so T09 was built to degrade instead of to wait.
- **T09's clustering changed what `verify-local-targeting.ts` asserts.** Its
  fixtures are themselves a clustering case: "buy smoketest widgets" and
  "smoketest widgets for sale" are near-duplicate transactional phrasings and
  now fold into one row. The old `upserted === FIXTURE_KEYWORDS.length`
  assertion would now be asserting the *bug*, so it is
  `EXPECTED_TARGET_ROWS = 2`. The fixture client also gained
  `localPresence: true`, because the transactional fixtures exist to exercise
  the city-framed path and T09 gates that on the client actually operating
  somewhere.
- **`blog_keyword_targets.city` is still populated on city-FREE rows.** It is
  the build-time snapshot and part of the uniqueness key. Reading it without
  checking `local_framing` is exactly the bug T09 fixes, and both generation
  call sites now gate `localTarget` on that flag. If you add a third call
  site, it gates too or it is a bug.
- **T05's Step 11 was already built — by T01.** The SOP specifies a new
  `src/lib/seo/brand-title.ts` that pixel-budgets a brand suffix around
  `appendRedditToTitle` in `reddit.ts`. That file no longer exists: T01 deleted
  it and shipped `src/lib/seo/meta-suffix.ts`, whose `appendBrandToTitle` is
  the same injector, already pixel-budgeted, already idempotent, already
  brand-yields-first, and already wired through `normalizeMetaTitle`. Building
  the SOP's version would have put two modules on one write surface — the
  failure mode the `netgrid-gsc`/`netgrid-seo` marker note below describes.
  T01's rule also **overrides T05's** on where the brand comes from: T05 says
  "`blogs.brand_name`, or `deriveBrandName()` from the domain"; T01 says the
  title tag takes the operator-confirmed column **only**, never the derived
  suggestion. The callers already do it T01's way and were left alone.
- **T05's brand rule shipped malformed JSON in the SOP as written.** The
  specified text is ``then end with " | ${brand}"`` — interpolated *into* the
  JSON example that the OUTPUT FORMAT block presents as the model's output
  contract. The double quotes close the surrounding JSON string value early, so
  the model was to be shown a malformed object and asked to return one like it.
  Fixed with single quotes **and** `escapeForJsonString(brand)`, because
  `blogs.brand_name` is operator-entered free text: a store called
  `Joe's "Best" Peptides` breaks it again otherwise. `article-prompt.test.ts`
  parses the rendered contract with `JSON.parse` on all three cases.
- **T05 replaced T11's `GenerateOptions.supportingQueries` rather than adding
  beside it.** T11 added that field as a placeholder and nothing ever read it.
  Carrying both it and `searchIntent.relatedQuestions` would be two fields
  meaning the same thing, which is how the two drift apart.
  `IdeatedTopic.supportingQueries` is untouched — it still feeds
  `generated_posts.supporting_queries` as the audit trail, and now also feeds
  `relatedQuestions`.
- **T05's shape-retry fallback keeps the brief and the facts policy.** The
  retry prompt deliberately strips voice, style and structure to recover a
  well-formed JSON object. Left as the SOP had it, it also stripped the SEARCH
  BRIEF and the FACTS POLICY — so a recovered article answered nothing in
  particular and was free to invent figures. Those two are the point of the
  page, not decoration on it.
- **T11 deliberately makes some blogs stop publishing.** A blog that has
  covered every demand-validated query in its client's pool now returns
  `exhausted: true` and publishes **nothing**, where the old code published a
  topic it had already measured as a 40%-overlap duplicate. This is the
  intended behaviour and it is measurable. Do **not** "fix" it by restoring the
  accept-the-duplicate branch — a blog that has genuinely exhausted its pool
  needs a keyword refresh (`/api/cron/refresh-keywords` or a DataForSEO pull),
  not another rehash. The exhausted message classifies as non-transient
  (`isTransientFailure` in `publish-slots.ts` matches none of its substrings),
  so `publishOne` reports it exactly once without burning a retry — verified by
  reading the classifier, not assumed.
- **T11 makes the weekly keyword-refresh cron operationally load-bearing.**
  `netgrid-cron-refresh-keywords` (Mondays 03:00 UTC) is now what replenishes a
  blog's ability to publish *at all*. A client whose scrape has stalled will hit
  exhaustion instead of quietly emitting invented topics. Watch the exhaustion
  count as a keyword-freshness alarm.
- **T11's manual path records coverage at draft-persist time, not publish
  time**, because otherwise the next run re-ideates straight into the draft's
  subject. A draft the operator later deletes therefore leaves an orphan
  coverage row — `generated_post_id` is `ON DELETE SET NULL`, not cascade, and
  that is deliberate: deleting a post should not silently free its subject for
  immediate re-coverage. To genuinely release them:
  `DELETE FROM blog_covered_queries WHERE generated_post_id IS NULL AND source
  <> 'backfill' AND covered_at < now() - interval '7 days';` Run it manually,
  never on a schedule.
- **`normalizeQueryKey` and `tokenize` must not drift.** The backfill writes
  `query_norm` through the TS helper and the runtime matches on it; two
  normalisation implementations would mean the backfill writes keys the runtime
  can never match, and every blog silently restarts from an empty history.
  This is why the key is never computed in SQL, and why
  `ideation-grounding.test.ts` asserts the two pipelines agree. If you ever
  need it in Postgres, it needs the `unaccent` extension and it will drift.
- **T13 found four peptide-vocabulary leaks the SOP did not list**, and its
  own acceptance criteria could not pass without fixing them. The SOP treats
  `templates.ts` as the only library carrying peptide-specific text. It is
  not: three of five `citation-styles.ts` examples are peptide research
  ("a 2020 paper published in Peptides", "the BPC-157 thread on r/Peptides"),
  five `quirks.ts` prompt instructions reach for compounds, vials and mcg
  doses (quirk 8 names BPC-157 and "pentadecapeptide" outright), and
  `BLOCK_COMPLIANCE`'s prohibition list is peptide vocabulary — which reaches
  **gambling and online_casino**, because those niches do carry compliance
  phrases and so take the phrase-bearing block, not the SOP's phrase-free
  one. All four are fixed the same way `CROSS_NICHE_FLOWS` fixes templates:
  peptide sub-niches (1-13) keep the original string byte-for-byte, everything
  else resolves a subject-neutral variant. `BLOCK_COMPLIANCE_NEUTRAL_SUBJECT`
  keeps the phrase machinery identical and swaps only the prohibition list.
  Quirk `detector` functions are deliberately **not** varied — they run over
  generated prose in the scrubber, and loosening them is a separate decision.
- **T13's peptide path is not byte-identical, contrary to the SOP's §7.3
  claim** — and that is correct. A pinned differential across 4 peptide
  sub-niches × 12 skeletons × 3 templates shows exactly two differences, both
  intended fixes that happen to land on peptides too: `{citation.style}` now
  substitutes instead of shipping the raw token to the model, and skeleton
  12's compliance clause moved onto its own line. Nothing else moved — no flow
  label, no compliance block, no quirk. Re-run that check before touching the
  composer again; the harness is three files and a `git stash`.
- **T13 changes the RNG draw order.** `pickCadence` now runs before
  `pickSkeleton`, so for a given `blogId` seed `assignProfile` produces a
  different profile than it did before this deploy. Persisted rows are
  untouched and nothing recomputes them, but **`reassignProfile` is no longer
  idempotent across the deploy** — an admin re-roll returns a different
  profile than the same re-roll would have yesterday. Say so in the release
  note.
- **Peptide sub-niche 13 (Sleep / circadian, ~40 blogs) changes behaviour**,
  which is the one peptide-side improvement to expect. It is listed in exactly
  one template's `subNicheFit` (T17), so the old tier 3 returned a
  **one-template pool** and every sleep/circadian blog wrote from T17 forever.
  It now falls through to tier 4 and gets a proper 3-5 pool. No other peptide
  sub-niche moves.
- **`resolveShard` throws outside the telemetry wrapper** (T08). A bad shard
  param from a non-route caller won't get a `cron_runs` row. The route
  validates first and returns 400, so this is defence-in-depth only.
- **Held posts send their keyword target to a terminal `failed`** (T07),
  matching the neighbouring publish-failure path. That is the ledger-draining
  bug T10 owns; this deliberately did not diverge ahead of that fix.
- **`shopifyCredsFromBlog` is now one implementation** in
  `src/lib/services/shopify-creds.ts` (T04 assigned this to T15). The nullable
  `shopify_auth_mode` defaulting to `client_credentials` was being re-derived
  at four sites; getting it wrong in one silently breaks auth for every
  legacy-token store in that subsystem.
- **The `netgrid-gsc` and `netgrid-seo` theme markers must stay distinct.**
  Both write into the same Shopify theme assets and are kept apart only by
  their marker strings. Generalising either regex to `netgrid-\w+` would make
  one subsystem silently delete the other's block, and affected stores would
  lose Search Console ownership with no error raised. Do not "tidy" them.
- **T17 ships a legacy dual-write.** `createBlog`, `updateBlog` and both CSV
  insert paths still write `posting_frequency` / `posting_frequency_days` so a
  code rollback has data to read. Nothing *reads* them. Delete the three
  `LEGACY DUAL-WRITE` blocks and rename `0044_...pending` one week after
  `0043` lands, not before.
- **T18's shard parser is strict where the SOP specified lenient.** The SOP
  collapses a malformed `?shard`/`?shardCount` to (0 of 1). That is the
  failure mode T08 already fixed on the auto-publish route, and here it is
  worse: a typo turns the shard filter into a no-op, so one service sweeps the
  whole network — the unsharded run that blows through curl's `--max-time` and
  gets retried. The route answers 400 instead, which curl does not retry.
- **`pipeline-alerts.ts` was a fourth cadence reader the T17 SOP did not know
  about** — T22 added it after the SOP was written. Its raw-SQL silence rule
  now derives `expected_hours` from `posting_plan` like everything else. If you
  add another cadence consumer, it reads `posting_plan` or it is a bug.
- **T10 Step 10 (the budgeted DataForSEO cron) is NOT implemented.** The SOP
  gates it behind `DATAFORSEO_CRON_ENABLED` and says explicitly that it can
  ship in a follow-up deploy without blocking the rest. It also spends real
  money on a schedule and needs a finance-approved
  `DATAFORSEO_MONTHLY_BUDGET` derived from measured per-seed cost (T10 §5
  Step 10 has the queries). **T09 depends on it** for keyword difficulty data
  — do it before starting T09.
- **T10 reuses `src/lib/cron/sharding.ts` rather than adding the SOP's
  `src/lib/cron/shard.ts`.** Same function, same SHA1 bytes 8-15; T18 already
  extracted it. A second copy would be the drift the extraction exists to
  prevent.
- **T10 replaced T08's `releaseStuckKeywordTargets`** with a two-window reaper.
  T08's version ignored `generated_post_id` and could reap a row whose post was
  mid-publish, handing the same keyword out twice. The old name survives as a
  shim so the auto-publish hot path did not change.
- **T14's backfill requires the bridge by default**, which the SOP left as an
  operator discipline note. Without that filter every post on an un-bridged blog
  burns a live fetch plus a REST write, comes back `stillBroken`, and stays in
  the candidate set — so the next run does it all again. `requireBridge=0` is
  available for a deliberate dry-run measurement.
- **T16 fixed a pre-existing bug in `toCanonicalUrl` rather than copying it
  verbatim as the SOP instructed.** The `URL.host` setter parses its value as
  `host[:port]` and *leaves the existing port* when the value carries none, so
  a self-hosted WordPress URL like `http://1.2.3.4:8080/x` became
  `https://example.com:8080/x` — still rejected by IndexNow, and a broken
  internal link now that the linking engine uses the same helper. The unit test
  is what caught it. `u.port = ""` is now set explicitly.
- **T16's publish hook raises peak concurrency.** Up to 12 simultaneous
  publishes (4 shards x concurrency 3), each now also spawning one embedding
  call plus up to 6 serial platform writes — worst case ~72 in-flight platform
  writes for a few seconds per tick, all against *different* stores and all
  outside the request's await chain. Safe on Render (`next start` is a
  long-running process, so floating promises complete). **If the network ever
  moves to a serverless host this hook must become an awaited call or a queue**,
  or the writes are silently truncated.
- **T03's removal cron and queue table are temporary.** Delete
  `netgrid-cron-link-exchange-removal`, the route, the service file and
  `link_exchange_removals` once the queue drains and is signed off (T03 §7.7).
