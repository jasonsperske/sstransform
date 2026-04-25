// Server-side project sync.
//
// The server's role is narrow: it's a per-user key/value blob store with
// a parent-version check on every write. All project semantics — what
// fields mean, how they're rendered, how transformations execute — live
// in the browser. The server never parses the project JSON.
//
// The parent-version check lets the client detect that the server was
// updated since the client last pulled, so it can show a conflict
// dialog instead of blindly overwriting a sibling device's changes.

export function listForUser(db, userId) {
  return db.prepare(
    'SELECT id, data, updatedAt, deleted FROM projects WHERE userId = ? ORDER BY updatedAt DESC'
  ).all(userId);
}

export function getOne(db, userId, id) {
  return db.prepare(
    'SELECT id, data, updatedAt, deleted FROM projects WHERE userId = ? AND id = ?'
  ).get(userId, id) || null;
}

// Write the client's record if the stored updatedAt matches the client's
// parentServerUpdatedAt (or the row doesn't exist yet). On mismatch,
// return { conflict: true, server } so the caller can send a 409.
export function putProject(db, { userId, id, data, parentServerUpdatedAt, deleted }) {
  const existing = getOne(db, userId, id);
  const parent = parentServerUpdatedAt || 0;

  if (existing && existing.updatedAt !== parent) {
    return { conflict: true, server: existing };
  }

  const now = Date.now();
  const isDeleted = deleted ? 1 : 0;
  const payload = JSON.stringify(data);

  if (existing) {
    db.prepare(
      'UPDATE projects SET data = ?, updatedAt = ?, deleted = ? WHERE userId = ? AND id = ?'
    ).run(payload, now, isDeleted, userId, id);
  } else {
    db.prepare(
      'INSERT INTO projects (userId, id, data, updatedAt, deleted) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, id, payload, now, isDeleted);
  }
  return { conflict: false, serverUpdatedAt: now };
}
