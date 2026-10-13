-- T09: select keywords you can actually win, not the most competitive ones.
--
-- Purely additive. Two tables gain columns; nothing is dropped or rewritten.
--
-- WHY: the only ranking in the system was "search_volume desc, hit_count desc"
-- — a popularity contest. Volume and organic difficulty are strongly
-- correlated, so that sort deterministically selected the HARDEST terms in a
-- client's universe: the head terms a fresh domain has no path to ranking for.
-- keyword_difficulty and competition were already on the row and were read by
-- nothing except one admin display cell.
--
-- The ledger also made one post per near-duplicate Autocomplete variant
-- ("buy peptides", "buy peptides online", "where to buy peptides"), which is
-- the textbook definition of doorway content, and bolted a city onto purely
-- informational keywords regardless of whether the client has any local
-- presence at all.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS local_presence boolean NOT NULL DEFAULT false;

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS volume_scope varchar(16);

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS winnability numeric(12, 4);

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS keyword_difficulty integer;

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS local_framing boolean NOT NULL DEFAULT true;

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS cluster_key varchar(255);

ALTER TABLE blog_keyword_targets
  ADD COLUMN IF NOT EXISTS variants jsonb;

-- Existing rows predate the volume-scope distinction. Every one of them was
-- built city-framed with the BARE keyword's national volume snapshotted onto
-- it, so that is what they are backfilled to — an honest label on data that
-- was already ambiguous, not a change of meaning.
UPDATE blog_keyword_targets
SET volume_scope = 'bare_keyword'
WHERE volume_scope IS NULL
  AND search_volume IS NOT NULL;

-- The ledger builder reads pending rows oldest-priority-first per blog; a
-- partial index keeps that read cheap as the table grows.
CREATE INDEX IF NOT EXISTS blog_keyword_targets_cluster_idx
  ON blog_keyword_targets (blog_id, cluster_key);
