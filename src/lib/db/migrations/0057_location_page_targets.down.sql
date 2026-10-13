-- DOWN for 0057_location_page_targets.sql (run only via
-- `node src/lib/db/migrate.mjs --revert 0057`). Drops the S3 ledger table
-- (its indexes die with it) and the additive site_profiles.additional_areas
-- column 0057 introduced. Indexes first, then the table, then the column.

DROP INDEX IF EXISTS location_page_targets_claim_idx;

DROP INDEX IF EXISTS location_page_targets_unique_idx;

DROP TABLE IF EXISTS location_page_targets;

ALTER TABLE site_profiles DROP COLUMN IF EXISTS additional_areas;