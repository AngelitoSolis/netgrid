-- T19 — one composite quality score.
--
-- NUMBERING: the T19 SOP calls this file 0039_quality_score.sql. The highest
-- prefix when that SOP was written was 0038; this branch has since landed
-- 0039-0052, so it is 0053 here. Content is unchanged.
--
-- 1. Snapshot tables so the rollback can restore the previous numbers exactly.
-- 2. blog_vitals: Core Web Vitals sampled per blog from a representative post.
-- 3. Quality bookkeeping columns on generated_posts.
-- 4. Purge the fabricated 70/70/70 written by the generator.
--
-- Idempotent throughout: IF NOT EXISTS everywhere, ON CONFLICT DO NOTHING on
-- the snapshot inserts, and a WHERE clause on the UPDATE that stops matching
-- once it has run. Safe to replay.

-- ── 1. Rollback snapshots ───────────────────────────────────────────────────
-- Captured BEFORE anything is nulled. These are not application tables.

CREATE TABLE IF NOT EXISTS "t19_blog_score_snapshot" (
  "blog_id"           uuid PRIMARY KEY,
  "current_seo_score" integer,
  "last_seo_scan_at"  timestamp,
  "captured_at"       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "t19_blog_score_snapshot" ("blog_id", "current_seo_score", "last_seo_scan_at")
SELECT "id", "current_seo_score", "last_seo_scan_at" FROM "blogs"
ON CONFLICT ("blog_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "t19_post_score_snapshot" (
  "post_id"            uuid PRIMARY KEY,
  "seo_score"          integer,
  "readability_score"  integer,
  "brand_voice_score"  integer,
  "captured_at"        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "t19_post_score_snapshot" ("post_id", "seo_score", "readability_score", "brand_voice_score")
SELECT "id", "seo_score", "readability_score", "brand_voice_score" FROM "generated_posts"
ON CONFLICT ("post_id") DO NOTHING;

-- ── 2. blog_vitals ──────────────────────────────────────────────────────────
-- Must match the blogVitals definition in src/lib/db/schema.ts exactly.
-- cls_x1000 stores CLS x 1000 (0.084 -> 84): an integer column silently rounds
-- real CLS values to zero, which is the bug fixed in pagespeed-client.ts.

CREATE TABLE IF NOT EXISTS "blog_vitals" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "blog_id"                uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "client_id"              uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "strategy"               varchar(10) NOT NULL DEFAULT 'mobile',
  "sampled_url"            varchar(1000) NOT NULL,
  "lcp_ms"                 integer,
  "fcp_ms"                 integer,
  "cls_x1000"              integer,
  "tbt_ms"                 integer,
  "inp_ms"                 integer,
  "speed_index_ms"         integer,
  "lighthouse_performance" integer,
  "error"                  text,
  "fetched_at"             timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "blog_vitals_blog_id_idx"    ON "blog_vitals" ("blog_id");
CREATE INDEX IF NOT EXISTS "blog_vitals_fetched_at_idx" ON "blog_vitals" ("fetched_at");

-- ── 3. Quality bookkeeping on generated_posts ───────────────────────────────

ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "quality_breakdown"      jsonb;
ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "quality_scored_at"      timestamp;
ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "max_sibling_similarity" numeric(5,4);

-- Drives the re-score sweep in /api/cron/seo-scan (oldest scores first).
CREATE INDEX IF NOT EXISTS "generated_posts_quality_scored_at_idx"
  ON "generated_posts" ("quality_scored_at");

-- Drives the duplication report.
CREATE INDEX IF NOT EXISTS "generated_posts_max_sibling_similarity_idx"
  ON "generated_posts" ("max_sibling_similarity" DESC);

-- ── 4. Purge the fabricated scores ──────────────────────────────────────────
-- Every row the generator wrote carries readability_score = 70 AND
-- brand_voice_score = 70; nothing else in the codebase has ever written those
-- two columns. That pair is therefore an exact fingerprint for "fabricated",
-- and it also catches rows whose seo_score was later overwritten by the
-- tag-hygiene scan — that number is the old engine's output and is not the
-- composite, so it goes too.
--
-- Rows from the long-deleted analyzeContent LLM scorer (varied values) are
-- deliberately NOT touched here.
--
-- Converges on re-run: after the update the WHERE no longer matches.

UPDATE "generated_posts"
   SET "seo_score"         = NULL,
       "readability_score" = NULL,
       "brand_voice_score" = NULL
 WHERE "readability_score" = 70
   AND "brand_voice_score" = 70;

-- Blog headline scores are Lighthouse-SEO (WordPress) or tag-hygiene
-- (Shopify) numbers from engines this task removes. Null them; the per-blog
-- backfill recomputes them from the posts.
UPDATE "blogs"
   SET "current_seo_score" = NULL
 WHERE "current_seo_score" IS NOT NULL;
