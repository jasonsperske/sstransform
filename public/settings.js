// Settings page: load current settings, let the user pick a model and
// optionally store a personal Anthropic API key. The API key is
// write-only from the client's perspective — the server only ever
// returns a `hasApiKey` boolean.
(function() {
  const form         = document.getElementById('settings-form');
  const modelSelect  = document.getElementById('model-select');
  const modelHint    = document.getElementById('model-hint');
  const apiKeyInput  = document.getElementById('api-key-input');
  const apiKeyState  = document.getElementById('api-key-state');
  const apiKeyBadge  = document.getElementById('api-key-badge');
  const apiKeyRemove = document.getElementById('api-key-remove');
  const apiKeyHint   = document.getElementById('api-key-hint');
  const statusEl     = document.getElementById('settings-status');
  const saveBtn      = document.getElementById('settings-save');
  const billingSection = document.getElementById('billing');
  const billingBalance = document.getElementById('billing-balance');
  const billingPacks   = document.getElementById('billing-packs');
  const billingStatus  = document.getElementById('billing-status');
  const billingChart   = document.getElementById('billing-chart');
  const billingChartSvg = document.getElementById('billing-chart-svg');
  const billingChartMeta = document.getElementById('billing-chart-meta');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let defaultModel = '';
  let hasApiKey = false;
  let tokenBalance = 0;
  let billingEnabled = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBillingStatus(text, kind) {
    if (!billingStatus) return;
    billingStatus.textContent = text || '';
    billingStatus.className = 'billing-status' + (kind ? ' ' + kind : '');
  }

  function renderApiKeyStatus() {
    if (hasApiKey) {
      apiKeyState.dataset.state = 'stored';
      apiKeyBadge.textContent = '✓ Personal key stored';
      apiKeyRemove.hidden = false;
      apiKeyInput.placeholder = 'Enter a new key to replace the stored one';
      apiKeyHint.textContent = 'Stored encrypted at rest. Leave blank to keep the current key, or use Remove to delete it.';
    } else {
      apiKeyState.dataset.state = 'empty';
      apiKeyBadge.textContent = 'No personal key — using server key';
      apiKeyRemove.hidden = true;
      apiKeyInput.placeholder = 'sk-ant-…';
      apiKeyHint.textContent = 'Stored encrypted at rest. Required before you can pick a non-default model (or buy tokens below).';
    }
  }

  function modelUnlocked() {
    return hasApiKey || tokenBalance > 0;
  }

  function renderModelHint() {
    if (!modelUnlocked()) {
      modelHint.textContent = billingEnabled
        ? 'Add a personal API key below or buy tokens to choose a different model.'
        : 'Add a personal API key below to choose a different model.';
      return;
    }
    if (!hasApiKey && tokenBalance > 0 && modelSelect.value !== defaultModel) {
      modelHint.textContent = 'Powered by your prepaid token balance. When it hits zero, requests revert to the free model.';
    } else {
      modelHint.textContent = '';
    }
  }

  function renderModelEnabled() {
    modelSelect.disabled = !modelUnlocked();
  }

  function renderBilling(billing) {
    if (!billingSection) return;
    if (!billingEnabled) {
      billingSection.hidden = true;
      return;
    }
    billingSection.hidden = false;
    billingBalance.textContent = 'Balance: ' + tokenBalance.toLocaleString() + ' tokens';

    billingPacks.innerHTML = '';
    const catalog = billing?.catalog;
    if (!catalog || !catalog.packs?.length) {
      const empty = document.createElement('div');
      empty.className = 'settings-hint';
      empty.textContent = 'No token packs configured. Ask the operator to set up data/catalog.json.';
      billingPacks.appendChild(empty);
      return;
    }
    catalog.packs.forEach(p => {
      const card = document.createElement('div');
      card.className = 'billing-pack';
      const price = (p.priceCents / 100).toLocaleString(undefined, {
        style: 'currency', currency: catalog.currency.toUpperCase(),
      });
      card.innerHTML =
        '<div class="billing-pack-label"></div>' +
        '<div class="billing-pack-description"></div>' +
        '<div class="billing-pack-price"></div>';
      card.querySelector('.billing-pack-label').textContent = p.tokens.toLocaleString() + ' tokens';
      card.querySelector('.billing-pack-description').textContent = p.description;
      card.querySelector('.billing-pack-price').textContent = price;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = 'Buy';
      btn.addEventListener('click', () => {
        Analytics.track('buy_tokens', {
          surface: 'settings',
          pack_id: p.id,
          tokens: p.tokens,
          price_cents: p.priceCents,
          currency: catalog.currency,
        });
        buyPack(p.id, btn);
      });
      card.appendChild(btn);
      billingPacks.appendChild(card);
    });
  }

  async function buyPack(packId, btn) {
    btn.disabled = true;
    setBillingStatus('Redirecting to checkout…');
    try {
      const r = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ packId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setBillingStatus(err.error || 'Checkout failed', 'error');
        btn.disabled = false;
        return;
      }
      const { url } = await r.json();
      window.location.href = url;
    } catch (err) {
      setBillingStatus(err.message || 'Checkout failed', 'error');
      btn.disabled = false;
    }
  }

  // Chart visibility: only show when the user has either a personal API
  // key or a positive prepaid balance. For BYOK users the ledger has no
  // debit rows (their calls are billed by Anthropic directly), so the
  // chart will read as zeros — that's still useful confirmation.
  function renderUsageChart(usage) {
    if (!billingChart || !billingChartSvg) return;
    if (!billingEnabled || !(hasApiKey || tokenBalance > 0)) {
      billingChart.hidden = true;
      return;
    }
    billingChart.hidden = false;

    while (billingChartSvg.firstChild) billingChartSvg.removeChild(billingChartSvg.firstChild);
    const points = usage || [];
    const total = points.reduce((s, d) => s + d.tokens, 0);
    const max = Math.max(1, ...points.map(d => d.tokens));
    const W = 600, H = 100, gap = 1;
    const barW = points.length ? W / points.length : 0;

    points.forEach((d, i) => {
      const h = (d.tokens / max) * H;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(i * barW + gap / 2));
      rect.setAttribute('y', String(H - h));
      rect.setAttribute('width', String(Math.max(0, barW - gap)));
      rect.setAttribute('height', String(h));
      rect.setAttribute('fill', d.tokens > 0 ? '#1a7a43' : '#e0e0de');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = d.date + ': ' + d.tokens.toLocaleString() + ' tokens';
      rect.appendChild(title);
      billingChartSvg.appendChild(rect);
    });

    if (total === 0) {
      billingChartMeta.textContent = hasApiKey && tokenBalance === 0
        ? 'No usage recorded — calls with your personal API key are billed by Anthropic directly.'
        : 'No usage in the last 30 days yet.';
    } else {
      billingChartMeta.textContent =
        total.toLocaleString() + ' tokens used · ' +
        points[0].date + ' → ' + points[points.length - 1].date;
    }
  }

  async function loadBilling() {
    if (!billingEnabled) return;
    const [statusRes, usageRes, txRes] = await Promise.all([
      fetch('/api/billing/status', { credentials: 'same-origin' }),
      fetch('/api/billing/usage', { credentials: 'same-origin' }),
      fetch('/api/billing/transactions?limit=50', { credentials: 'same-origin' }),
    ]);
    if (!statusRes.ok) {
      renderBilling(null);
      renderUsageChart([]);
      renderTransactions([]);
      return;
    }
    const data = await statusRes.json();
    renderBilling(data);
    const usage = usageRes.ok ? (await usageRes.json()).usage : [];
    renderUsageChart(usage);
    const transactions = txRes.ok ? (await txRes.json()).transactions : [];
    renderTransactions(transactions);
  }

  // Transactions table: shown only when the user has a non-empty ledger
  // (which under current rules means they've purchased at least once,
  // since debits can't happen without a prior credit). Server caps the
  // list at 50 — the .xlsx download covers everything.
  function humanizeReason(reason) {
    if (!reason) return '';
    if (reason.startsWith('stripe:')) {
      const pack = reason.slice('stripe:'.length);
      return pack && pack !== 'pack' ? 'Token purchase (' + pack + ')' : 'Token purchase';
    }
    if (reason === 'transform') return 'Transform request';
    if (reason === 'merge') return 'Merge request';
    return reason;
  }

  function renderTransactions(transactions) {
    const section = document.getElementById('billing-transactions');
    if (!section) return;
    if (!transactions || !transactions.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const tbody = section.querySelector('tbody');
    tbody.innerHTML = '';
    for (const t of transactions) {
      const tr = document.createElement('tr');
      const dateEl = document.createElement('td');
      dateEl.textContent = new Date(t.createdAt).toLocaleString();
      const descEl = document.createElement('td');
      descEl.textContent = humanizeReason(t.reason);
      const amtEl = document.createElement('td');
      amtEl.className = 'num ' + (t.delta >= 0 ? 'credit' : 'debit');
      const sign = t.delta >= 0 ? '+' : '−';
      amtEl.textContent = sign + Math.abs(t.delta).toLocaleString();
      tr.appendChild(dateEl);
      tr.appendChild(descEl);
      tr.appendChild(amtEl);
      tbody.appendChild(tr);
    }
    const meta = document.getElementById('billing-transactions-meta');
    if (meta) {
      meta.textContent = transactions.length >= 50
        ? 'Showing the 50 most recent. Download to see the full history.'
        : `Showing ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}.`;
    }
  }

  async function load() {
    const r = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!r.ok) {
      setStatus('Failed to load settings', 'error');
      return;
    }
    const data = await r.json();
    defaultModel = data.defaultModel;
    hasApiKey = data.hasApiKey;
    tokenBalance = data.tokenBalance || 0;
    billingEnabled = !!data.billingEnabled;

    modelSelect.innerHTML = '';
    data.availableModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    });
    // No saved preference (or legacy null) → show the free default selected,
    // since that's what the runtime is actually using.
    modelSelect.value = data.model || defaultModel;
    renderModelEnabled();
    renderModelHint();
    renderApiKeyStatus();

    await loadBilling();

    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      setBillingStatus('Payment received — your tokens will appear in a moment.', 'success');
      // Strip the query so a refresh doesn't re-open the upgrade dialog.
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
      // Offer the user the more-capable models their tokens just unlocked.
      const upgrades = (data.availableModels || [])
        .filter(m => m.id !== defaultModel)
        .slice(0, 2);
      if (upgrades.length) showUpgradeDialog(upgrades);
    } else if (params.get('checkout') === 'cancel') {
      setBillingStatus('Checkout cancelled.', 'error');
    }
  }

  // Post-purchase upsell: invite the user to switch from the free default
  // model to one of the more capable ones their new token balance unlocks.
  // The "no thank you" branch leaves the saved model untouched.
  function showUpgradeDialog(models) {
    const overlay = document.createElement('div');
    overlay.className = 'cf-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'cf-dialog';
    dialog.style.width = 'min(440px, 100%)';

    const title = document.createElement('div');
    title.className = 'cf-title';
    title.textContent = 'Tokens added — pick a more capable model?';
    dialog.appendChild(title);

    const blurb = document.createElement('div');
    blurb.className = 'cf-blurb';
    blurb.textContent =
      'Your tokens unlock the models below. Pick one to switch right now, or stick with the free default and change it later from this page.';
    dialog.appendChild(blurb);

    const actions = document.createElement('div');
    actions.className = 'cf-actions';
    actions.style.flexWrap = 'wrap';

    async function pick(modelId, btn) {
      btn.disabled = true;
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ model: modelId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        setStatus(err.error || 'Failed to switch model', 'error');
        btn.disabled = false;
        return;
      }
      const updated = await r.json();
      hasApiKey = updated.hasApiKey;
      modelSelect.value = modelId;
      renderModelEnabled();
      renderModelHint();
      renderApiKeyStatus();
      setStatus('Model switched to ' + modelId, 'success');
      overlay.remove();
    }

    models.forEach(m => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = 'Use ' + m.label;
      btn.addEventListener('click', () => pick(m.id, btn));
      actions.appendChild(btn);
    });

    const spacer = document.createElement('div');
    spacer.className = 'cf-spacer';
    actions.appendChild(spacer);

    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.textContent = "No thank you, I'll use the free model for now";
    declineBtn.addEventListener('click', () => overlay.remove());
    actions.appendChild(declineBtn);

    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  modelSelect.addEventListener('change', renderModelHint);

  apiKeyRemove.addEventListener('click', async () => {
    if (!confirm('Remove the stored API key? Future requests will use the server key and your model selection will reset to the default.')) return;
    apiKeyRemove.disabled = true;
    setStatus('Removing…');
    const r = await fetch('/api/settings/api-key', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    apiKeyRemove.disabled = false;
    if (!r.ok) {
      setStatus('Failed to remove key', 'error');
      return;
    }
    hasApiKey = false;
    // Removing the key also resets the model override server-side.
    modelSelect.value = '';
    renderModelEnabled();
    renderModelHint();
    renderApiKeyStatus();
    setStatus('API key removed', 'success');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    setStatus('Saving…');
    const body = { model: modelSelect.value };
    const newKey = apiKeyInput.value.trim();
    if (newKey) body.apiKey = newKey;

    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    saveBtn.disabled = false;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setStatus(err.error || 'Failed to save', 'error');
      return;
    }
    const data = await r.json();
    hasApiKey = data.hasApiKey;
    apiKeyInput.value = '';
    renderModelEnabled();
    renderModelHint();
    renderApiKeyStatus();
    setStatus('Saved', 'success');
  });

  load();
})();
