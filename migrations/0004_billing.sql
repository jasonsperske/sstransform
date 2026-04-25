-- Stripe-backed token billing.
--
-- tokenBalance: raw Claude API tokens (input + output) the user has
-- prepaid for. Debited after each /api/transform or /api/merge call by
-- the call's response.usage; clamped at 0 (we never refund a partial
-- overage). When > 0, unlocks non-default model selection alongside
-- BYOK keys; when 0, the server falls back to the default model on the
-- operator's ANTHROPIC_API_KEY.
--
-- stripeCustomerId: cached Stripe customer for this user so we don't
-- create a fresh customer on every checkout. Populated lazily.
--
-- token_ledger: append-only audit trail. Credits carry the Stripe
-- event id (UNIQUE constraint = idempotent webhooks); debits leave it
-- NULL. Balance is the running sum but cached on user_settings to
-- avoid scanning the ledger on every API call.

ALTER TABLE user_settings ADD COLUMN tokenBalance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN stripeCustomerId TEXT;

CREATE TABLE token_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  userId          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta           INTEGER NOT NULL,
  reason          TEXT    NOT NULL,
  stripeEventId   TEXT    UNIQUE,
  createdAt       INTEGER NOT NULL
);

CREATE INDEX token_ledger_user_time ON token_ledger (userId, createdAt);
