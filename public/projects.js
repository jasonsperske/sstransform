// Client-side project store, backed by localStorage.
// Shape: { [id]: { id, type: 'transform', name, createdAt, updatedAt,
//                  sourceHeaders, targetHeaders, transformations } }
(function (global) {
  const STORAGE_KEY = 'sstransform:projects';

  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveAll(all) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function get(id) {
    if (!id) return null;
    return loadAll()[id] || null;
  }

  function upsert(project) {
    if (!project || !project.id) return;
    const all = loadAll();
    project.updatedAt = Date.now();
    all[project.id] = project;
    saveAll(all);
  }

  function remove(id) {
    const all = loadAll();
    delete all[id];
    saveAll(all);
  }

  function create({ id } = {}) {
    const now = Date.now();
    const project = {
      id: id || randomId(),
      type: 'transform',
      name: '',
      createdAt: now,
      updatedAt: now,
      sourceHeaders: [],
      targetHeaders: [],
      transformations: [],
    };
    upsert(project);
    return project;
  }

  function list() {
    return Object.values(loadAll()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  global.Projects = { get, upsert, remove, create, list, randomId };
})(window);
