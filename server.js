import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import 'dotenv/config';
import { runMigrations, openDb } from './lib/db.js';
import { sessionMiddleware, mountAuthRoutes, authViewLocals, requireAuth } from './lib/auth.js';
import {
  listForOwner,
  getOne,
  putProject,
  deleteProject,
  mergeOwner,
  deleteAllForOwner,
} from './lib/projects.js';
import {
  AVAILABLE_MODELS,
  clientAndModelFor,
  getUserSettings,
  saveUserSettings,
  clearUserApiKey,
  supportsAdaptiveThinking,
} from './lib/settings.js';
import {
  loadCatalog,
  createCheckoutSession,
  verifyWebhook,
  handleWebhookEvent,
  debitTokens,
  getUsageHistory,
  getTransactionHistory,
  reconcileAllBalances,
} from './lib/billing.js';
import XLSX from 'xlsx-js-style';
import { DEFAULT_ANTHROPIC_MODEL, STRIPE_ENABLED, STRIPE_PUBLISHABLE_KEY } from './lib/config.js';

// Apply any pending migrations before the server takes traffic. Safe to
// run on every boot — it's a no-op when the schema is up to date.
runMigrations({ log: (m) => console.log(m) });

// Reconcile the cached `user_settings.tokenBalance` against the ledger.
// Normally a no-op; logs and repairs any drift introduced by manual SQL
// edits, half-applied migrations, or future code that touches the
// ledger without going through credit/debitTokens.
{
  const fixes = reconcileAllBalances(openDb());
  if (fixes.length) {
    console.warn(`[billing] reconciled ${fixes.length} drifted balance(s):`);
    for (const f of fixes) {
      console.warn(`  ${f.userId}: cached=${f.previous} ledger=${f.recomputed} (drift ${f.drift > 0 ? '+' : ''}${f.drift})`);
    }
  } else {
    console.log('[billing] balance cache reconciled with ledger');
  }
}

const app = express();
app.use(cookieParser());

// Stripe webhook MUST receive the raw request body so the signature
// header verifies correctly. Mount this route before express.json() so
// the global JSON parser doesn't consume the stream first.
if (STRIPE_ENABLED) {
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).send('missing signature');
    let event;
    try {
      event = verifyWebhook(req.body, sig);
    } catch (err) {
      console.error('[billing] webhook verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      handleWebhookEvent(openDb(), event);
    } catch (err) {
      console.error('[billing] webhook handler failed:', err);
      return res.status(500).send('handler error');
    }
    res.json({ received: true });
  });
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));
app.use('/vendor/xlsx-js-style', express.static(path.join(import.meta.dirname, 'node_modules/xlsx-js-style/dist')));

app.set('view engine', 'ejs');
app.set('views', path.join(import.meta.dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.locals.ga = process.env.GA || null;
app.locals.adwords = process.env.GOOGLE_ADWORDS || null;
app.locals.stripeEnabled = STRIPE_ENABLED;
Object.assign(app.locals, authViewLocals());

app.use(sessionMiddleware);
function safeCurrentUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, picture: user.picture, provider: user.provider };
}

app.use((req, res, next) => {
  res.locals.currentUser = req.user
    ? { id: req.user.id, name: req.user.name, email: req.user.email, picture: req.user.picture, provider: req.user.provider }
    : null;
  res.locals.safeCurrentUser = safeCurrentUser;
  next();
});

mountAuthRoutes(app);

// ===== Projects =====
//
// Server is the only copy. Each row is keyed by `ownerKey` — the user id
// for signed-in visitors, the session id for anonymous ones. Last writer
// wins on PUT; clients refetch on next page load to pick up changes from
// other tabs/devices. Anonymous projects can be re-keyed onto a user
// account via POST /api/orphan-projects/merge after sign-in.

function ownerKeyOf(req) {
  return req.user ? req.user.id : req.session.id;
}

app.get('/api/projects', (req, res) => {
  const rows = listForOwner(openDb(), ownerKeyOf(req));
  res.json({
    projects: rows.map(r => ({
      id: r.id,
      project: JSON.parse(r.data),
      updatedAt: r.updatedAt,
    })),
  });
});

// Orphan endpoints must come BEFORE /api/projects/:id so 'orphan-projects'
// isn't matched as a project id. They're keyed by req.session.id (the
// pre-login owner key) and only meaningful once the user is authenticated
// — for an anonymous visitor the session id IS the current owner, so
// nothing is orphaned.
app.get('/api/orphan-projects', requireAuth, (req, res) => {
  const rows = listForOwner(openDb(), req.session.id);
  res.json({
    projects: rows.map(r => ({
      id: r.id,
      project: JSON.parse(r.data),
      updatedAt: r.updatedAt,
    })),
  });
});

app.post('/api/orphan-projects/merge', requireAuth, (req, res) => {
  const result = mergeOwner(openDb(), req.session.id, req.user.id);
  res.json(result);
});

app.post('/api/orphan-projects/discard', requireAuth, (req, res) => {
  const removed = deleteAllForOwner(openDb(), req.session.id);
  res.json({ removed });
});

app.get('/api/projects/:id', (req, res) => {
  const row = getOne(openDb(), ownerKeyOf(req), req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ project: JSON.parse(row.data), updatedAt: row.updatedAt });
});

app.put('/api/projects/:id', (req, res) => {
  const { project } = req.body || {};
  if (!project || typeof project !== 'object') {
    return res.status(400).json({ error: 'project body required' });
  }
  if (project.id && project.id !== req.params.id) {
    return res.status(400).json({ error: 'id mismatch' });
  }
  const result = putProject(openDb(), {
    ownerKey: ownerKeyOf(req),
    id: req.params.id,
    data: project,
  });
  res.json({ updatedAt: result.updatedAt });
});

app.delete('/api/projects/:id', (req, res) => {
  const removed = deleteProject(openDb(), ownerKeyOf(req), req.params.id);
  res.json({ removed });
});

// ===== User settings (model + personal API key) =====

app.get('/api/settings', requireAuth, (req, res) => {
  const s = getUserSettings(openDb(), req.user.id);
  res.json({
    model: s.model,
    hasApiKey: s.hasApiKey,
    tokenBalance: s.tokenBalance,
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    availableModels: AVAILABLE_MODELS,
    billingEnabled: STRIPE_ENABLED,
  });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { model, apiKey } = req.body || {};
  // Only forward fields actually provided; undefined means leave alone.
  const patch = {};
  if (model !== undefined) patch.model = typeof model === 'string' ? model : null;
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }
    // Empty string from the form means "no change"; explicit clearing
    // goes through DELETE /api/settings/api-key.
    if (apiKey.length > 0) patch.apiKey = apiKey;
  }
  // Gate: a non-default model can only be set when the user has either
  // (a) their own API key (BYOK — they pay Anthropic directly) or
  // (b) a positive prepaid token balance (we pay Anthropic with the
  // operator key and debit their balance). Otherwise the operator's env
  // key would silently subsidise the user's chosen model. Picking the
  // free default explicitly is always allowed.
  if (patch.model && patch.model !== DEFAULT_ANTHROPIC_MODEL) {
    const current = getUserSettings(openDb(), req.user.id);
    const willHaveKey = current.hasApiKey || patch.apiKey;
    const hasBalance = (current.tokenBalance || 0) > 0;
    if (!willHaveKey && !hasBalance) {
      return res.status(400).json({
        error: 'add a personal API key or buy tokens before choosing a model',
      });
    }
  }
  try {
    saveUserSettings(openDb(), req.user.id, patch);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const s = getUserSettings(openDb(), req.user.id);
  res.json({ model: s.model, hasApiKey: s.hasApiKey });
});

app.delete('/api/settings/api-key', requireAuth, (req, res) => {
  clearUserApiKey(openDb(), req.user.id);
  res.json({ hasApiKey: false });
});

// ===== Billing (Stripe-backed token packs) =====
//
// All routes 404 when Stripe isn't configured, so a fork without
// payment keys gets the same shape as if these routes didn't exist.

app.get('/api/billing/status', requireAuth, (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'billing not configured' });
  const s = getUserSettings(openDb(), req.user.id);
  let catalog = null;
  try {
    catalog = loadCatalog();
  } catch (err) {
    console.error('[billing] catalog load failed:', err.message);
  }
  res.json({
    enabled: !!catalog,
    publishableKey: STRIPE_PUBLISHABLE_KEY,
    tokenBalance: s.tokenBalance,
    catalog: catalog || { currency: 'usd', packs: [] },
  });
});

app.get('/api/billing/usage', requireAuth, (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'billing not configured' });
  res.json({ usage: getUsageHistory(openDb(), req.user.id, 30) });
});

app.get('/api/billing/transactions', requireAuth, (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'billing not configured' });
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  const rows = getTransactionHistory(openDb(), req.user.id, { limit });
  res.json({ transactions: rows });
});

// Full ledger export. Streams an .xlsx with all entries oldest-first so
// the running balance column reads naturally. Cap at 5000 rows to match
// getTransactionHistory's clamp — well above what any real user would
// generate in normal use.
app.get('/api/billing/transactions.xlsx', requireAuth, (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'billing not configured' });
  const desc = getTransactionHistory(openDb(), req.user.id, { limit: 5000 });
  const rows = desc.slice().reverse(); // oldest-first for running balance
  let running = 0;
  const aoa = [
    ['Date', 'Description', 'Type', 'Tokens', 'Running balance', 'Reference'],
    ...rows.map(r => {
      running += r.delta;
      return [
        new Date(r.createdAt).toISOString(),
        humanizeReason(r.reason),
        r.delta >= 0 ? 'Credit' : 'Debit',
        Math.abs(r.delta),
        Math.max(0, running),
        r.stripeEventId || '',
      ];
    }),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 22 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 15 }, { wch: 32 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `sstransform-transactions-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

function humanizeReason(reason) {
  if (!reason) return '';
  if (reason.startsWith('stripe:')) {
    const pack = reason.slice('stripe:'.length);
    return pack && pack !== 'pack' ? `Token purchase (${pack})` : 'Token purchase';
  }
  if (reason === 'transform') return 'Transform request';
  if (reason === 'merge') return 'Merge request';
  return reason;
}

app.post('/api/billing/checkout', requireAuth, async (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'billing not configured' });
  const { packId } = req.body || {};
  if (!packId || typeof packId !== 'string') {
    return res.status(400).json({ error: 'packId required' });
  }
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const session = await createCheckoutSession(openDb(), {
      user: req.user,
      packId,
      successUrl: `${base}/settings?checkout=success`,
      cancelUrl: `${base}/settings?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout error:', err);
    res.status(400).json({ error: err.message || 'checkout failed' });
  }
});

const xlsxScript = '/vendor/xlsx-js-style/xlsx.bundle.js';
const homeScripts = [
  '/analytics.js',
  '/projects.js',
  '/auth-merge.js',
  '/home.js',
];
const transformScripts = [
  xlsxScript,
  '/analytics.js',
  '/projects.js',
  '/auth-merge.js',
  '/billing-notice.js',
  '/app.js',
];
const mergeScripts = [
  xlsxScript,
  '/analytics.js',
  '/projects.js',
  '/auth-merge.js',
  '/billing-notice.js',
  '/tools.js',
  '/merge.js',
];

app.get('/', (req, res) => {
  res.render('index', {
    title: 'Spreadsheet Transform',
    subtitle: "map one spreadsheet's columns into another's shape",
    bodyScripts: homeScripts,
  });
});

app.get('/transform/:id?', (req, res) => {
  res.render('transform', {
    title: 'Spreadsheet Transform — Transform',
    subtitle: "map one spreadsheet's columns into another's shape",
    projectId: req.params.id || null,
    bodyScripts: transformScripts,
  });
});

app.get('/merge/:id?', (req, res) => {
  res.render('merge', {
    title: 'Spreadsheet Transform — Merge',
    subtitle: 'merge two spreadsheets into one',
    projectId: req.params.id || null,
    bodyScripts: mergeScripts,
  });
});

app.get('/settings', (req, res) => {
  if (!req.user) return res.redirect('/');
  res.render('settings', {
    title: 'Spreadsheet Transform — Settings',
    subtitle: 'your account preferences',
    bodyScripts: ['/analytics.js', '/settings.js'],
  });
});

const transformationsSchema = {
  type: 'object',
  properties: {
    transformations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetColumn: { type: 'string' },
          code: {
            type: 'string',
            description: 'JavaScript function body. Receives `row` (object keyed by source column names). Must contain a return statement. Empty string if no reasonable mapping exists.'
          },
          notes: {
            type: 'string',
            description: 'Short explanation of the mapping, or why no mapping was possible.'
          }
        },
        required: ['targetColumn', 'code', 'notes'],
        additionalProperties: false
      }
    },
    suggestedName: {
      type: 'string',
      description: 'Short descriptive project name when requested via suggestName; empty string otherwise.'
    }
  },
  required: ['transformations', 'suggestedName'],
  additionalProperties: false
};

function buildPrompt({ sourceHeaders, targetHeaders, sourceSample, existingTransformations, refinementComment, targetColumn, suggestName }) {
  let msg = `You are mapping data from a source spreadsheet to a destination spreadsheet format.

Source columns: ${JSON.stringify(sourceHeaders)}
Target columns: ${JSON.stringify(targetHeaders)}

Sample source rows:
${JSON.stringify(sourceSample, null, 2)}
`;

  if (existingTransformations && existingTransformations.length) {
    msg += `\nCurrent transformations:\n${JSON.stringify(existingTransformations, null, 2)}\n`;
  }

  if (refinementComment) {
    msg += `\nUser feedback: ${refinementComment}\n`;
    if (targetColumn) {
      msg += `Focus the refinement on the target column "${targetColumn}" (leave others unchanged).\n`;
    }
  }

  msg += `
For each target column, produce a JavaScript function body that transforms a source row into the target value.

Rules:
- The body receives a single argument \`row\` — an object whose keys are the source column names exactly as listed above.
- Use bracket notation \`row['Column Name']\` (source column names may contain spaces or punctuation).
- The body MUST end with a return statement.
- Do NOT include the function declaration wrapper — body only.
- Keep code concise, defensive (tolerate undefined/null), and pure (no I/O, no globals beyond standard JS).
- If no reasonable mapping exists for a target column, set code to an empty string and explain in notes.
- You may combine multiple source columns, parse dates, split/join strings, convert units, etc.

Example entry:
{
  "targetColumn": "Full Name",
  "code": "return [(row['FirstName']||''),(row['LastName']||'')].filter(Boolean).join(' ');",
  "notes": "Joins FirstName and LastName with a space, dropping empties."
}

${existingTransformations && existingTransformations.length ? 'Return the full updated transformation set (one entry per target column).' : 'Return one entry for every target column listed above.'}

${suggestName
  ? 'Also propose a short project name (3–6 words) for `suggestedName`. This is a data-transformation project; describe what is being transformed based on the source columns and sample values (e.g. "Customer contacts transform", "Invoice line items transform", "Sensor readings transform"). Do not use quotes or punctuation around the name.'
  : 'Set `suggestedName` to an empty string.'}`;

  return msg;
}

app.post('/api/transform', async (req, res) => {
  try {
    const { sourceHeaders, targetHeaders, sourceSample } = req.body;
    if (!Array.isArray(sourceHeaders) || !Array.isArray(targetHeaders)) {
      return res.status(400).json({ error: 'sourceHeaders and targetHeaders must be arrays' });
    }

    const { client, model, debit } = clientAndModelFor(req.user);
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {}),
      messages: [{ role: 'user', content: buildPrompt(req.body) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: transformationsSchema
        }
      }
    });
    const exhausted = debit ? chargeUsage(debit.userId, response.usage, 'transform') : null;

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text block in Claude response' });
    }
    const data = JSON.parse(textBlock.text);
    data.model = model;
    if (exhausted) data.tokensExhausted = exhausted;
    res.json(data);
  } catch (err) {
    console.error('transform error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// Charge the call against the user's prepaid balance. When this debit
// zeros the balance AND the user had a non-default model selected, drop
// the saved preference so the settings UI stops claiming a model the
// next request can't actually use, and return the info the caller needs
// to surface a "you ran out" popup. Returns null otherwise.
function chargeUsage(userId, usage, reason) {
  const tokens = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
  if (tokens <= 0) return null;
  const db = openDb();
  try {
    debitTokens(db, { userId, tokens, reason });
  } catch (err) {
    console.error('[billing] debit failed:', err);
    return null;
  }
  const settings = getUserSettings(db, userId);
  if (settings.tokenBalance > 0) return null;
  if (!settings.model || settings.model === DEFAULT_ANTHROPIC_MODEL) return null;
  const previous = settings.model;
  try {
    saveUserSettings(db, userId, { model: null });
  } catch (err) {
    console.error('[billing] reset model failed:', err);
    return null;
  }
  const labelOf = (id) => AVAILABLE_MODELS.find(m => m.id === id)?.label || id;
  return {
    previousModel: previous,
    previousLabel: labelOf(previous),
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    defaultLabel: labelOf(DEFAULT_ANTHROPIC_MODEL),
  };
}

const mergeSchema = {
  type: 'object',
  properties: {
    suggestedName: {
      type: 'string',
      description: 'Short descriptive project name when requested via suggestName; empty string otherwise.'
    },
    matchCode: {
      type: 'string',
      description: 'JS function body with signature (leftRow, rightRow). Returns truthy if the two rows represent the same entity. Must end with a return statement.'
    },
    matchNotes: {
      type: 'string',
      description: 'One-line explanation of the matching strategy.'
    },
    matchColumns: {
      type: 'array',
      description: 'Structured summary of which columns matchCode compares. One entry per column pair — if matchCode ANDs/ORs several pairs, list each pair.',
      items: {
        type: 'object',
        properties: {
          left: {
            type: 'string',
            description: 'Left column name (or a short expression when the match combines columns, e.g. "FirstName + LastName").'
          },
          right: {
            type: 'string',
            description: 'Corresponding right column name or expression.'
          },
          strategy: {
            type: 'string',
            description: 'Short phrase describing how the pair is compared — e.g. "exact", "lowercase/trim", "levenshtein <= 2", "date equality".'
          }
        },
        required: ['left', 'right', 'strategy'],
        additionalProperties: false
      }
    },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          code: {
            type: 'string',
            description: 'JS function body with signature (left, right, priority). Returns the merged value for this column. left or right may be null when the row was only present in one source. Must end with a return statement.'
          },
          notes: { type: 'string' },
        },
        required: ['name', 'code', 'notes'],
        additionalProperties: false,
      }
    }
  },
  required: ['suggestedName', 'matchCode', 'matchNotes', 'matchColumns', 'columns'],
  additionalProperties: false
};

function buildMergePrompt({ leftHeaders, rightHeaders, leftSample, rightSample, priority, existingMatchCode, existingMatchColumns, existingColumns, refinementComment, refineColumn, refineMatch, suggestName }) {
  let msg = `You are merging two spreadsheets (left and right) into a single combined spreadsheet.

Left columns: ${JSON.stringify(leftHeaders)}
Right columns: ${JSON.stringify(rightHeaders)}
Priority (which side wins conflicts): ${priority}

Sample left rows:
${JSON.stringify(leftSample, null, 2)}

Sample right rows:
${JSON.stringify(rightSample, null, 2)}
`;

  if (existingMatchCode) {
    msg += `\nCurrent matchCode:\n${existingMatchCode}\n`;
  }
  if (existingMatchColumns && existingMatchColumns.length) {
    msg += `\nCurrent matchColumns:\n${JSON.stringify(existingMatchColumns, null, 2)}\n`;
  }
  if (existingColumns && existingColumns.length) {
    msg += `\nCurrent columns:\n${JSON.stringify(existingColumns, null, 2)}\n`;
  }
  if (refinementComment) {
    msg += `\nUser feedback: ${refinementComment}\n`;
  }
  if (refineColumn) {
    msg += `\nFocus the refinement on the output column named "${refineColumn}" ONLY. Leave matchCode, matchColumns, and every other output column unchanged from the current values above. Still return the complete current state for every field.\n`;
  }
  if (refineMatch) {
    msg += `\nFocus the refinement on matchCode and matchColumns ONLY (the row-matching logic). Leave every output column unchanged from its current code and notes. Still return the complete current state for every field.\n`;
  }

  msg += `
Available runtime helper (globally available — do NOT redefine it, just call it):
- levenshteinDistance(a, b) → number. Returns the edit distance between two strings (null-safe; non-string inputs are coerced via String()). Use this for fuzzy text matching when free-text fields (names, addresses, company names) may have minor typos, casing, or punctuation differences. Typical thresholds:
    - short fields (≤ 10 chars): distance <= 1 or 2
    - longer fields: distance / Math.max(a.length, b.length) < 0.15–0.25
  Always normalize (lowercase, trim, collapse whitespace) before calling it so trivial differences don't inflate the distance.

Produce:

1. matchCode — a JavaScript function body with signature (leftRow, rightRow). Returns truthy if the two rows represent the same underlying entity.
   - leftRow and rightRow are plain objects keyed by the column names listed above.
   - Use bracket notation: leftRow['Column Name'] (column names may contain spaces or punctuation).
   - Normalize before comparing, e.g. String(x || '').toLowerCase().trim().
   - Prefer a stable id / key column (id, email, sku) with exact equality. Fall back to a combination of normalized fields when no single key exists.
   - When comparing one or more free-text columns where the sample data shows likely typos or inconsistent formatting, use levenshteinDistance to match on similarity. Example:
       const norm = (x) => String(x || '').toLowerCase().trim().replace(/\\s+/g, ' ');
       const ln = norm(leftRow['Company']);
       const rn = norm(rightRow['Company']);
       if (ln && rn && levenshteinDistance(ln, rn) <= Math.max(2, Math.floor(Math.max(ln.length, rn.length) * 0.2))) return true;
       return false;
   - The body MUST end with a return statement. Body only — no function wrapper.

2. matchColumns — a structured summary of the column pairs matchCode compares. One entry per pair with { left, right, strategy }. If matchCode ANDs/ORs multiple pairs, include every pair. Keep strategy terse (e.g. "exact", "lowercase/trim", "levenshtein <= 2"). The UI uses this to show users which columns drive the join.

3. columns — the output columns for the merged sheet. Each entry is { name, code, notes }.
   - Default to the union of left and right headers (in a natural order that preserves left-side order first, then right-side headers not in left).
   - You may rename, combine, or drop columns when that produces a cleaner merged sheet.
   - code is a JavaScript function body with signature (left, right, priority).
       - left or right may be null / undefined when a row exists only in one source.
       - priority is 'left' or 'right'. When both sides contribute to the column, prefer the priority side and fall back to the other if that value is empty.
       - Tolerate undefined/null with guards like (left && left['Col']).
       - Example for a column present on both sides:
           const l = (left && left['Email']) || '';
           const r = (right && right['Email']) || '';
           return priority === 'left' ? (l || r) : (r || l);
       - The body MUST end with a return statement.
   - notes: one-line explanation of the column mapping.

${suggestName
  ? 'Also propose a short 3–6 word project name in `suggestedName` describing the merge (e.g. "Customers merge", "Orders with invoices merge", "Users and subscriptions merge"). No quotes or punctuation.'
  : 'Set `suggestedName` to an empty string.'}`;

  return msg;
}

app.post('/api/merge', async (req, res) => {
  try {
    const { leftHeaders, rightHeaders } = req.body;
    if (!Array.isArray(leftHeaders) || !Array.isArray(rightHeaders)) {
      return res.status(400).json({ error: 'leftHeaders and rightHeaders must be arrays' });
    }

    const { client, model, debit } = clientAndModelFor(req.user);
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {}),
      messages: [{ role: 'user', content: buildMergePrompt(req.body) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: mergeSchema
        }
      }
    });
    const exhausted = debit ? chargeUsage(debit.userId, response.usage, 'merge') : null;

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text block in Claude response' });
    }
    const data = JSON.parse(textBlock.text);
    data.model = model;
    if (exhausted) data.tokensExhausted = exhausted;
    res.json(data);
  } catch (err) {
    console.error('merge error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sstransform listening on http://localhost:${port}`));
