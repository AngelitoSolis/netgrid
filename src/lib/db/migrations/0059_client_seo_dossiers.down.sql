-- DOWN for 0059_client_seo_dossiers.sql (run only via
-- `node src/lib/db/migrate.mjs --revert 0059`). Drops the one-per-client
-- dossier table; the PK FK to clients dies with it.

DROP TABLE IF EXISTS client_seo_dossiers;