// IndexedDB layer for sstransform.
//
// Schema is declared in CURRENT_SCHEMA below. The `meta` store always holds a
// snapshot of the schema that was last applied AND the migration log, so any
// future code (e.g. a rebuild/reindex utility, a debug tool, or a different
// client version) can open the DB, read `meta:schema`, and know exactly which
// stores/indexes/keyPaths exist and which migrations have been applied to the
// data inside.
//
// To evolve the schema:
//   1. Bump CURRENT_SCHEMA.version.
//   2. Add an entry to MIGRATIONS with { fromVersion, toVersion, description,
//      upgrade(db, tx), data?(db, tx) }. `upgrade` runs inside the
//      versionchange transaction (create/delete stores & indexes).
//      Optional `data` runs after open in a normal readwrite tx and is for
//      transforming existing rows.
//   3. Update CURRENT_SCHEMA.stores to reflect the new shape.
(function (global) {
  const DB_NAME = 'sstransform';

  // Authoritative schema. Mirrored into the `meta` store on every open so
  // external tooling can introspect without re-reading this file.
  const CURRENT_SCHEMA = {
    version: 1,
    stores: {
      // Projects (transform & merge). Sync-aware fields:
      //   updatedAt       — local last-modified ms (always set on upsert)
      //   serverUpdatedAt — last server-acked timestamp, 0 if never synced
      //   dirty           — 1 if local changes need pushing, 0 otherwise
      //                     (numeric so it can be indexed in IDB)
      //   deleted         — 1 tombstone, kept until server acks deletion
      projects: {
        keyPath: 'id',
        autoIncrement: false,
        indexes: [
          { name: 'by_updatedAt', keyPath: 'updatedAt', unique: false },
          { name: 'by_dirty',     keyPath: 'dirty',     unique: false },
          { name: 'by_deleted',   keyPath: 'deleted',   unique: false },
          { name: 'by_type',      keyPath: 'type',      unique: false },
        ],
      },
      // Schema descriptor + migration log + arbitrary key/value config (e.g.
      // last sync cursor once the server is wired up).
      meta: {
        keyPath: 'key',
        autoIncrement: false,
        indexes: [],
      },
    },
  };

  // Ordered list of migrations. Each entry runs once per client. v1 has no
  // migrations because it is the initial schema.
  const MIGRATIONS = [
    // Example shape for a future migration:
    // {
    //   fromVersion: 1,
    //   toVersion: 2,
    //   description: 'add `archived` index to projects',
    //   upgrade(db, tx) {
    //     const store = tx.objectStore('projects');
    //     store.createIndex('by_archived', 'archived', { unique: false });
    //   },
    //   data(db, tx) {
    //     // optional: rewrite existing rows to set archived=0
    //   },
    // },
  ];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, CURRENT_SCHEMA.version);
      const appliedInUpgrade = [];

      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        const oldVersion = event.oldVersion || 0;

        // Ensure all declared stores exist with the declared indexes.
        for (const [storeName, def] of Object.entries(CURRENT_SCHEMA.stores)) {
          let store;
          if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName, {
              keyPath: def.keyPath,
              autoIncrement: !!def.autoIncrement,
            });
          } else {
            store = tx.objectStore(storeName);
          }
          for (const idx of def.indexes || []) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
            }
          }
        }

        // Run schema-changing migrations (create/delete stores, alter indexes).
        // Data transforms happen after open in a readwrite tx (see below).
        for (const m of MIGRATIONS) {
          if (m.fromVersion >= oldVersion && m.toVersion <= CURRENT_SCHEMA.version && oldVersion < m.toVersion) {
            if (typeof m.upgrade === 'function') m.upgrade(db, tx);
            appliedInUpgrade.push(m);
          }
        }
      };

      req.onsuccess = async () => {
        const db = req.result;
        try {
          // Run any data-phase migrations and migrate the legacy localStorage
          // store on first open. Then write the schema + migration log into
          // the `meta` store.
          for (const m of appliedInUpgrade) {
            if (typeof m.data === 'function') {
              await runTx(db, ['projects', 'meta'], 'readwrite', (tx) => m.data(db, tx));
            }
          }
          await migrateFromLocalStorage(db);
          await writeSchemaSnapshot(db, appliedInUpgrade);
        } catch (e) {
          // Don't fail the open just because metadata writes had a hiccup —
          // the data is still readable. Surface to the console.
          console.warn('sstransform db: post-open setup failed', e);
        }
        resolve(db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB open blocked — close other tabs'));
    });
    return dbPromise;
  }

  function runTx(db, stores, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      try {
        const r = work(tx);
        // Allow the work fn to return a value or a promise that resolves to
        // a value. We can't await inside a versionchange tx, but for
        // readwrite/readonly tx the browser keeps it alive across microtasks.
        Promise.resolve(r).then((v) => { result = v; }, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function writeSchemaSnapshot(db, justApplied) {
    await runTx(db, ['meta'], 'readwrite', (tx) => {
      const store = tx.objectStore('meta');
      store.put({
        key: 'schema',
        version: CURRENT_SCHEMA.version,
        stores: CURRENT_SCHEMA.stores,
        updatedAt: Date.now(),
      });
      // Append-only migration log so a future tool can see exactly which
      // transformations were ever applied to this client's data.
      const logReq = store.get('migrations');
      logReq.onsuccess = () => {
        const existing = logReq.result || { key: 'migrations', entries: [] };
        const now = Date.now();
        for (const m of justApplied) {
          existing.entries.push({
            fromVersion: m.fromVersion,
            toVersion: m.toVersion,
            description: m.description || '',
            ranAt: now,
          });
        }
        store.put(existing);
      };
    });
  }

  // One-time pull of pre-IndexedDB data. Safe to re-run; clears the legacy key
  // only after a successful import.
  async function migrateFromLocalStorage(db) {
    const LEGACY_KEY = 'sstransform:projects';
    let raw;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch { return; }
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;

    await runTx(db, ['projects', 'meta'], 'readwrite', (tx) => {
      const projects = tx.objectStore('projects');
      const now = Date.now();
      for (const p of Object.values(parsed)) {
        if (!p || !p.id) continue;
        // Skip if a record already exists (avoid clobbering newer data).
        const getReq = projects.get(p.id);
        getReq.onsuccess = () => {
          if (getReq.result) return;
          projects.put({
            ...p,
            updatedAt: p.updatedAt || now,
            createdAt: p.createdAt || now,
            serverUpdatedAt: 0,
            dirty: 1,
            deleted: 0,
          });
        };
      }
      tx.objectStore('meta').put({
        key: 'legacy_migration',
        ranAt: Date.now(),
        importedKey: LEGACY_KEY,
        importedCount: Object.keys(parsed).length,
      });
    });
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  }

  // ===== Public helpers used by projects.js / sync.js =====

  async function getAll(storeName) {
    const db = await open();
    return runTx(db, [storeName], 'readonly', (tx) => reqAsPromise(tx.objectStore(storeName).getAll()));
  }

  async function getByKey(storeName, key) {
    const db = await open();
    return runTx(db, [storeName], 'readonly', (tx) => reqAsPromise(tx.objectStore(storeName).get(key)));
  }

  async function put(storeName, value) {
    const db = await open();
    return runTx(db, [storeName], 'readwrite', (tx) => reqAsPromise(tx.objectStore(storeName).put(value)));
  }

  async function deleteByKey(storeName, key) {
    const db = await open();
    return runTx(db, [storeName], 'readwrite', (tx) => reqAsPromise(tx.objectStore(storeName).delete(key)));
  }

  async function clear(storeName) {
    const db = await open();
    return runTx(db, [storeName], 'readwrite', (tx) => reqAsPromise(tx.objectStore(storeName).clear()));
  }

  async function getByIndex(storeName, indexName, query) {
    const db = await open();
    return runTx(db, [storeName], 'readonly', (tx) => {
      const idx = tx.objectStore(storeName).index(indexName);
      return reqAsPromise(idx.getAll(query));
    });
  }

  // For sync: read the persisted schema descriptor without re-running open()
  // logic — useful for a future "rebuild from scratch" flow.
  async function readSchemaSnapshot() {
    return getByKey('meta', 'schema');
  }

  global.DB = {
    open,
    getAll,
    getByKey,
    put,
    deleteByKey,
    clear,
    getByIndex,
    readSchemaSnapshot,
    SCHEMA: CURRENT_SCHEMA,
  };
})(window);
