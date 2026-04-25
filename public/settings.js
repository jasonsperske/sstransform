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
      const tail = billingEnabled
        ? 'Add a personal API key below or buy tokens to choose a different model.'
        : 'Add a personal API key below to choose a different model.';
      modelHint.textContent = tail + ' Without one, all requests use the server default (' + defaultModel + ').';
      return;
    }
    if (!modelSelect.value) {
      modelHint.textContent = 'Currently using the server default (' + defaultModel + ').';
    } else if (!hasApiKey && tokenBalance > 0) {
      modelHint.textContent = 'Powered by your prepaid token balance. When it hits zero, requests revert to ' + defaultModel + '.';
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
      btn.addEventListener('click', () => buyPack(p.id, btn));
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
    const [statusRes, usageRes] = await Promise.all([
      fetch('/api/billing/status', { credentials: 'same-origin' }),
      fetch('/api/billing/usage', { credentials: 'same-origin' }),
    ]);
    if (!statusRes.ok) {
      renderBilling(null);
      renderUsageChart([]);
      return;
    }
    const data = await statusRes.json();
    renderBilling(data);
    const usage = usageRes.ok ? (await usageRes.json()).usage : [];
    renderUsageChart(usage);
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
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Use server default (' + defaultModel + ')';
    modelSelect.appendChild(defaultOpt);
    data.availableModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    });
    modelSelect.value = data.model || '';
    renderModelEnabled();
    renderModelHint();
    renderApiKeyStatus();

    await loadBilling();

    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      setBillingStatus('Payment received — your tokens will appear in a moment.', 'success');
    } else if (params.get('checkout') === 'cancel') {
      setBillingStatus('Checkout cancelled.', 'error');
    }
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
