// Auth/session configuration derived from environment variables.
//
// Each federated provider is only "enabled" when both its client id and
// secret are present — so a fresh fork with no auth env vars reports zero
// providers and the UI hides the login controls entirely.
//
// SESSION_SECRET: used to HMAC-sign the session cookie. If absent we
// generate a 32-byte random secret once and persist it to
// data/.session-secret, so sessions survive restarts without the operator
// having to configure anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const SESSION_SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const SETTINGS_KEY_FILE = path.join(DATA_DIR, '.settings-key');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadOrGenerateSecret(envValue, file, { bytes = 32 } = {}) {
  if (envValue) return envValue;
  ensureDataDir();
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const secret = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function loadSessionSecret() {
  return loadOrGenerateSecret(process.env.SESSION_SECRET, SESSION_SECRET_FILE);
}

function loadSettingsKey() {
  const hex = loadOrGenerateSecret(process.env.SETTINGS_KEY, SETTINGS_KEY_FILE);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SETTINGS_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function buildProviders() {
  const providers = [];

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push({
      id: 'google',
      label: 'Google',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'openid email profile',
    });
  }

  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    const tenant = process.env.MICROSOFT_TENANT || 'common';
    providers.push({
      id: 'microsoft',
      label: 'Microsoft',
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      scope: 'openid email profile',
    });
  }

  return providers;
}

export const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'sstransform.sqlite');
export const MIGRATIONS_DIR = path.resolve('migrations');
export const OAUTH_REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || null;
export const SESSION_SECRET = loadSessionSecret();
export const SETTINGS_KEY = loadSettingsKey();
export const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
export const PROVIDERS = buildProviders();

// Stripe — feature is fully gated on all three values being present.
// Without them the billing UI hides itself and the API routes 404.
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || null;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
export const STRIPE_ENABLED = !!(STRIPE_PUBLISHABLE_KEY && STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);
export const CATALOG_PATH = CATALOG_FILE;

export function providerById(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

export function redirectUriFor(req, providerId) {
  const base = OAUTH_REDIRECT_BASE || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/${providerId}/callback`;
}

export { DATA_DIR };
