// Client-side project store, backed by IndexedDB (see db.js).
//
// All accessors are async and return Promises. The legacy localStorage store
// is migrated automatically on first DB open.
//
// Project shape (transform):
//   { id, type: 'transform', name, createdAt, updatedAt,
//     sourceHeaders, targetHeaders, transformations,
//     serverUpdatedAt, dirty, deleted }
// Project shape (merge):
//   { id, type: 'merge', name, createdAt, updatedAt,
//     leftHeaders, rightHeaders, priority, matchCode, matchNotes,
//     matchColumns, columns, serverUpdatedAt, dirty, deleted }
//
// Sync fields explained:
//   updatedAt       — local last-modified ms; bumped on every upsert.
//   serverUpdatedAt — last server-acked timestamp. 0 means never synced.
//                     Sync compares updatedAt vs serverUpdatedAt to decide
//                     direction. Set by sync.js after a successful push/pull.
//   dirty           — 1 if local has changes not yet pushed; 0 after sync.
//                     Indexed so pushAll() can scan only dirty rows.
//   deleted         — 1 = tombstone awaiting server-side deletion. The home
//                     list filters these out, but they remain in IDB so the
//                     deletion can sync to other devices on the same account.
(function (global) {
  const STORE = 'projects';

  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function withSyncDefaults(p) {
    return {
      serverUpdatedAt: 0,
      dirty: 1,
      deleted: 0,
      ...p,
    };
  }

  async function get(id) {
    if (!id) return null;
    const row = await DB.getByKey(STORE, id);
    if (!row || row.deleted) return null;
    return row;
  }

  // Internal: read a row including tombstones (used by sync to push deletes).
  async function getRaw(id) {
    if (!id) return null;
    return (await DB.getByKey(STORE, id)) || null;
  }

  async function upsert(project) {
    if (!project || !project.id) return;
    project.updatedAt = Date.now();
    project.dirty = 1;
    if (project.deleted == null) project.deleted = 0;
    if (project.serverUpdatedAt == null) project.serverUpdatedAt = 0;
    await DB.put(STORE, project);
  }

  // Soft delete — always tombstone so the deletion is undoable AND can sync
  // to other devices on the same account. Permanent removal happens later:
  //   - sync.js after the server acks the deletion, or
  //   - the home page's tombstone sweep for never-synced rows that have aged
  //     past the undo window.
  async function remove(id) {
    const existing = await DB.getByKey(STORE, id);
    if (!existing) return;
    existing.deleted = 1;
    existing.dirty = 1;
    existing.updatedAt = Date.now();
    await DB.put(STORE, existing);
  }

  // Undo a soft-delete. Bumps updatedAt + dirty so the restore syncs too.
  async function restore(id) {
    const existing = await DB.getByKey(STORE, id);
    if (!existing) return null;
    existing.deleted = 0;
    existing.dirty = 1;
    existing.updatedAt = Date.now();
    await DB.put(STORE, existing);
    return existing;
  }

  // Internal: hard delete (used by sync after server ack and by the home
  // page's tombstone sweep for never-synced rows past the undo window).
  async function hardRemove(id) {
    await DB.deleteByKey(STORE, id);
  }

  // Sweep helper: hard-delete tombstones that were never synced and have aged
  // past `olderThanMs`. Safe to call on every home-page load; ignores rows
  // that have a serverUpdatedAt because those still need to push the deletion
  // to the server before the local copy can be removed.
  async function purgeAgedTombstones({ olderThanMs = 30_000 } = {}) {
    const all = await DB.getAll(STORE);
    const cutoff = Date.now() - olderThanMs;
    let purged = 0;
    for (const p of all) {
      if (!p.deleted) continue;
      if (p.serverUpdatedAt) continue; // sync needs to push the delete first
      if ((p.updatedAt || 0) > cutoff) continue; // still inside undo window
      await DB.deleteByKey(STORE, p.id);
      purged++;
    }
    return purged;
  }

  async function create({ id, type = 'transform' } = {}) {
    const now = Date.now();
    const base = {
      id: id || randomId(),
      type,
      name: '',
      createdAt: now,
      updatedAt: now,
    };
    let project;
    if (type === 'merge') {
      project = {
        ...base,
        leftHeaders: [],
        rightHeaders: [],
        priority: 'left',
        matchCode: '',
        matchNotes: '',
        matchColumns: [],
        columns: [],
      };
    } else {
      project = {
        ...base,
        sourceHeaders: [],
        targetHeaders: [],
        transformations: [],
      };
    }
    project = withSyncDefaults(project);
    await DB.put(STORE, project);
    return project;
  }

  function projectUrl(p) {
    return (p.type === 'merge' ? '/merge/' : '/transform/') + encodeURIComponent(p.id);
  }

  async function list() {
    const all = await DB.getAll(STORE);
    return all
      .filter(p => !p.deleted)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Sync helper: rows with unsynced local changes (including tombstones).
  async function listDirty() {
    return DB.getByIndex(STORE, 'by_dirty', 1);
  }

  // Sync helper: apply a server record to the local store. Caller is
  // responsible for conflict resolution; this just writes.
  async function applyRemote(project, { serverUpdatedAt }) {
    project.serverUpdatedAt = serverUpdatedAt || project.updatedAt || Date.now();
    project.dirty = 0;
    if (project.deleted == null) project.deleted = 0;
    await DB.put(STORE, project);
  }

  // Sync helper: mark a local row as successfully pushed.
  async function markSynced(id, serverUpdatedAt) {
    const row = await DB.getByKey(STORE, id);
    if (!row) return;
    if (row.deleted) {
      await DB.deleteByKey(STORE, id);
      return;
    }
    row.serverUpdatedAt = serverUpdatedAt || row.updatedAt || Date.now();
    row.dirty = 0;
    await DB.put(STORE, row);
  }

  global.Projects = {
    get,
    getRaw,
    upsert,
    remove,
    restore,
    hardRemove,
    purgeAgedTombstones,
    create,
    list,
    listDirty,
    applyRemote,
    markSynced,
    randomId,
    url: projectUrl,
  };
})(window);
