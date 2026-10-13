-- DOWN for 0060_blog_org_byline.sql (run only via
-- `node src/lib/db/migrate.mjs --revert 0060`).

ALTER TABLE "blogs" DROP COLUMN IF EXISTS "org_byline";
