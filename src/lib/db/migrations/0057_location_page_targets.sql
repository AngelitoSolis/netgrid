-- Location page target ledger (S3 of the SEO-loop build).
--
-- "One page per [service]+[place]" at network scale, built on REAL data only:
-- services come from existing sources (vertical config service list when
-- present, else commercial-intent client_keywords rows) and places from
-- blogs.city / site_profiles.neighborhood / additional_areas. A place that is
-- not in those tables never becomes a page — no geocoding, no invented suburbs.
--
-- status REUSES the existing keyword_target_status enum (pending/generating/
-- generated/failed/skipped) so one vocabulary covers both ledgers; priority is
-- a RANK snapshot of the service term's winnability under the EXISTING formula
-- (lower = earlier, like blog_keyword_targets.priority); last_attempt_at is
-- the fairness cursor — claim order (priority asc, last_attempt_at asc NULLS
-- FIRST) IS the neighborhood rotation. Skipped rows carry their reason in
-- error ('no_local_presence' | 'already_covered:<key>' | 'duplicate_cluster').
-- Idempotent. Safe to replay.

CREATE TABLE IF NOT EXISTS location_page_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blog_id uuid NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_key varchar(255) NOT NULL,      -- normalized commercial term
  place_name varchar(160) NOT NULL,       -- a REAL place from existing sources only
  combined_query varchar(400) NOT NULL,   -- "<service> <place>" (display + dedupe key)
  status keyword_target_status NOT NULL DEFAULT 'pending',  -- reuse existing enum!
  priority integer NOT NULL DEFAULT 0,    -- lower = earlier; from winnability snapshot
  last_attempt_at timestamp,              -- fairness cursor for rotation
  error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS location_page_targets_unique_idx
  ON location_page_targets (blog_id, service_key, place_name);

-- Claim query: one pending row per due blog per run.
CREATE INDEX IF NOT EXISTS location_page_targets_claim_idx
  ON location_page_targets (blog_id, status, priority, last_attempt_at);

-- Optional multi-area support: operator-filled, same gate per area (additive only).
ALTER TABLE site_profiles ADD COLUMN IF NOT EXISTS additional_areas jsonb;
