// Stripe-backed token billing.
//
// The feature is gated on STRIPE_ENABLED — when any of the three Stripe
// env vars is missing, every public function here is a no-op and the
// routes in server.js return 404. Existing BYOK and free-tier flows
// keep working unchanged.
//
// Token model (raw Claude tokens, see migration 0004):
//   - Credit on `checkout.session.completed`: pack.tokens added,
//     ledger row carries the Stripe event id (UNIQUE) for idempotency.
//   - Debit after each Claude call: response.usage.input_tokens +
//     response.usage.output_tokens subtracted, clamped at 0.
//
// Catalog (data/catalog.json) defines the SKUs the operator wants to
// sell — id / label / tokens / priceCents / currency. We pass these
// to Stripe Checkout as inline `price_data` so no Stripe Product setup
// is required. See README for the schema.
import fs from 'node:fs';
import Stripe from 'stripe';
import {
  STRIPE_ENABLED,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  CATALOG_PATH,
} from './config.js';

let stripeClient = null;
function stripe() {
  if (!STRIPE_ENABLED) return null;
  if (!stripeClient) stripeClient = new Stripe(STRIPE_SECRET_KEY);
  return stripeClient;
}

// ---- Catalog ----------------------------------------------------------

let catalogCache = null;
let catalogMtime = 0;

function readCatalogFile() {
  const stat = fs.statSync(CATALOG_PATH); // throws if missing
  if (catalogCache && stat.mtimeMs === catalogMtime) return catalogCache;
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  validateCatalog(parsed);
  catalogCache = parsed;
  catalogMtime = stat.mtimeMs;
  return parsed;
}

function validateCatalog(c) {
  if (!c || typeof c !== 'object') throw new Error('catalog must be an object');
  if (!c.currency || typeof c.currency !== 'string') {
    throw new Error('catalog.currency required (e.g. "usd")');
  }
  if (!Array.isArray(c.packs) || c.packs.length === 0) {
    throw new Error('catalog.packs must be a non-empty array');
  }
  const ids = new Set();
  for (const p of c.packs) {
    if (!p.id || typeof p.id !== 'string') throw new Error('pack.id required');
    if (ids.has(p.id)) throw new Error(`duplicate pack id: ${p.id}`);
    ids.add(p.id);
    if (!p.description || typeof p.description !== 'string') throw new Error(`pack ${p.id}: description required`);
    if (!Number.isInteger(p.tokens) || p.tokens <= 0) {
      throw new Error(`pack ${p.id}: tokens must be a positive integer`);
    }
    if (!Number.isInteger(p.priceCents) || p.priceCents <= 0) {
      throw new Error(`pack ${p.id}: priceCents must be a positive integer`);
    }
  }
}

export function loadCatalog() {
  if (!STRIPE_ENABLED) return null;
  try {
    return readCatalogFile();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function findPack(id) {
  const c = loadCatalog();
  return c?.packs.find(p => p.id === id) || null;
}

// ---- Balance + ledger -------------------------------------------------

export function getBalance(db, userId) {
  const row = db.prepare(
    'SELECT tokenBalance FROM user_settings WHERE userId = ?'
  ).get(userId);
  return row?.tokenBalance ?? 0;
}

// Credit is wrapped in a transaction with the ledger insert. The ledger
// has a UNIQUE constraint on stripeEventId; SQLite raises on duplicates,
// which we treat as "already processed" and silently swallow.
export function creditTokens(db, { userId, tokens, reason, stripeEventId }) {
  if (!Number.isInteger(tokens) || tokens <= 0) {
    throw new Error('tokens must be a positive integer');
  }
  const tx = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO token_ledger (userId, delta, reason, stripeEventId, createdAt)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, tokens, reason, stripeEventId || null, Date.now());
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw err;
    }
    ensureSettingsRow(db, userId);
    db.prepare(
      'UPDATE user_settings SET tokenBalance = tokenBalance + ?, updatedAt = ? WHERE userId = ?'
    ).run(tokens, Date.now(), userId);
    return true;
  });
  return tx();
}

// Debit is best-effort: clamps at 0 and records the actual amount taken.
// We never refund a partial overage — if the user's last call put them
// 5k tokens negative, we just zero them out and move on.
export function debitTokens(db, { userId, tokens, reason }) {
  if (!Number.isInteger(tokens) || tokens <= 0) return 0;
  const tx = db.transaction(() => {
    const current = getBalance(db, userId);
    if (current <= 0) return 0;
    const taken = Math.min(current, tokens);
    db.prepare(
      `INSERT INTO token_ledger (userId, delta, reason, stripeEventId, createdAt)
       VALUES (?, ?, ?, NULL, ?)`
    ).run(userId, -taken, reason, Date.now());
    db.prepare(
      'UPDATE user_settings SET tokenBalance = tokenBalance - ?, updatedAt = ? WHERE userId = ?'
    ).run(taken, Date.now(), userId);
    return taken;
  });
  return tx();
}

function ensureSettingsRow(db, userId) {
  const exists = db.prepare(
    'SELECT 1 FROM user_settings WHERE userId = ?'
  ).get(userId);
  if (!exists) {
    db.prepare(
      `INSERT INTO user_settings (userId, model, tokenBalance, updatedAt)
       VALUES (?, NULL, 0, ?)`
    ).run(userId, Date.now());
  }
}

// ---- Reconciliation --------------------------------------------------
//
// The cached `user_settings.tokenBalance` is updated atomically alongside
// every credit/debit ledger insert, so under normal operation it stays in
// sync. Reconciliation is the safety net for things that bypass that
// path: manual SQL edits, half-applied future migrations, or a bug in
// new code that touches one side but not the other.
//
// The ledger is treated as the source of truth — it's append-only with a
// UNIQUE-stripeEventId guard for idempotency, so it shouldn't lie. The
// cached column is a derived value that gets repaired to match.

function recomputedFromLedger(db, userId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS sum FROM token_ledger WHERE userId = ?'
  ).get(userId);
  if (row.sum < 0) {
    // Should never happen — debits clamp to the available balance before
    // inserting. If it does, something has corrupted the ledger; keep
    // the user at zero rather than letting them owe negative tokens.
    console.warn(`[billing] ledger sum negative for ${userId}: ${row.sum} — clamping to 0`);
    return 0;
  }
  return row.sum;
}

// Reconcile a single user. Cheap (one SUM, indexed on userId). Returns
// { previous, recomputed, drift } so the caller can log fixes.
export function reconcileBalance(db, userId) {
  const tx = db.transaction(() => {
    ensureSettingsRow(db, userId);
    const recomputed = recomputedFromLedger(db, userId);
    const cur = db.prepare(
      'SELECT tokenBalance FROM user_settings WHERE userId = ?'
    ).get(userId);
    const previous = cur?.tokenBalance ?? 0;
    if (previous !== recomputed) {
      db.prepare(
        'UPDATE user_settings SET tokenBalance = ?, updatedAt = ? WHERE userId = ?'
      ).run(recomputed, Date.now(), userId);
    }
    return { previous, recomputed, drift: previous - recomputed };
  });
  return tx();
}

// Sweep every user_settings row in one pass. Returns only the users
// whose cached balance had drifted — empty array means the cache is
// already in sync with the ledger.
export function reconcileAllBalances(db) {
  const rows = db.prepare(`
    SELECT us.userId,
           us.tokenBalance AS cached,
           COALESCE(SUM(tl.delta), 0) AS sum
    FROM user_settings us
    LEFT JOIN token_ledger tl ON tl.userId = us.userId
    GROUP BY us.userId
  `).all();
  const fixes = [];
  const update = db.prepare(
    'UPDATE user_settings SET tokenBalance = ?, updatedAt = ? WHERE userId = ?'
  );
  const tx = db.transaction(() => {
    const now = Date.now();
    for (const r of rows) {
      const recomputed = r.sum < 0 ? 0 : r.sum;
      if (r.sum < 0) {
        console.warn(`[billing] ledger sum negative for ${r.userId}: ${r.sum} — clamping to 0`);
      }
      if (r.cached !== recomputed) {
        update.run(recomputed, now, r.userId);
        fixes.push({ userId: r.userId, previous: r.cached, recomputed, drift: r.cached - recomputed });
      }
    }
  });
  tx();
  return fixes;
}

// ---- Stripe customer + checkout --------------------------------------

export async function getOrCreateStripeCustomer(db, user) {
  const s = stripe();
  if (!s) throw new Error('Stripe not configured');
  ensureSettingsRow(db, user.id);
  const row = db.prepare(
    'SELECT stripeCustomerId FROM user_settings WHERE userId = ?'
  ).get(user.id);
  if (row?.stripeCustomerId) return row.stripeCustomerId;

  const customer = await s.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { userId: user.id },
  });
  db.prepare(
    'UPDATE user_settings SET stripeCustomerId = ?, updatedAt = ? WHERE userId = ?'
  ).run(customer.id, Date.now(), user.id);
  return customer.id;
}

export async function createCheckoutSession(db, { user, packId, successUrl, cancelUrl }) {
  const s = stripe();
  if (!s) throw new Error('Stripe not configured');
  const catalog = loadCatalog();
  if (!catalog) throw new Error('catalog not configured');
  const pack = catalog.packs.find(p => p.id === packId);
  if (!pack) throw new Error(`unknown pack: ${packId}`);

  const customerId = await getOrCreateStripeCustomer(db, user);
  return s.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: catalog.currency,
        unit_amount: pack.priceCents,
        product_data: {
          name: pack.description,
          description: `${pack.tokens.toLocaleString()} Claude tokens`,
        },
      },
    }],
    metadata: { userId: user.id, packId: pack.id, tokens: String(pack.tokens) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// ---- Webhook ---------------------------------------------------------

export function verifyWebhook(rawBody, signature) {
  const s = stripe();
  if (!s) throw new Error('Stripe not configured');
  return s.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

// Raw ledger entries for this user, newest first. `limit` is clamped to
// [1, 5000] — anything larger is almost certainly the .xlsx export
// (which passes a high cap explicitly) rather than a UI request.
export function getTransactionHistory(db, userId, { limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(5000, limit | 0));
  return db.prepare(
    `SELECT id, delta, reason, stripeEventId, createdAt
     FROM token_ledger
     WHERE userId = ?
     ORDER BY createdAt DESC, id DESC
     LIMIT ?`
  ).all(userId, cap);
}

// Daily debit totals for the last `days` days, oldest first. Days with
// no usage are filled in as zeros so the chart shows a continuous range.
// Only debits (delta < 0) are counted — credits would otherwise dwarf
// any usage signal.
export function getUsageHistory(db, userId, days = 30) {
  const dayMs = 24 * 60 * 60 * 1000;
  const since = Date.now() - days * dayMs;
  const rows = db.prepare(
    `SELECT createdAt, delta FROM token_ledger
     WHERE userId = ? AND delta < 0 AND createdAt >= ?`
  ).all(userId, since);
  const buckets = new Map();
  for (const r of rows) {
    const key = new Date(r.createdAt).toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) || 0) + Math.abs(r.delta));
  }
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * dayMs).toISOString().slice(0, 10);
    result.push({ date: key, tokens: buckets.get(key) || 0 });
  }
  return result;
}

// Returns { credited: <tokens> } when a checkout.session.completed adds
// tokens, or { credited: 0 } for any other event (or duplicate event).
export function handleWebhookEvent(db, event) {
  if (event.type !== 'checkout.session.completed') return { credited: 0 };
  const session = event.data.object;
  const userId = session.client_reference_id || session.metadata?.userId;
  const tokensStr = session.metadata?.tokens;
  const packId = session.metadata?.packId;
  if (!userId || !tokensStr) return { credited: 0 };
  const tokens = parseInt(tokensStr, 10);
  if (!Number.isFinite(tokens) || tokens <= 0) return { credited: 0 };
  const ok = creditTokens(db, {
    userId,
    tokens,
    reason: `stripe:${packId || 'pack'}`,
    stripeEventId: event.id,
  });
  return { credited: ok ? tokens : 0 };
}
