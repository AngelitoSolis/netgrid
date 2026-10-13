-- dre22sept — per-site facts and a hard cap on story reuse.
--
-- NUMBERING: next free prefix after 0053_quality_score.sql.
-- Idempotent. No backfill. A blog with no row is unchanged: the generator
-- only consults this when a caller passes a profile, and the cron does not
-- pass one until an operator has saved one.
--
-- site_profiles is one row per blog. Empty fields stay empty. The prompt is
-- not allowed to invent them; that rule lives in code, not in this file.
--
-- story_uses records that a story was attached to a post. The cap (5 uses
-- of one story_key in 30 days, never two on the same query) is enforced in
-- src/lib/content/story-reuse.ts before a row is inserted.

CREATE TABLE IF NOT EXISTS "site_profiles" (
  "blog_id"            uuid PRIMARY KEY REFERENCES "blogs"("id") ON DELETE CASCADE,
  "client_id"          uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "neighborhood"       varchar(160),
  "signature_facts"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "does_not"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  "place_note"         text,
  "updated_at"         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "site_profiles_client_idx" ON "site_profiles" ("client_id");

CREATE TABLE IF NOT EXISTS "story_uses" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "story_key"    varchar(64) NOT NULL,
  "blog_id"      uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "query_norm"   varchar(255) NOT NULL,
  "source_url"   varchar(1000),
  "created_at"   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "story_uses_key_created_idx"
  ON "story_uses" ("story_key", "created_at");
