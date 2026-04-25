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

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDataDir();
  try {
    return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
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
export const PROVIDERS = buildProviders();

export function providerById(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

export function redirectUriFor(req, providerId) {
  const base = OAUTH_REDIRECT_BASE || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/${providerId}/callback`;
}

export { DATA_DIR };
