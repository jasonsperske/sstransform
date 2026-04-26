// Server-side project store.
//
// The server is the only copy of every project. Each row is keyed by
// `ownerKey`, which is either:
//   - the authenticated user's id (req.user.id), or
//   - the anonymous session's id (req.session.id) if the visitor hasn't
//     signed in yet.
//
// When an anonymous visitor signs in, the projects keyed under their
// session id become "orphans" relative to the new user id. The merge
// popup lets them re-key those orphans onto the user account; declining
// deletes them. Orphans also get cleaned up on logout.
//
// `data` is opaque JSON; the server never parses it. Last writer wins on
// PUT — there's no parent-version check because there's no offline queue
// or multi-device sync to reconcile against.

export function listForOwner(db, ownerKey) {
  return db.prepare(
    'SELECT id, data, updatedAt FROM projects WHERE ownerKey = ? ORDER BY updatedAt DESC'
  ).all(ownerKey);
}

export function getOne(db, ownerKey, id) {
  return db.prepare(
    'SELECT id, data, updatedAt FROM projects WHERE ownerKey = ? AND id = ?'
  ).get(ownerKey, id) || null;
}

export function putProject(db, { ownerKey, id, data }) {
  const now = Date.now();
  const payload = JSON.stringify(data);
  db.prepare(
    `INSERT INTO projects (ownerKey, id, data, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(ownerKey, id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`
  ).run(ownerKey, id, payload, now);
  return { updatedAt: now };
}

export function deleteProject(db, ownerKey, id) {
  const r = db.prepare(
    'DELETE FROM projects WHERE ownerKey = ? AND id = ?'
  ).run(ownerKey, id);
  return r.changes > 0;
}

// Re-key every project from one owner to another. Used when an anonymous
// session signs in and the user accepts the merge popup.
//
// If the target already has a project with the same id (vanishingly
// unlikely with UUIDs, but possible if the user was previously signed in
// and somehow has a duplicate id), the source row is dropped — the
// authenticated copy wins.
export function mergeOwner(db, fromOwnerKey, toOwnerKey) {
  if (fromOwnerKey === toOwnerKey) return { merged: 0, skipped: 0 };
  const tx = db.transaction(() => {
    const conflicts = db.prepare(
      `SELECT s.id FROM projects s
       JOIN projects t ON t.id = s.id AND t.ownerKey = ?
       WHERE s.ownerKey = ?`
    ).all(toOwnerKey, fromOwnerKey);
    const skipped = conflicts.length;
    if (skipped) {
      const dropDup = db.prepare(
        'DELETE FROM projects WHERE ownerKey = ? AND id = ?'
      );
      for (const c of conflicts) dropDup.run(fromOwnerKey, c.id);
    }
    const r = db.prepare(
      'UPDATE projects SET ownerKey = ? WHERE ownerKey = ?'
    ).run(toOwnerKey, fromOwnerKey);
    return { merged: r.changes, skipped };
  });
  return tx();
}

export function deleteAllForOwner(db, ownerKey) {
  const r = db.prepare('DELETE FROM projects WHERE ownerKey = ?').run(ownerKey);
  return r.changes;
}
