-- Issue identity + before/after proof layer (S1 of the SEO-loop build; also the
-- foundation for S2/S8 detectors).
--
-- issue_key gives every GSC-loop detector a STABLE identity ("page2:<normQuery>",
-- "split:<normQuery>", ...) so daily runs UPSERT instead of re-detecting, and a
-- row keeps its status across runs once applied/verified (F4: one ledger).
-- The unique index is PARTIAL on purpose: legacy issues keep issue_key NULL and
-- the per-post scanner's delete only manages those rows — see the matching
-- `AND issue_key IS NOT NULL` guard in post-seo-runner.ts.
--
-- pre_snapshot carries the BEFORE measurement (S1-verify later writes .outcome
-- into it) so the PDF "Queries that moved" section can never show a delta
-- without both measurements actually present (F8).
-- Idempotent. Safe to replay.

ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS issue_key varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS seo_issues_unique_idx
  ON seo_issues (blog_id, page_url, issue_key) WHERE issue_key IS NOT NULL;

ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS pre_snapshot jsonb;