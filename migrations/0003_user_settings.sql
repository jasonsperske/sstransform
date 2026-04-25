-- Per-user app settings: chosen Claude model + (optional) personal
-- ANTHROPIC_API_KEY.
--
-- The API key is encrypted at rest with AES-256-GCM keyed by
-- SETTINGS_KEY (env var or auto-generated data/.settings-key). We store
-- the ciphertext, IV, and auth tag as separate BLOB columns so a DB
-- leak alone can't reveal the key — the attacker would also need the
-- settings key file.
--
-- Either column may be NULL: model = NULL means "use the server
-- default" (ANTHROPIC_MODEL env var); apiKeyCiphertext = NULL means
-- "use the server's ANTHROPIC_API_KEY".

CREATE TABLE user_settings (
  userId             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  model              TEXT,
  apiKeyCiphertext   BLOB,
  apiKeyIv           BLOB,
  apiKeyTag          BLOB,
  updatedAt          INTEGER NOT NULL
);
