-- DOWN for 0058_gbp_packs.sql (run only via
-- `node src/lib/db/migrate.mjs --revert 0058`). Drops both GBP tables in
-- reverse dependency order; the 750-char CHECK constraint
-- (gbp_description_versions_body_cap) dies with its table, as does the
-- (client_id, version) UNIQUE. The gbp_assets index is dropped explicitly
-- before its table so a partially-reverted database converges cleanly.

DROP INDEX IF EXISTS gbp_assets_client_created_idx;

DROP TABLE IF EXISTS gbp_description_versions;

DROP TABLE IF EXISTS gbp_assets;