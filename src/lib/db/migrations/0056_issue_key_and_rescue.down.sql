-- DOWN for 0056_issue_key_and_rescue.sql (run only via
-- `node src/lib/db/migrate.mjs --revert 0056`). Removes the issue identity +
-- before/after proof columns that 0056 ADDED — both were introduced by this
-- migration, so neither is a shared column. Index first, then the columns it
-- sits on. GSC-loop rows (page2:/pin:/split:/folded:/dead) lose their stable
-- identity with the column; this script exists for clean-environment replay
-- (§I.2), not for use against a production ledger.

DROP INDEX IF EXISTS seo_issues_unique_idx;

ALTER TABLE seo_issues DROP COLUMN IF EXISTS pre_snapshot;

ALTER TABLE seo_issues DROP COLUMN IF EXISTS issue_key;