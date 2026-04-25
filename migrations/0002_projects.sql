-- Per-user project sync.
--
-- The server stores the full project JSON blob — it never queries inside,
-- it just round-trips records to/from the client's IndexedDB. The client
-- ID is generated browser-side (UUID) and is unique per user; the
-- compound primary key keeps two users from colliding even on the
-- (astronomically unlikely) chance of a UUID collision.
--
-- updatedAt is the AUTHORITATIVE server-side version stamp for this
-- record. The client sends its last-seen serverUpdatedAt as the parent
-- version on every PUT; if it doesn't match what's currently stored, the
-- server returns 409 and the client opens a conflict dialog.
--
-- deleted=1 records are tombstones — kept on the server so other devices
-- pulling syncAll() pick up the deletion. Hard removal can happen later
-- as a sweep, but isn't required for correctness.

CREATE TABLE projects (
  userId      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  updatedAt   INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (userId, id)
);

CREATE INDEX projects_by_user_updated ON projects (userId, updatedAt);
