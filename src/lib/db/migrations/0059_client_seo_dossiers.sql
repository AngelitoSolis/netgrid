-- Client SEO dossier (S6, SEO-loop build brief D.6): ONE per-client fact sheet
-- that every generated artifact in this session is grounded in — rescue meta,
-- GBP packs, location pages, sprint plans. Operator-verified facts only; the
-- prompt builder renders missing fields as "not provided" and never invents
-- (F3/F8). competitorProfiles holds S4's pasted GBP data; recentWins is fed by
-- resolved rescues + sprint outcomes. Idempotent. Safe to replay.

CREATE TABLE IF NOT EXISTS "client_seo_dossiers" (
  "client_id" uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  "business_model" text,
  "service_area" jsonb NOT NULL DEFAULT '[]',
  "differentiators" jsonb NOT NULL DEFAULT '[]',
  "audience" text,
  "competitor_profiles" jsonb NOT NULL DEFAULT '[]',
  "recent_wins" jsonb NOT NULL DEFAULT '[]',
  "gaps" text,
  "last_verified_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);