# MEGA PROMPT — NEXT SESSION: SEO loop v1 → operationally ready (post-`3e841fc`)

**Repo:** `f:\024-seotoolaisearch` (Next.js + TypeScript + Drizzle/Postgres + vitest, Windows dev box).
**Specs — read all three before touching anything:** `docs/mega-prompt-compact.md` (working brief, F1–F8, per-package DoD) · `docs/mega-prompt-next-session.md` (§B name map + §B.8 post-build amendments, §E rollout matrix + post-build resolution, §I checklist = acceptance criteria) · `docs/seo-loop-status.md` (status record — update at the end).

**Mission:** S0–S8 and the §E completion row are SHIPPED, and the verification session is DONE. Do not rebuild anything. **The only remaining work is the credential-blocked live verification** — every code task (R2 revert tooling, R5 telemetry + hygiene cursor mode, R7 wiring tests, R8 docs) is already committed and pushed. This session = provision dev credentials, then run and record the §I checks that have never been executed against a real database/app.

## 0. Ground rules

Carry-over hard constraints (full text in the compact doc): **F1** managed-URL boundary only · **F2** human decision layer — GBP description changes are applied BY THE OPERATOR; the rotation check is read-only · **F3** real data only, missing → "not provided — do not invent" · **F4** one ledger · **F5** reuse or justify · **F6** sequential additive migrations via `db/migrate.mjs` · **F7** env-tunable budgets · **F8** honesty (both measurements behind every number; no backfilled silence; ready-but-unsent packs never appear in client PDFs).

This session adds:
- **G1** No behavior change to shipped packages. Zero new product code is expected; if you find a bug, fix it in its own commit with tests and say so.
- **G2** Everything runs against a DEV `DATABASE_URL`. Never verify against prod; never write to any real client blog or GBP.
- **G3** One commit per R-row; run `npx tsc --noEmit` · `npx vitest run` · `npm run lint` · `npm run build` before each commit.
- **G4** Record VERIFIED results (command + transcript snippet, row IDs) in `docs/seo-loop-status.md`. Never write "should work".
- **G5** A missing credential = explicitly BLOCKED + name the credential. Never fake a pass.

## 1. Current state (RE-VERIFY at session start — confirm the push landed)

**Git:** `git fetch --all`, then `git log --oneline -6 main origin/main origin/dre22sept`. Expected: all three at **`3e841fc`** ("docs(R8): readiness record…"), on top of `18cede6` (R7 tests) ← `ce7c88a` (R5 telemetry + `?hygiene=1`) ← `1f41a6d` (R2 `--revert` + DOWN scripts) ← `c522655` (§E completion row). Working tree must be clean. If the push didn't land, pushing existing commits to the correct remote branches is step 0 — no rebasing, no history rewrite. Note: the LOCAL `dre22sept` branch pointer may lag its remote; the remote branch is authoritative.

**Baseline gates to re-run (record ACTUAL results):** `npx tsc --noEmit` · `npx vitest run` (last reported **742/742 across 55 files**) · `npm run lint` · `npm run build` · `git diff --check`. A red gate = stop-the-line.

## 2. Credentials needed (the whole session is blocked without them)

Provision and export before anything else:

1. **Dev `DATABASE_URL`** — a disposable Postgres (fresh DB preferred; a used dev DB works but the §I.2 revert test needs 0056–0059 to be the applied tail).
2. **`CRON_SECRET`** — for the cron routes.
3. **`MARKETING_API_KEY`** — the v1 client endpoints' key (set in env or `app_settings`).
4. **`OPS_API_KEY`** — for `/api/v1/ops/gbp-packs` only.
5. Admin login + one client login (portal session cookie) for R4's portal row.
6. WP/Shopify dev-blog platform credentials for R6.

## 3. The remaining work — five live-verification rows, no new features

### R1 — App bring-up + cron auth checks [needs items 1–3]
- `.env.local` with the dev credentials; `npm run dev`; `npm run db:migrate` → expect "up to date" after applying 0001→0059 in order; record the output.
- Curl matrix: gsc-sync with **no** secret → **401**; with the right secret → **200** + JSON containing `rescue.*`, `hygiene.*` (+ `.open`/`.decided`), `gbpRotation.*`, `dossierFreshness`. Record both transcripts.
- **DoD:** migrate output + both curl transcripts in the status doc.

### R2b — §I.2 apply/revert/reapply transcript [needs item 1]
On the fresh dev DB:
1. Apply all: `npm run db:migrate` (transcript).
2. Revert one at a time, newest first: `node src/lib/db/migrate.mjs --revert 0059` → `--revert 0058` → `--revert 0057` → `--revert 0056` (each prints its DOWN-script execution; also try `--revert client_seo_dossiers` and `--revert 005` prefixes to demo the resolution forms).
3. Prove the guard: attempt `--revert 0057` while 0058/0059 are still applied → expect the refusal error.
4. Re-apply all: `npm run db:migrate` again.

**Lockstep note:** do NOT run `drizzle-kit generate` (repo rule — `migrations/README.md`, `docs/remediation-status.md`). Lockstep is already evidenced by inspection (schema.ts defines `locationPageTargets`, `gbpAssets`, `gbpDescriptionVersions`, `clientSeoDossiers`, `issueKey`/`preSnapshot`, `additionalAreas` ↔ 0056–0059); state that in the record instead of claiming a drizzle-kit check.

**DoD:** the full apply → revert-each → refusal → reapply transcript in the status doc.

### R3 — Fixture client end-to-end replay (§I.3) [needs items 1, 2, 5]
Seed ONE fixture client with real-ish GSC rows, then in one gsc-sync run + the weekly/monthly runs prove the chain: S0 excludes its ranked query from ideation → S1 detects → generates → applies (within budget: `RESCUE_MAX_GENERATED_PER_RUN`=5/client-day shared with pin; applies capped 3/blog, 15/network) → verifies → S2 finds its split + fold → S8 flags its dead post → `/review` shows every row with working approve/dismiss → the weekly outcome pass writes a real delta after simulated 30-day data → the monthly PDF renders Goldmine outcomes, the sprint score, and the dossier page from that same client's rows. Record row IDs (`seo_issues`, `page2_outcomes`, `location_page_targets`, `gbp_*`, report row) and the run JSONs.
- **DoD:** per-step transcript + row IDs in the status doc.

### R4b — Live auth + cursor matrix (§I.4) [needs items 3–5]
The static half is ALREADY ANSWERED (recorded in §B.8 + the status doc): `apiAuthGuard` = one shared `MARKETING_API_KEY` (key-based, NOT sessions, does NOT accept `OPS_API_KEY`); `/api/v1/ops/gbp-packs` = `opsAuthGuard` + `OPS_API_KEY`. Your job is the LIVE proof:
- Client-search endpoint with `MARKETING_API_KEY` → 200; wrong/absent key → 401.
- `?rescues=1`, `?locationPages=1`, `?hygiene=1` each return fixture data with correct `nextCursor`; prove cursor paging with chained `limit=1` calls (strict `>`, no dupes, terminates on the partial page).
- `/api/v1/ops/gbp-packs`: right key → 200, wrong/absent → 401.
- Portal: client session sees ONLY its own clientId; another client's id → empty/404.
- Cron routes: bad secret → 401 (covered by R1, cross-reference).
- **DoD:** the curl matrix table in the status doc. Do not widen `apiAuthGuard` (G1) — the deviation stands.

### R6 — Live publish smoke + F1 audit (§I.5) [needs items 1, 6]
- One dev WP blog through claim → generate → publish → `post-verification` → an `index_ping_events` row with outcome `ok`, for one skeleton-#13 location page AND one rescue apply (visible `verifyLiveMeta` diff).
- One GBP pack build on the fixture client (pure composition: DB only, no external calls) — then hand-apply a description version per F2 and watch `checkDescriptionRotation` flip it to `due` after the 30-day rule (simulate `appliedAt` if needed).
- **F1 audit SQL:** every applied issue `pageUrl` ∈ `generated_posts.externalPostUrl` (WP) / articles (Shopify) over the whole run window — **0 violations**; record the query + result.
- **DoD:** transcripts + the audit result in the status doc. Missing platform creds → mark BLOCKED with the credential named (G5).

## 4. End-of-session checklist (§I restated — every row needs "verified <date>, by <command/transcript>")

1. Gates clean, zero new skips.  2. R2b apply/revert transcript (+ inspection-based lockstep note).  3. R3 fixture replay.  4. R4b live matrix.  5. R6 F1 audit = 0 violations.  6. Update `docs/seo-loop-status.md` (gate + commit separately per G3) and push to BOTH `origin/main` and `origin/dre22sept` after verifying the intended remotes.
Anything unticked = explicitly blocked, with the missing credential named (G5). Never claim readiness beyond what was actually executed.
