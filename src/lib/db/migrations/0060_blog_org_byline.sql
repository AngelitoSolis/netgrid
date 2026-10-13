-- Per-blog organisational byline override. When set, the blog publishes under
-- this name if it has no active person author, and the YMYL author gate is
-- cleared for that blog only (narrow alternative to ALLOW_UNATTRIBUTED_YMYL).
-- Idempotent. Safe to replay.

ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "org_byline" varchar(160);

-- Operator request: montrealpeptides.com publishes as "Montreal Peptides Editorial".
UPDATE "blogs"
   SET "org_byline" = 'Montreal Peptides Editorial'
 WHERE lower("domain") IN ('montrealpeptides.com', 'www.montrealpeptides.com')
   AND "org_byline" IS NULL;
