# SEO-loop build — what actually shipped (S0–S8)

Status as of 2026-09-26, branch `main`. The build order followed the brief
(`docs/mega-prompt-compact.md`): S0 → S6 → S1 → S2 → S8 → S7 → S3 → S4 → S5.
Every claim below is backed by the named commit and the gates listed at the
bottom.

## 26sept readiness snapshot (board re-verified commit-by-commit before pushing branch `26sept`)

Re-checked 2026-09-25 immediately before the `26sept` push: `git fetch --all` →
`main` = `origin/main` = `origin/dre22sept` = `daeea62`; working tree clean;
gates re-run live: `tsc --noEmit` 0 · vitest **742/742 across 55 files, zero
skips** · lint clean · build 0 · `git diff --check` clean. Artifact greps:
`--revert` + 4 DOWN scripts + `migrate.test.ts` present; `hygieneLedgerTelemetry`
present; `?hygiene=1` cursor mode at `search/route.ts:121`; `gsc-sync-route.test.ts`,
`search-route.test.ts`, `report-actions.test.ts` present; §B.8 + the session record
below present. Environment re-confirmed credential-free: no `.env`/`.env.local`,
no `DATABASE_URL` / `CRON_SECRET` / `OPS_API_KEY` / `MARKETING_API_KEY` in the
process env.

| Row | State | Evidence / named blocker (G5) |
|---|---|---|
| R0 baseline | DONE | `c522655` confirmed on all three refs at session start; gates 698/698 then, 742/742 now |
| R1 bring-up | BLOCKED | needs dev `DATABASE_URL` + `CRON_SECRET` (+ `MARKETING_API_KEY`); none exist in this environment |
| R2 revert tooling | DONE (`1f41a6d`) | `--revert` flag, 4 DOWN scripts, 18 tests; §I.2 apply/revert TRANSCRIPT BLOCKED on `DATABASE_URL` |
| R3 fixture replay | BLOCKED | needs dev `DATABASE_URL` + `CRON_SECRET` + admin login |
| R4 auth matrix | DONE statically / BLOCKED live | `apiAuthGuard` = shared `MARKETING_API_KEY`, not sessions, not `OPS_API_KEY` (§B.8); live curl matrix needs the keys + portal logins |
| R5 both gaps | DONE (`ce7c88a`) | `hygieneLedgerTelemetry` + `?hygiene=1` cursor mode + 17 tests |
| R6 smoke + F1 audit | BLOCKED | needs WP/Shopify dev-blog platform creds + dev `DATABASE_URL` |
| R7 wiring tests + budget audit | DONE (`18cede6`) | failing-shard route tests + report-actions tests; LLM budget table below |
| R8 docs | DONE (`3e841fc`, `daeea62`) | §B.8 amendments, §E post-build resolution, this record, refreshed next-session prompt |

Every row that can be executed without credentials is done and committed; the
BLOCKED rows stay blocked until an operator provisions the named credentials
(see "Remaining operator actions" below). Per G5, no pass has been faked.

## Package map (SEO loop v1)

| Pkg | What | Commit(s) | Spec |
|---|---|---|---|
| S0 | GSC-aware ideation pool + live ledger re-rank | `bf9b613` | mega-prompt-compact.md §S0 |
| S6 | Client SEO dossier (0059, merged read, context block, editor) | `e533e10` | §S6 |
| S1 | Page-2 goldmine rescue loop (0056, apply/verify/outcome) | `41cd3b7` | §S1 |
| S1 surfaces | Goldmine tab, /review queue, portal card, v1 rescues, PDF section | `a3767de` | §E row S1 |
| S2/S8 | Query hygiene — split/folded/pin/dead in one pass (S8 = dead-weight) | `41cd3b7` | §S2, §S8 |
| S7 | 30-day sprint engine — deterministic plans, stored artifacts | `b3bdf0b` | §S7 |
| S3 | Service × location matrix + shared atomic claimer (0057) | `b18b1ac`, `739d4ce` | §S3 |
| S4 | GBP optimization packs (0058) — seven deterministic outputs | `6915d6d` | §S4 |
| S5 | Review-velocity math + response SLA | `e2ca474` | §S5 |
| §E completion | Weekly rotation/freshness checks + PDF dossier/appendix/parity/hygiene sections | this commit | §E rollout matrix |

## S3 — service × location matrix + shared claimer — SHIPPED

Commits: `b18b1ac` (feature), `739d4ce` (completion fixes).

- `0057_location_page_targets.sql` + schema lockstep (unique blog+service+place,
  claim index, client index).
- `services/location-matrix.ts`: pure planner + idempotent builder. Services
  from the same commercial-intent seam the keyword ledger uses; places from
  `blogs.city`, the client's OTHER-blog cities (client-scoped DISTINCT — the
  `clientCities` pattern), `site_profiles.neighborhood` + `additional_areas`.
  Skip reasons `no_local_presence` / `already_covered` / `duplicate_cluster`;
  winnability-rank priority; row cap.
- Shared claimer in `actions/content-generation-actions.ts`:
  `claimNextTargetedPageForBlog` — location ledger first, legacy keyword ledger
  second, one `ClaimedTargetPage` shape. Selection+claim are ONE atomic UPDATE
  (candidate subquery + `status='pending'` re-check), lost races retry the next
  candidate then fall through. Ordering (priority asc, untried-first, oldest
  attempt, id) mirrors the pure comparator. Daily budget counts EVERY attempt in
  24h — failures included. `locationCampaignEnabled` gates it.
- Gate: `requireReadyLocalProfile` refusal on a matrix row = requeue to pending
  with the reason and a 6h cool-off (never terminal-skip); legacy keyword rows
  keep their byte-identical pre-S3 disposition (regression-tested).
- Skeleton #13 "Local Service Page" forced on BOTH paths — composer override
  with a locked profile, `pageStructure` directive without one (logged either
  way). FAQ path + JSON-LD unchanged downstream.
- Surfaces: `/locations` index (scalar-subquery counts — no join multiplication),
  `/locations/[clientId]` grid with status chips, coverage %, drip counter,
  Build-matrix button, and the reason-required operator skip (pending rows only,
  terminal). Portal location-pages line; PDF coverage line; v1
  `locationPages=1&since=` cursor endpoint.

## S4 — GBP optimization packs — SHIPPED

Commit: `6915d6d`.

- `0058_gbp_packs.sql`: `gbp_assets` (INSERT-only audit trail of what we
  promised) + `gbp_description_versions` (750-char cap in code AND DB CHECK,
  applied_at, performance_note), schema lockstep.
- `services/gbp-packs.ts`: the seven outputs are DETERMINISTIC COMPOSITION —
  categories (ranked by real services), attributes diff (unverifiable attrs get
  "cannot verify — ask on call", never a false add), services with 40–60-word
  descriptions + cross-check gaps, description A/B ≤750 chars with a 30-day
  rotation schedule, 8-post calendar (no area repeats within 4 slots; the
  payload says so honestly when <4 real places exist), photo queue
  (`<type>-<area>-<date>.jpg`, competitor velocity +1 or an honest gap), review
  templates (≤80 words, no discounts, real-business sign-off). Missing facts
  render "not provided — ask on next call". Deliberate deviation: no LLM call —
  a model cannot guarantee the no-invented-facts DoD; justified in the module
  header. `targetUrl`s come only from actually-published pages (F1).
- Competitor paste → parsed into `client_seo_dossiers.competitorProfiles`
  (same-name replace, capped); unnamed pastes rejected; nothing defaulted.
- GBP tab on the client page: paste form, pack cards (print CSS), rotation
  table with mark-applied, one-PDF-page-per-pack download route (same
  @react-pdf primitives as the report).
- `GET /api/v1/ops/gbp-packs?clientId=&since=` (opsAuthGuard + cursor) — the
  promise audit. Portal: "GBP action plan: N items ready" (counts only).
- **§E row completed:** the 30-day description rotation check now runs in the
  gsc-sync pass per client (`checkDescriptionRotation`; pure core
  `rotationDueFromVersions` — due only when the live version is ≥30 days old
  AND an unapplied alternate exists; the operator flips it in the gbp tab,
  never the machine). The monthly PDF gains an **appendix page when packs were
  SENT** (`summarizeGbpPacksForAppendix` — ready-but-unsent packs never reach
  the client PDF).

## S5 — review velocity + response SLA — SHIPPED

Commit: `e2ca474`.

- `services/review-velocity.ts`: the documented formula
  `ceil((theirCount − ourCount) / max(1, theirRatePerMonth − ourRatePerMonth))`
  from pasted review-DATE history, computed not generated. Edge states are
  explicit in the UI: ahead → maintain mode; <6 months of dates on either side
  → the number labeled "estimate (short history)"; missing dates → NO number,
  only the gap list; unparseable paste lines are reported, never dropped.
- Response SLA: ≤24h first response, templates pre-filled from S4 pack 7, the
  operator response log stored as `gbp_assets` 'reviews' payload rows (no new
  table, per the brief), and the renewal line counting only what was logged.
- **§E row completed:** the PDF now carries the **renewal one-liner** when the
  top competitor is ahead/behind parity (`renewalParityLine`; missing data →
  the line omits, F8).

## S6 — client SEO dossier — SHIPPED (+ §E row)

Commit: `e533e10`.

- 0059 + schema lockstep; merged read (`getDossierForClient`), pure
  byte-stable context block (≤1200-token budget, truncation order competitor →
  wins → audience → area; business_model/differentiators never truncate),
  editor stamping `last_verified_at` on every save, portal read-only line.
- **§E row completed:** the gsc-sync run now carries the **stale-dossier
  counter** (`runDossierFreshnessCheck`; exactly-90-days is fresh, 91+ is
  stale, unparseable stamps count as never-verified) and the monthly PDF has
  the **"What we know about your business"** first-page section from the SAME
  merged view prompts get.

## §E parity-rule completion (S2/S8 → PDF)

The rollout matrix routes S2 ("consolidated under sprint notes") and S8 ("under
sprint notes") into the monthly PDF. `openHygieneCountsForClient` +
`hygieneNoteLine` now print one honest line of OPEN split/folded/pin/dead
counts under the sprint section — decided rows never reappear, all-zero omits
the line (F8).

## Gates (this session, local)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 698/698 across 51 files (622 pre-S3 baseline; S3 +26, S4
  +22, S5 +10, §E completion +16, incl. the legacy ledger claim regression).
- `npm run lint` — clean (first full lint run also flushed pre-existing
  unused-import/unescaped-entity debt).
- `npm run build` — clean.

## Still blocked on credentials (unchanged)

- Migration replay/rollback of 0057/0058/0059 on a real dev DB (`DATABASE_URL`
  unavailable in this environment). All three are idempotent and written to the
  runner's tolerance rules; the DB CHECK on `gbp_description_versions` is the
  only new constraint.
- The live end-to-end publish checks (one dev-blog location page through
  claim → generate → publish → verify; a real GBP pack build on fixture data)
  need platform credentials + a reachable dev blog.

## Verification session — 2026-09-25 (R0–R8 readiness pass)

Baseline RE-verified independently at session start (prior session's claims were
unconfirmed until now):

- **Git:** `git fetch --all`, then `git log --oneline -3 main origin/main
  origin/dre22sept` — **all three at `c522655`.** The previously-reported push
  HAD landed; nothing needed pushing. Cosmetic note: the LOCAL `dre22sept`
  branch pointer is stale at `fb1bdd5` (its REMOTE branch is correct and
  current); the local pointer was intentionally not touched. Working tree was
  clean except the untracked `docs/mega-prompt-remaining.md`.
- **Gates, actual results:** `npx tsc --noEmit` → exit 0 · `npx vitest run` →
  **698/698, 51 files** · `npm run lint` → "No ESLint warnings or errors",
  exit 0 · `npm run build` → exit 0 · `git diff --check` → clean.

### R2 — migration replay + individual revert — code SHIPPED (`1f41a6d`), transcripts BLOCKED

- `node src/lib/db/migrate.mjs --revert 00NN` accepts the exact filename, the
  name without the extension, or the unique numeric prefix; runs the sibling
  `<file>.down.sql`; **refuses** while any later migration is still applied;
  errors when the DOWN script is absent; deletes the tracking row after a clean
  revert. The forward pass never sees `.down.sql` files (`isForwardMigration`).
- Four DOWN scripts written in reverse-dependency order with `IF EXISTS` —
  0056 drops its own index then its two columns (both introduced BY 0056, no
  shared columns); 0057 drops its indexes, its table, then
  `site_profiles.additional_areas`; 0058 drops the gbp index then both tables
  (the 750-char CHECK dies with `gbp_description_versions`); 0059 drops the
  dossier table.
- 18 unit tests pin the pure surface (`src/lib/db/migrate.test.ts`): forward
  file selection, every `--revert` resolution case incl. the later-migration
  refusal, and the statement splitter the revert path shares.
- **§I.2 apply/revert transcript: BLOCKED — missing `DATABASE_URL`.** No
  `.env`/`.env.local` exists and no `DATABASE_URL`/`CRON_SECRET`/`OPS_API_KEY`
  is set in the process env (verified). Not faked (G5).
- **Lockstep (§I.2) verified by INSPECTION, not drizzle-kit:** repo convention
  (`docs/remediation-status.md`, `migrations/README.md`) explicitly forbids
  running `drizzle-kit generate`. `schema.ts` defines `locationPageTargets`,
  `gbpAssets`, `gbpDescriptionVersions`, `clientSeoDossiers`,
  `seoIssues.issueKey`/`preSnapshot` and `siteProfiles.additionalAreas` —
  matching 0056–0059 one-for-one.

### R5 — the two real code gaps — SHIPPED (`ce7c88a`, +17 tests)

- **R5a (§E S8 telemetry):** `hygieneLedgerTelemetry()` in
  `services/query-hygiene.ts` counts per-family OPEN-vs-DECIDED rows over the
  existing `seo_issues` ledger (F4 — pure counts, no new tables; decided =
  approved/applied/verified/dismissed/failed). Surfaced in the gsc-sync
  response as `hygiene.open` / `hygiene.decided` and as a one-line
  detected-vs-decided summary on the /review GSC-loop card (omits entirely
  while the ledger is empty — F8).
- **R5b (parity rule):** closed IN CODE (the preferred option over a written
  exception): `GET /api/v1/clients/[clientId]/search?hygiene=1&since=&limit=`
  — open AND decided hygiene rows (split/folded/pin/dead only), public fields
  only (no fixPayload, no description), same `parseSince` window convention,
  same 1..500 limit clamp, strict-`>` `nextCursor` on `detectedAt`.
  Route-level tests pin the cursor contract, auth denial, non-uuid 400, and
  the rescues=1 parity convention (`src/app/api/v1/clients/search-route.test.ts`).

### R7 — cron-wiring tests + LLM budget audit — SHIPPED (`18cede6`, +9 tests → 742/742, 55 files)

- **Failing-shard at the fold point** (no separate rescue cron routes exist —
  the fold into gsc-sync is the accepted deviation): `gsc-sync-route.test.ts`
  proves one blog's rescue pass throwing → 200 with considered=2/detected=1
  and the hygiene pass still running for BOTH blogs; a hygiene pass throwing →
  rescue metrics untouched; the telemetry read failing → zeroed open/decided
  counts and a 200; a bad secret → 401 before anything runs; unconfigured →
  200 skip with freshness still counted.
- **report-actions wiring** (`report-actions.test.ts`): `generateReportForCron`
  stores the built plan as the report row's `rawData.sprint` for the period;
  `emailReportPdfInternal` PDF data carries Queries-that-moved (period-filtered,
  resolved-only), the STORED sprint + last-month score (read from the row, not
  recomputed), the dossier first page, the S3 coverage line, the REAL
  `renewalParityLine` output and the hygiene note; the GBP appendix renders
  ONLY `sent_to_client` packs (a ready-but-unsent pack is proven absent;
  `sentOn` from the newest sent pack); the hygiene note omits when the open
  ledger is all-zero (F8).
- **LLM budget audit — every generate\* call site + its per-run constant:**

| Call site | Generator | Per-run cap | Env override |
|---|---|---|---|
| `page2-rescue.ts` detection-time proposals | `generateProposalForFinding` → `generateRescueMeta` (claude-client) | `RESCUE_MAX_GENERATED_PER_RUN` = 5 per client-day, SHARED with pin (stateless count of `(page2:% OR pin:%)` rows with a proposal opened today) | `RESCUE_MAX_GENERATED_PER_RUN` |
| `query-hygiene.ts` pin proposals | same generator verbatim ("two detectors, one machine") | same shared client-day cap | same |
| `seo-autofix.ts` apply, `query_rescue` branch | `generateRescueMeta`, exactly ONE retry when the stored proposal is missing | apply volume bounded by `RESCUE_MAX_APPLIED_PER_BLOG` = 3/blog/run and `RESCUE_MAX_APPLIED_NETWORK` = 15/run | both env-tunable |
| `seo-autofix.ts` legacy scanner fixes | `generateSeoFix` / `callFixModel` | one call per issue actually applied; volume bounded by the same apply budgets | — |
| `query-hygiene.ts` dead-weight link research | `findTopicalLinkRefs` (embeddings, not chat LLM) | `DEAD_LINK_RESEARCH_CAP` = 3/run; ledger capped at `DEAD_MAX_FINDINGS_PER_RUN` = 10 | constants (not env) |
| S4 GBP packs | **none** — deterministic composition (documented deviation) | n/a | — |
| S7 sprint plans | **none** — deterministic `buildMonthlySprint` | n/a | — |
| S3 location pages | pre-existing content pipeline | `clients.location_pages_per_day` default 2 / 24h, EVERY attempt counted (failures included); planner caps `MAX_PLACES_PER_BLOG` = 8 | per-client column |
| monthly PDF summary (`report-actions` → `generateMonthlyReport`) | claude-client | one call per client per monthly run | — |

### R4 — auth + cursor matrix — resolved IN WRITING; live curl BLOCKED

- **Static answer (code inspection, `src/lib/api/auth.ts`):** `apiAuthGuard` is
  KEY-based, not session-based — one shared `MARKETING_API_KEY` (app_settings
  or env, Bearer or X-API-Key, timing-safe compare). It does NOT accept
  `OPS_API_KEY` and does NOT accept portal sessions. The §E S1/S3 "same,
  ops-auth" cells are recorded as the accepted deviation (§B.8 of
  mega-prompt-next-session.md): ops audits S1/S3/S2/S8 through the v1
  client-search cursor endpoints with the marketing key;
  `/api/v1/ops/gbp-packs` keeps `opsAuthGuard` + `OPS_API_KEY`. Widening
  `apiAuthGuard` was rejected to honor G1 (no behavior change outside named
  gaps).
- Cursor conventions are pinned by tests (strict `>`, 1..500 clamp,
  `nextCursor` terminates on a partial page, LA-month default window).
- **BLOCKED — the live curl matrix:** needs the app running with
  `MARKETING_API_KEY`/`OPS_API_KEY` and a client login. Not demonstrated live
  this session (G5). Portal scoping ("client session sees ONLY its own
  clientId") also awaits those credentials.

### R1 / R3 / R6 — BLOCKED (named credentials, G5)

- **R1:** no dev `DATABASE_URL` (no .env files; nothing in the process env) →
  app bring-up, the cron 401/200 curl pair, and the `db:migrate` up-to-date
  check were NOT RUN. `MARKETING_API_KEY`, `CRON_SECRET`, `OPS_API_KEY`,
  admin + client logins also absent.
- **R3 (§I.3 fixture replay):** needs dev `DATABASE_URL` + `CRON_SECRET` +
  an admin login — NOT RUN. The detector/pure-core behavior it exercises is
  covered by the committed unit/route tests, but the end-to-end fixture pass
  remains open.
- **R6 (live publish smoke + F1 audit):** needs WP/Shopify dev-blog platform
  credentials AND the dev DB — NOT RUN. (The GBP pack build is DB-only and
  equally awaits the dev DB.)

### Operator instructions (R8)

- **Applying a GBP description version (F2 — humans only):** client page → GBP
  tab → rotation table → mark the new version applied (this stamps
  `applied_at`). The weekly gsc-sync rotation check
  (`checkDescriptionRotation`) reports `due: true` ONLY when the live version
  is ≥30 days old AND an unapplied alternate exists — the machine never
  applies a description itself; `gbpRotation.{checked,due}` in the cron
  response is the counter.
- **Detected-vs-decided telemetry:** `/review` GSC-loop card shows the
  one-line summary; `gsc-sync` response carries the full counts.
- **Reverting a migration (dev/ops):** `node src/lib/db/migrate.mjs --revert
  00NN`, one at a time, newest first.

### Remaining operator actions

1. Provision a disposable dev Postgres; set `DATABASE_URL`, `CRON_SECRET`,
   `OPS_API_KEY`, `MARKETING_API_KEY`, an admin login and a client login;
   then run the R1 checks and the §I.2 apply-all → revert-each → re-apply
   transcript (the DOWN scripts and the flag are already in place).
2. Seed the §I.3 fixture client and run the R3 replay per
   `docs/mega-prompt-remaining.md` §3.
3. Record the R4 live curl matrix (right/wrong marketing key, wrong/absent
   ops key, portal scope check, chained limit=1 cursor paging).
4. R6 dev-blog smoke + the F1 audit SQL over the whole run window (0
   violations expected; record the query + result).

### Gates after this session's commits

`npx tsc --noEmit` → 0 · `npx vitest run` → **742/742 across 55 files** ·
`npm run lint` → clean · `npm run build` → exit 0 · `git diff --check` →
clean — re-run before each commit per G3 (`1f41a6d`, `ce7c88a`, `18cede6`).