// Session + federated login.
//
// Session lifecycle:
//   1. Every request hits sessionMiddleware, which either reads a valid
//      signed cookie or mints a new anonymous session (userId = NULL).
//   2. When the user clicks "Sign in with X", we redirect to the provider
//      with a fresh state + PKCE verifier stored in oauth_state.
//   3. On callback, we validate state, exchange the code at the token
//      endpoint, pull identity from the id_token claims, and UPDATE the
//      SAME session row with the matched userId. No new session id is
//      issued — the cookie is unchanged — so any data attached to the
//      anonymous session follows the login.
//   4. /auth/logout deletes the session row and clears the cookie.
//
// Token storage: we receive an id_token (used to extract identity) plus an
// access_token (and optionally a refresh_token). We don't currently use
// those tokens for API calls, but per requirements we store SHA-256
// hashes in oauth_tokens so a DB leak doesn't expose live tokens.
//
// We trust the id_token claims without JWKS verification because the
// token arrived directly from the provider's /token endpoint over TLS.
// Google explicitly documents this exemption; the Microsoft token
// endpoint has the same TLS trust model. If we ever accept id_tokens
// from the client we'd need full signature verification.
import crypto from 'node:crypto';
import {
  openDb,
  createSession,
  getSession,
  touchSession,
  attachUserToSession,
  deleteSession,
  upsertUser,
  getUser,
  storeTokenHashes,
  saveOauthState,
  consumeOauthState,
  purgeExpiredOauthState,
} from './db.js';
import { deleteAllForOwner } from './projects.js';
import {
  PROVIDERS,
  providerById,
  redirectUriFor,
  SESSION_SECRET,
} from './config.js';

const COOKIE_NAME = 'sst.sid';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomId() { return b64url(crypto.randomBytes(32)); }
function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function signSessionId(id) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(id).digest();
  return `${id}.${b64url(sig)}`;
}

function verifySignedSessionId(raw) {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const id = raw.slice(0, dot);
  const expected = signSessionId(id);
  // constant-time compare
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function writeSessionCookie(res, sessionId) {
  const signed = signSessionId(sessionId);
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(signed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// ===== Session middleware =====

export function sessionMiddleware(req, res, next) {
  const db = openDb();
  const raw = req.cookies ? req.cookies[COOKIE_NAME] : null;
  const claimed = verifySignedSessionId(raw);

  let session = claimed ? getSession(db, claimed) : null;

  if (!session) {
    const id = randomId();
    session = createSession(db, id);
    writeSessionCookie(res, id);
  } else {
    touchSession(db, session.id);
  }

  req.session = session;
  req.user = session.userId ? getUser(db, session.userId) : null;
  next();
}

// ===== PKCE helpers =====

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ===== OAuth route handlers =====

function startLogin(req, res) {
  const provider = providerById(req.params.provider);
  if (!provider) return res.status(404).send('unknown provider');

  const state = randomId();
  const nonce = randomId();
  const { verifier, challenge } = pkcePair();
  const redirectUri = redirectUriFor(req, provider.id);
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : null;

  saveOauthState(openDb(), {
    state,
    sessionId: req.session.id,
    provider: provider.id,
    codeVerifier: verifier,
    nonce,
    redirectUri,
    returnTo,
  });

  const params = new URLSearchParams({
    client_id: provider.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: provider.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',  // Google; Microsoft ignores it
    prompt: 'select_account',
  });
  res.redirect(`${provider.authorizeUrl}?${params.toString()}`);
}

async function handleCallback(req, res) {
  const provider = providerById(req.params.provider);
  if (!provider) return res.status(404).send('unknown provider');

  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`oauth error: ${error} ${error_description || ''}`);
  if (!code || !state) return res.status(400).send('missing code or state');

  const db = openDb();
  purgeExpiredOauthState(db);
  const saved = consumeOauthState(db, state);
  if (!saved || saved.provider !== provider.id) {
    return res.status(400).send('invalid state');
  }
  if (saved.sessionId !== req.session.id) {
    // State was minted for a different session — likely stolen or stale.
    return res.status(400).send('session mismatch');
  }

  // Exchange code for tokens.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: saved.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: saved.codeVerifier,
  });
  const tokenRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error(`[auth] ${provider.id} token exchange failed:`, tokenRes.status, text);
    return res.status(502).send('token exchange failed');
  }
  const tokens = await tokenRes.json();
  if (!tokens.id_token) {
    return res.status(502).send('no id_token in token response');
  }

  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims || !claims.sub) {
    return res.status(502).send('invalid id_token');
  }
  if (claims.nonce && claims.nonce !== saved.nonce) {
    return res.status(400).send('nonce mismatch');
  }

  const identity = extractIdentity(provider.id, claims);
  const user = upsertUser(db, {
    id: randomId(),
    provider: provider.id,
    subject: identity.subject,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
  });

  // Associate the existing session with this user. Same session id,
  // same cookie — anything tied to the anonymous session follows.
  attachUserToSession(db, req.session.id, user.id);

  // Store hashed copies of the tokens the provider returned.
  storeTokenHashes(db, {
    userId: user.id,
    provider: provider.id,
    accessTokenHash: tokens.access_token ? sha256Hex(tokens.access_token) : '',
    refreshTokenHash: tokens.refresh_token ? sha256Hex(tokens.refresh_token) : null,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
  });

  const returnTo = safeReturnTo(saved.returnTo);
  res.redirect(returnTo);
}

function handleLogout(req, res) {
  if (req.session) {
    const db = openDb();
    // Anonymous-owned projects (orphans the user declined to merge, plus
    // anything created during this session before signing in) are tied to
    // the session id and become unreachable once the session goes away —
    // sweep them now rather than leaving dead rows in the table.
    deleteAllForOwner(db, req.session.id);
    deleteSession(db, req.session.id);
  }
  clearSessionCookie(res);
  res.redirect('/');
}

function handleMe(req, res) {
  if (!req.user) return res.json({ user: null });
  const { id, provider, email, name, picture } = req.user;
  res.json({ user: { id, provider, email, name, picture } });
}

function decodeJwtPayload(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

function extractIdentity(providerId, claims) {
  // Google: sub, email, name, picture
  // Microsoft: sub, email or preferred_username, name
  const email = claims.email || claims.preferred_username || null;
  const name = claims.name || email || null;
  const picture = claims.picture || null;
  return { subject: claims.sub, email, name, picture };
}

function safeReturnTo(value) {
  if (typeof value !== 'string') return '/';
  // Only allow same-origin relative paths.
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

// ===== Mount =====

export function mountAuthRoutes(app) {
  app.get('/auth/:provider', startLogin);
  app.get('/auth/:provider/callback', handleCallback);
  app.post('/auth/logout', handleLogout);
  app.get('/api/me', handleMe);
}

// Express middleware that 401s any request without an authenticated user.
// Mount on routes that should only be reachable when logged in.
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  next();
}

export function authViewLocals() {
  return {
    providers: PROVIDERS.map(p => ({ id: p.id, label: p.label })),
    authEnabled: PROVIDERS.length > 0,
  };
}
