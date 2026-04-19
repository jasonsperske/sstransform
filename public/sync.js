// Bidirectional sync between local IndexedDB and a server account.
//
// Account/auth is not wired up yet — that comes in a follow-up. Until then,
// `isEnabled()` returns false and every public method short-circuits to a
// no-op. Call sites at `/`, `/transform/:id`, and `/merge/:id` already invoke
// the right hooks, so wiring an account just means flipping `isEnabled` and
// providing endpoint URLs.
//
// The contract once enabled:
//   syncAll()      — full reconcile. Pulls every server project, pushes every
//                    dirty local project, applies tombstones in both
//                    directions. Use on `/` and on login.
//   syncOne(id)    — single-project reconcile. Pulls the server copy of `id`,
//                    pushes the local copy if newer, hard-deletes if the
//                    server says it was deleted. Use on deep-link routes
//                    (/transform/:id, /merge/:id) so opening a shared link
//                    on a second device works without a full sync round trip.
//
// Conflict policy: last-writer-wins on `updatedAt` vs `serverUpdatedAt`. This
// is the simplest workable rule. A future iteration can add a richer policy
// (e.g. field-level merge for transformations[]) without changing call sites.
(function (global) {
  // Endpoints — set by the (future) account module via Sync.configure().
  // Suggested server contract:
  //   GET  /api/projects             → { projects: [...], serverTime }
  //   GET  /api/projects/:id         → { project, serverUpdatedAt } | 404
  //   PUT  /api/projects/:id         → { serverUpdatedAt }   body: project
  //   DELETE /api/projects/:id       → { serverUpdatedAt }
  let config = {
    enabled: false,
    endpoints: {
      list: '/api/projects',
      one: (id) => `/api/projects/${encodeURIComponent(id)}`,
    },
    // Account module supplies these once the user logs in:
    fetchOpts: () => ({ credentials: 'same-origin' }),
  };

  // Coalesce concurrent syncs of the same target so the UI can call freely.
  const inflight = new Map(); // key -> Promise

  function isEnabled() {
    return !!config.enabled;
  }

  function configure(next) {
    config = { ...config, ...next };
  }

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
    // 1. Pull all server projects, reconcile against local.
    const remote = await fetchJSON(config.endpoints.list);
    const remoteById = new Map((remote.projects || []).map(p => [p.id, p]));

    const localAll = await DB.getAll('projects');
    const localById = new Map(localAll.map(p => [p.id, p]));

    // Server -> local
    for (const r of remoteById.values()) {
      await reconcileOne(localById.get(r.id), r);
    }

    // 2. Push every dirty local project the server didn't already give us.
    const dirty = await Projects.listDirty();
    for (const p of dirty) {
      if (remoteById.has(p.id)) continue; // already handled by reconcileOne
      await pushLocal(p);
    }

    return { pulled: remoteById.size, pushed: dirty.length };
  }

  async function doSyncOne(id) {
    const local = await Projects.getRaw(id);
    let remote = null;
    try {
      remote = await fetchJSON(config.endpoints.one(id));
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    await reconcileOne(local, remote && remote.project);
    return { id };
  }

  // Last-writer-wins on (updatedAt, serverUpdatedAt). A null `local` means
  // the row only exists on the server; a null `remote` means we may need to
  // push.
  async function reconcileOne(local, remote) {
    if (!local && !remote) return;

    if (!local && remote) {
      if (remote.deleted) return; // nothing to do
      await Projects.applyRemote(remote, { serverUpdatedAt: remote.updatedAt });
      return;
    }

    if (local && !remote) {
      if (local.dirty) await pushLocal(local);
      return;
    }

    // Both sides have a copy. Compare timestamps.
    const localNewer = (local.updatedAt || 0) > (remote.updatedAt || 0);
    if (localNewer && local.dirty) {
      await pushLocal(local);
    } else if (remote.deleted) {
      await Projects.hardRemove(local.id);
    } else {
      await Projects.applyRemote(remote, { serverUpdatedAt: remote.updatedAt });
    }
  }

  async function pushLocal(p) {
    const url = config.endpoints.one(p.id);
    if (p.deleted) {
      const res = await fetchJSON(url, { method: 'DELETE' });
      await Projects.markSynced(p.id, res && res.serverUpdatedAt);
      return;
    }
    const res = await fetchJSON(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    });
    await Projects.markSynced(p.id, res && res.serverUpdatedAt);
  }

  async function fetchJSON(url, init = {}) {
    const opts = { ...config.fetchOpts(), ...init, headers: { ...(config.fetchOpts().headers || {}), ...(init.headers || {}) } };
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = new Error(`sync ${init.method || 'GET'} ${url} → ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  global.Sync = { syncAll, syncOne, isEnabled, configure };
})(window);
