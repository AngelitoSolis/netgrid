-- GBP optimization packs (S4, SEO-loop build). Netgrid NEVER touches a Google
-- Business Profile (F2) — these tables store the operator's copy-paste-ready
-- packs and the description A/B rotation.
--
-- gbp_assets is INSERT-only: re-generating after a new competitor paste creates
-- NEW rows and never touches old ones, so the table is the audit trail of what
-- we promised the client (ops endpoint reads it back). gbp_description_versions
-- carries the ≤750-char hard cap enforced in code AND by a DB CHECK (the spec
-- asks for both).
--
-- Idempotent. Safe to replay.

CREATE TABLE IF NOT EXISTS "gbp_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  "asset_type" varchar(32) NOT NULL,   -- categories|attributes|services|description|posts|photos|reviews
  "payload" jsonb NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'ready',  -- ready|sent_to_client
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "gbp_assets_client_created_idx" ON "gbp_assets" ("client_id", "created_at");

CREATE TABLE IF NOT EXISTS "gbp_description_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id" uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  "version" integer NOT NULL,
  "body" varchar(750) NOT NULL,        -- GBP hard cap; also CHECK-enforced below
  "applied_at" timestamp,              -- when the operator confirms it went live
  "performance_note" text,             -- brand-query GSC delta ONLY when that data exists (F8)
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "gbp_description_versions_body_cap" CHECK (char_length("body") <= 750),
  UNIQUE ("client_id", "version")
);