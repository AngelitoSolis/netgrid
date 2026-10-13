-- 396red reply idempotency.
-- A retried POST with the same Idempotency-Key returns the original message
-- instead of inserting a second admin reply into the client thread.
-- Idempotent. Safe to replay.

CREATE TABLE IF NOT EXISTS "ops_reply_keys" (
  "idempotency_key" varchar(80) PRIMARY KEY,
  "client_id"       uuid NOT NULL,
  "message_id"      uuid NOT NULL,
  "created_at"      timestamp NOT NULL DEFAULT now()
);
