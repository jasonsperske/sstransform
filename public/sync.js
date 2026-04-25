// Bidirectional sync between local IndexedDB and the user's account.
//
// Enabled when window.__currentUser is set (i.e. the page was rendered
// for an authenticated session). When the user is anonymous, every
// public method short-circuits to a no-op so the existing call sites at
// `/`, `/transform/:id`, and `/merge/:id` continue to work untouched.
//
// Server contract (see lib/projects.js + the routes in server.js):
//   GET  /api/projects             → { projects: [{id, project, serverUpdatedAt, deleted}], serverTime }
//   GET  /api/projects/:id         → { project, serverUpdatedAt, deleted } | 404
//   PUT  /api/projects/:id         → { serverUpdatedAt }
//                                    body: { project, parentServerUpdatedAt, deleted }
//                                    on conflict: 409 + { conflict: true, server }
//
// Conflict policy: a 409 from the server means the row was changed on
// another device since the local copy last pulled. We collect every 409
// from a sync round and hand them to ConflictDialog.resolve() — the
// user picks per-project which side wins, and we re-push (force-merge)
// or apply-remote based on their choice.
(function (global) {
  let config = {
    enabled: false,
    endpoints: {
      list: '/api/projects',
      one: (id) => `/api/projects/${encodeURIComponent(id)}`,
    },
    fetchOpts: () => ({ credentials: 'same-origin' }),
  };

  // Auto-enable when the page was rendered for an authenticated user.
  // Pages inject window.__currentUser via the layout.
  if (global.__currentUser) {
    config.enabled = true;
  }

  const inflight = new Map();

  function isEnabled() { return !!config.enabled; }
  function configure(next) { config = { ...config, ...next }; }

  // ===== Public API =====

  async function syncAll() {
    if (!isEnabled()) return { skipped: 'sync disabled' };
    return dedupe('all', () => doSyncAll());
  }

  async function syncOne(id) {
    if (!id) return { skipped: 'no id' };
    if (!isEnabled()) return { skipped: 'sync disabled' };
    return dedupe(`one:${id}`, () => doSyncOne(id));
  }

  // ===== Internals =====

  function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try { return await fn(); }
      finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
    return p;
  }

  async function doSyncAll() {
    const remote = await fetchJSON(config.endpoints.list);
    const remoteById = new Map((remote.projects || []).map(r => [r.id, r]));

    const localAll = await DB.getAll('projects');
    const localById = new Map(localAll.map(p => [p.id, p]));

    const conflicts = [];
    let pulled = 0, pushed = 0;

    // 1. Server → local. Apply non-dirty pulls; defer conflicts.
    for (const r of remoteById.values()) {
      const local = localById.get(r.id);
      const result = await reconcile(local, r);
      if (result === 'pulled') pulled++;
      else if (result === 'pushed') pushed++;
      else if (result && result.conflict) conflicts.push(result.conflict);
    }

    // 2. Local-only dirty rows: push (or hard-remove never-synced tombstones).
    for (const local of localAll) {
      if (remoteById.has(local.id)) continue;
      if (!local.dirty) continue;
      const result = await pushLocal(local);
      if (result === 'pushed') pushed++;
      else if (result === 'removed') pushed++;
      else if (result && result.conflict) conflicts.push(result.conflict);
    }

    if (conflicts.length) {
      await resolveConflicts(conflicts);
    }

    return { pulled, pushed, conflicts: conflicts.length };
  }

  async function doSyncOne(id) {
    const local = await Projects.getRaw(id);
    let remote = null;
    try {
      remote = await fetchJSON(config.endpoints.one(id));
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const result = await reconcile(local, remote && {
      id,
      project: remote.project,
      serverUpdatedAt: remote.serverUpdatedAt,
      deleted: !!remote.deleted,
    });
    if (result && result.conflict) {
      await resolveConflicts([result.conflict]);
    }
    return { id, conflict: !!(result && result.conflict) };
  }

  // Decide how to reconcile a single (local, remote) pair.
  //
  //  - No remote, dirty local           → push.
  //  - Remote, no local                 → pull.
  //  - Both clean and equal             → noop.
  //  - Local dirty, remote unchanged    → push.
  //  - Local clean, remote newer        → pull.
  //  - Both have advanced from the last
  //    sync point (server PUT returns
  //    409, OR remote.updatedAt differs
  //    from local.serverUpdatedAt while
  //    local is dirty)                  → conflict.
  async function reconcile(local, remote) {
    if (!local && !remote) return null;

    if (!local && remote) {
      if (remote.deleted) return null;
      await applyRemote(remote);
      return 'pulled';
    }

    if (local && !remote) {
      if (local.dirty) {
        return await pushLocal(local);
      }
      return null;
    }

    // Both sides have a copy.
    const localBase = local.serverUpdatedAt || 0;
    const remoteVersion = remote.serverUpdatedAt || 0;

    if (!local.dirty && remoteVersion > localBase) {
      // Server moved on; nothing local to lose.
      if (remote.deleted) {
        await Projects.hardRemove(local.id);
      } else {
        await applyRemote(remote);
      }
      return 'pulled';
    }

    if (local.dirty && remoteVersion === localBase) {
      // Local advanced, server didn't; fast-forward push.
      return await pushLocal(local);
    }

    if (local.dirty && remoteVersion > localBase) {
      // Both advanced — conflict.
      return {
        conflict: {
          id: local.id,
          local,
          remote,
        },
      };
    }

    return null;
  }

  async function pushLocal(local) {
    const body = {
      project: stripSyncFields(local),
      parentServerUpdatedAt: local.serverUpdatedAt || 0,
      deleted: !!local.deleted,
    };
    let res;
    try {
      res = await fetchJSON(config.endpoints.one(local.id), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.status === 409 && e.payload && e.payload.server) {
        return {
          conflict: {
            id: local.id,
            local,
            remote: {
              id: local.id,
              project: e.payload.server.project,
              serverUpdatedAt: e.payload.server.serverUpdatedAt,
              deleted: !!e.payload.server.deleted,
            },
          },
        };
      }
      throw e;
    }
    if (local.deleted) {
      // Tombstone has been propagated — drop the local row entirely.
      await Projects.hardRemove(local.id);
      return 'removed';
    }
    await Projects.markSynced(local.id, res.serverUpdatedAt);
    return 'pushed';
  }

  async function applyRemote(remote) {
    const project = { ...remote.project, id: remote.id };
    project.deleted = remote.deleted ? 1 : 0;
    await Projects.applyRemote(project, { serverUpdatedAt: remote.serverUpdatedAt });
  }

  // The local row carries sync bookkeeping that the server doesn't need
  // (and should not echo back to other devices). Strip it before push.
  function stripSyncFields(local) {
    const { dirty, serverUpdatedAt, deleted, ...rest } = local;
    return rest;
  }

  async function resolveConflicts(conflicts) {
    if (!global.ConflictDialog) {
      console.warn('ConflictDialog missing — leaving conflicts unresolved');
      return;
    }
    const decisions = await ConflictDialog.resolve(
      conflicts.map(c => ({ local: c.local, remote: c.remote }))
    );
    for (let i = 0; i < conflicts.length; i++) {
      const { id, local, remote } = conflicts[i];
      const choice = decisions[i].choice;
      if (choice === 'local') {
        // Re-push with remote's version as the new parent so the server
        // accepts the overwrite this time.
        const updated = await Projects.getRaw(id);
        if (!updated) continue;
        updated.serverUpdatedAt = remote.serverUpdatedAt;
        await DB.put('projects', updated);
        try {
          await pushLocal(updated);
        } catch (e) {
          console.warn('conflict re-push failed', id, e);
        }
      } else if (choice === 'remote') {
        if (remote.deleted) {
          await Projects.hardRemove(id);
        } else {
          await applyRemote(remote);
        }
      } // 'cancel' leaves the row dirty — user can retry.
    }
  }

  async function fetchJSON(url, init = {}) {
    const baseOpts = config.fetchOpts();
    const opts = {
      ...baseOpts,
      ...init,
      headers: { ...(baseOpts.headers || {}), ...(init.headers || {}) },
    };
    const res = await fetch(url, opts);
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch {}
      const err = new Error(`sync ${init.method || 'GET'} ${url} → ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  global.Sync = { syncAll, syncOne, isEnabled, configure };
})(window);
