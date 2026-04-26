// Client-side project store — a thin async wrapper around /api/projects.
//
// The server is the only copy. Anonymous visitors store under their
// session id; signed-in visitors store under their user id. Anonymous
// projects can be merged into the user account on login (see auth-merge.js).
//
// Project shape (transform):
//   { id, type: 'transform', name, createdAt, updatedAt,
//     sourceHeaders, targetHeaders, transformations }
// Project shape (merge):
//   { id, type: 'merge', name, createdAt, updatedAt,
//     leftHeaders, rightHeaders, priority, matchCode, matchNotes,
//     matchColumns, columns }
(function (global) {
  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function fetchJSON(url, init = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.headers || {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch {}
      const err = new Error(`${init.method || 'GET'} ${url} → ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function get(id) {
    if (!id) return null;
    const data = await fetchJSON(`/api/projects/${encodeURIComponent(id)}`);
    if (!data) return null;
    return { ...data.project, id, updatedAt: data.updatedAt };
  }

  async function list() {
    const data = await fetchJSON('/api/projects');
    return (data?.projects || [])
      .map(r => ({ ...r.project, id: r.id, updatedAt: r.updatedAt }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Saves are serialized via a per-project promise chain so two debounced
  // saves of the same project can't race each other on the wire.
  const saveChains = new Map();
  function chainFor(id) {
    return saveChains.get(id) || Promise.resolve();
  }

  function upsert(project) {
    if (!project || !project.id) return Promise.resolve();
    const id = project.id;
    const snapshot = { ...project };
    const next = chainFor(id).then(async () => {
      const data = await fetchJSON(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: snapshot }),
      });
      project.updatedAt = data?.updatedAt || project.updatedAt;
      return data;
    });
    saveChains.set(id, next.catch(() => {}));
    return next;
  }

  async function remove(id) {
    if (!id) return;
    await fetchJSON(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // The undo flow needs a way to put a project back wholesale; since we
  // hold the in-memory copy from before deletion, we just upsert it.
  async function restore(project) {
    if (!project || !project.id) return null;
    await upsert(project);
    return project;
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
    const project = type === 'merge'
      ? { ...base, leftHeaders: [], rightHeaders: [], priority: 'left',
          matchCode: '', matchNotes: '', matchColumns: [], columns: [] }
      : { ...base, sourceHeaders: [], targetHeaders: [], transformations: [] };
    await upsert(project);
    return project;
  }

  function projectUrl(p) {
    return (p.type === 'merge' ? '/merge/' : '/transform/') + encodeURIComponent(p.id);
  }

  global.Projects = {
    get,
    list,
    upsert,
    remove,
    restore,
    create,
    randomId,
    url: projectUrl,
  };
})(window);
