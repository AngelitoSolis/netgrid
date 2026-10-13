-- T12: real author entities, and the end of fabricated expertise.
--
-- Purely additive: a new enum, a new table, indexes, and one nullable column
-- on blogs. Nothing is dropped or rewritten.
--
-- WHY: the byline resolved to nothing. On Shopify it was a hash of the store
-- handle over a 30x30 table of INVENTED names; on WordPress it was whichever
-- account happened to hold the application password. Neither is an entity —
-- no page to link to, no profile to corroborate against, nothing for a search
-- engine to merge into a knowledge-graph node. Meanwhile 22 of the 77 peptide
-- voices instructed the model to write as a licensed physician, pharmacist or
-- clinician, and those prompts published under those fake bylines on YMYL
-- pages. The prompt libraries are fixed in code; this table is the other half.
--
-- HARD RULE, enforced in services/author-entity.ts and stated here so it
-- survives a schema read: every row must be a LIVING PERSON WHO HAS AGREED TO
-- BE NAMED. `credentials` is for qualifications documented at
-- `credential_evidence_url`; it is never a place to write an aspiration. A row
-- is only publishable once `consent_given_at` is set. If no real person is
-- available for a YMYL blog, publish under an organisational byline (no row
-- here) or stop publishing that content — do not invent a row.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'author_status') THEN
    CREATE TYPE author_status AS ENUM ('draft', 'active', 'retired');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS authors (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- NULL = available to every blog of the client; set = belongs to one blog.
  blog_id                   uuid REFERENCES blogs(id) ON DELETE CASCADE,

  name                      varchar(160) NOT NULL,
  slug                      varchar(160) NOT NULL,
  bio                       text NOT NULL,
  job_title                 varchar(160),
  photo_url                 text,
  email                     varchar(255),

  -- Real qualifications only, each evidenced by credential_evidence_url.
  -- An empty array is fine and is correct for most authors.
  credentials               text[] NOT NULL DEFAULT '{}',
  -- THIRD-PARTY corroborating URLs only. A sameAs pointing at another netgrid
  -- property is worse than none — it makes the network self-referential.
  same_as                   text[] NOT NULL DEFAULT '{}',
  credential_evidence_url   text,

  -- The compliance gate. No consent timestamp, no byline.
  consent_given_at          timestamp,
  consent_record_url        text,

  wp_user_id                integer,
  author_page_url           varchar(1000),
  author_page_published_at  timestamp,

  status                    author_status NOT NULL DEFAULT 'draft',
  created_at                timestamp NOT NULL DEFAULT now(),
  updated_at                timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authors_client_id_idx ON authors (client_id);
CREATE INDEX IF NOT EXISTS authors_blog_id_idx   ON authors (blog_id);
CREATE INDEX IF NOT EXISTS authors_status_idx    ON authors (status);

-- Slug unique per blog. Postgres treats NULLs as distinct, so this does NOT
-- constrain client-wide authors (blog_id IS NULL) — the partial index below
-- covers those.
CREATE UNIQUE INDEX IF NOT EXISTS authors_blog_slug_idx
  ON authors (blog_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS authors_client_slug_idx
  ON authors (client_id, slug)
  WHERE blog_id IS NULL;

ALTER TABLE blogs
  ADD COLUMN IF NOT EXISTS default_author_id uuid;

-- The FK is declared HERE rather than in the Drizzle schema on purpose.
-- authors.blog_id references blogs, so adding the reverse arrow in TypeScript
-- makes the two table types mutually recursive and tsc bails with TS7022
-- ("'blogs' implicitly has type 'any' because it is referenced directly or
-- indirectly in its own initializer"). The deferred arrow defers the value,
-- not the type. drizzle-kit is not the source of truth in this repo, so the
-- database enforces the constraint exactly as if it had been declared there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blogs_default_author_id_fkey'
  ) THEN
    ALTER TABLE blogs
      ADD CONSTRAINT blogs_default_author_id_fkey
      FOREIGN KEY (default_author_id) REFERENCES authors(id) ON DELETE SET NULL;
  END IF;
END
$$;
