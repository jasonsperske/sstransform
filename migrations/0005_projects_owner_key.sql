-- Server is now the only copy of projects. Anonymous users own their work
-- via the session id; signed-in users own it via the user id. The column
-- is renamed `userId` → `ownerKey` to make that dual-use explicit, and
-- the FK to users.id is dropped (anonymous owners aren't users). The
-- `deleted` tombstone column goes away too: with no client-side store,
-- soft-delete-then-sync is gone — deletes are immediate and global, and
-- the home page's undo toast keeps the project in memory for its 8s
-- window.

CREATE TABLE projects_new (
  ownerKey    TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  updatedAt   INTEGER NOT NULL,
  PRIMARY KEY (ownerKey, id)
);

INSERT INTO projects_new (ownerKey, id, data, updatedAt)
SELECT userId, id, data, updatedAt FROM projects WHERE deleted = 0;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE INDEX projects_by_owner_updated ON projects (ownerKey, updatedAt);
