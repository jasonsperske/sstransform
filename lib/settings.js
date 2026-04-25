// Per-user app settings: chosen Claude model + optional personal API key.
//
// The API key is encrypted at rest with AES-256-GCM. We store ciphertext,
// IV, and auth tag in separate columns so corruption or tampering of any
// one byte fails decryption rather than silently returning garbage.
//
// Server-side callers ask `clientAndModelFor(req.user)` to get a ready
// Anthropic client + model id; the wire-facing helpers never return the
// plaintext key (only a `hasApiKey` boolean), so the key only ever
// crosses the wire on the original PUT.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from './db.js';
import { SETTINGS_KEY, DEFAULT_ANTHROPIC_MODEL } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7 — most capable' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 — fastest' },
];

function isKnownModel(id) {
  return AVAILABLE_MODELS.some(m => m.id === id);
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, SETTINGS_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv(ALGORITHM, SETTINGS_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function readRow(db, userId) {
  return db.prepare(
    'SELECT model, apiKeyCiphertext, apiKeyIv, apiKeyTag FROM user_settings WHERE userId = ?'
  ).get(userId) || null;
}

// Returns { model, hasApiKey }. Safe to send to the client — never
// includes the decrypted key.
export function getUserSettings(db, userId) {
  const row = readRow(db, userId);
  return {
    model: row?.model || null,
    hasApiKey: !!(row && row.apiKeyCiphertext),
  };
}

// Returns the plaintext API key (or null). Server-side use only.
export function getDecryptedApiKey(db, userId) {
  const row = readRow(db, userId);
  if (!row || !row.apiKeyCiphertext) return null;
  try {
    return decrypt({
      ciphertext: row.apiKeyCiphertext,
      iv: row.apiKeyIv,
      tag: row.apiKeyTag,
    });
  } catch (err) {
    console.error('[settings] failed to decrypt user api key:', err.message);
    return null;
  }
}

function upsertColumns(db, userId, columns) {
  const existing = readRow(db, userId);
  const now = Date.now();
  if (!existing) {
    db.prepare(
      `INSERT INTO user_settings
       (userId, model, apiKeyCiphertext, apiKeyIv, apiKeyTag, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      columns.model ?? null,
      columns.apiKeyCiphertext ?? null,
      columns.apiKeyIv ?? null,
      columns.apiKeyTag ?? null,
      now,
    );
    return;
  }
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(columns)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  sets.push('updatedAt = ?');
  args.push(now);
  args.push(userId);
  db.prepare(`UPDATE user_settings SET ${sets.join(', ')} WHERE userId = ?`).run(...args);
}

// Patch update. `model` and `apiKey` are both optional — undefined means
// "leave unchanged". `model: ''` or `model: null` clears the override.
// `apiKey: ''` or `apiKey: null` clears the stored key.
export function saveUserSettings(db, userId, { model, apiKey } = {}) {
  const patch = {};
  if (model !== undefined) {
    if (model && !isKnownModel(model)) {
      throw new Error(`unknown model: ${model}`);
    }
    patch.model = model || null;
  }
  if (apiKey !== undefined) {
    if (apiKey) {
      const enc = encrypt(apiKey);
      patch.apiKeyCiphertext = enc.ciphertext;
      patch.apiKeyIv = enc.iv;
      patch.apiKeyTag = enc.tag;
    } else {
      patch.apiKeyCiphertext = null;
      patch.apiKeyIv = null;
      patch.apiKeyTag = null;
    }
  }
  if (Object.keys(patch).length === 0) return;
  upsertColumns(db, userId, patch);
}

// Removing the API key also clears any model override — a custom model
// is only meaningful when paired with the user's own billing.
export function clearUserApiKey(db, userId) {
  saveUserSettings(db, userId, { apiKey: null, model: null });
}

// Resolve the right Anthropic client + model for this request. Anonymous
// users always get the server's env key + default model. Signed-in
// users with overrides get theirs.
export function clientAndModelFor(user) {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  let model = DEFAULT_ANTHROPIC_MODEL;
  if (user) {
    const db = openDb();
    const row = readRow(db, user.id);
    if (row?.model) model = row.model;
    const userKey = getDecryptedApiKey(db, user.id);
    if (userKey) apiKey = userKey;
  }
  return { client: new Anthropic({ apiKey }), model };
}
