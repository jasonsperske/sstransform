// SQLite connection + migration runner.
//
// Migrations live in migrations/NNNN_name.sql (ordered by filename). The
// _migrations table tracks which have been applied. Each migration is run
// in a transaction so a partial apply leaves the DB untouched.
//
// The server imports openDb() and calls runMigrations() once at startup, so
// forks that don't remember to run `npm run db:build` still boot with the
// right schema.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, MIGRATIONS_DIR, DATA_DIR } from './config.js';

let cached = null;

export function openDb() {
  if (cached) return cached;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  cached = db;
  return db;
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      appliedAt  INTEGER NOT NULL
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

export function runMigrations({ log = () => {} } = {}) {
  const db = openDb();
  ensureMigrationsTable(db);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );
  const files = listMigrationFiles();
  const pending = files.filter(f => !applied.has(f));

  if (!pending.length) {
    log(`[db] schema up to date (${applied.size} applied, 0 pending)`);
    return { applied: [], alreadyApplied: [...applied] };
  }

  const ran = [];
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (name, appliedAt) VALUES (?, ?)'
  );

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    });
    apply();
    ran.push(file);
    log(`[db] applied ${file}`);
  }

  return { applied: ran, alreadyApplied: [...applied] };
}

export function migrationStatus() {
  const db = openDb();
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );
  const files = listMigrationFiles();
  return {
    applied: files.filter(f => applied.has(f)),
    pending: files.filter(f => !applied.has(f)),
  };
}

// ===== Query helpers =====
//
// Every helper takes the db as an explicit argument so tests / scripts
// can pass a different connection without monkeypatching.

export function createSession(db, id) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, userId, createdAt, lastSeenAt) VALUES (?, NULL, ?, ?)'
  ).run(id, now, now);
  return { id, userId: null, createdAt: now, lastSeenAt: now };
}

export function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

export function touchSession(db, id) {
  db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE id = ?').run(Date.now(), id);
}

export function attachUserToSession(db, sessionId, userId) {
  db.prepare('UPDATE sessions SET userId = ?, lastSeenAt = ? WHERE id = ?')
    .run(userId, Date.now(), sessionId);
}

export function deleteSession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function findUserByProviderSubject(db, provider, subject) {
  return db.prepare(
    'SELECT * FROM users WHERE provider = ? AND subject = ?'
  ).get(provider, subject) || null;
}

export function upsertUser(db, { id, provider, subject, email, name, picture }) {
  const now = Date.now();
  const existing = findUserByProviderSubject(db, provider, subject);
  if (existing) {
    db.prepare(
      'UPDATE users SET email = ?, name = ?, picture = ?, updatedAt = ? WHERE id = ?'
    ).run(email, name, picture, now, existing.id);
    return { ...existing, email, name, picture, updatedAt: now };
  }
  db.prepare(
    `INSERT INTO users (id, provider, subject, email, name, picture, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, provider, subject, email, name, picture, now, now);
  return { id, provider, subject, email, name, picture, createdAt: now, updatedAt: now };
}

export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function storeTokenHashes(db, { userId, provider, accessTokenHash, refreshTokenHash, expiresAt }) {
  db.prepare(
    `INSERT INTO oauth_tokens (userId, provider, accessTokenHash, refreshTokenHash, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, provider, accessTokenHash, refreshTokenHash, expiresAt, Date.now());
}

export function saveOauthState(db, row) {
  db.prepare(
    `INSERT INTO oauth_state (state, sessionId, provider, codeVerifier, nonce, redirectUri, returnTo, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.state, row.sessionId, row.provider, row.codeVerifier,
    row.nonce, row.redirectUri, row.returnTo || null, Date.now()
  );
}

export function consumeOauthState(db, state) {
  const row = db.prepare('SELECT * FROM oauth_state WHERE state = ?').get(state);
  if (row) db.prepare('DELETE FROM oauth_state WHERE state = ?').run(state);
  return row || null;
}

// Expire oauth_state rows older than 10 minutes. Called opportunistically.
export function purgeExpiredOauthState(db, { olderThanMs = 10 * 60 * 1000 } = {}) {
  db.prepare('DELETE FROM oauth_state WHERE createdAt < ?')
    .run(Date.now() - olderThanMs);
}
