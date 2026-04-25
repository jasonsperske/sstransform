-- Initial auth schema.
--
-- Design notes:
-- * users rows are keyed by a generated id; (provider, subject) is the
--   natural key from the federated provider.
-- * sessions.userId is nullable — an anonymous visitor gets a session row
--   before they ever sign in. On login we UPDATE the same session row so
--   nothing tied to that session is lost.
-- * oauth_tokens stores ONLY SHA-256 hex hashes of the access/refresh
--   tokens the provider returns. We don't currently use the tokens after
--   login (the login flow extracts user identity from the id_token), so
--   hashing is defense in depth rather than a verification requirement.
-- * oauth_state holds short-lived CSRF/PKCE state for the redirect flow.

CREATE TABLE users (
  id          TEXT    PRIMARY KEY,
  provider    TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

CREATE INDEX users_by_email ON users (email);

CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  userId       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  createdAt    INTEGER NOT NULL,
  lastSeenAt   INTEGER NOT NULL
);

CREATE INDEX sessions_by_user ON sessions (userId);

CREATE TABLE oauth_tokens (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  userId            TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT    NOT NULL,
  accessTokenHash   TEXT    NOT NULL,
  refreshTokenHash  TEXT,
  expiresAt         INTEGER,
  createdAt         INTEGER NOT NULL
);

CREATE INDEX oauth_tokens_by_user ON oauth_tokens (userId);

CREATE TABLE oauth_state (
  state         TEXT    PRIMARY KEY,
  sessionId     TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  codeVerifier  TEXT    NOT NULL,
  nonce         TEXT    NOT NULL,
  redirectUri   TEXT    NOT NULL,
  returnTo      TEXT,
  createdAt     INTEGER NOT NULL
);
