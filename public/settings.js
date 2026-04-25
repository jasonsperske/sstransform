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

  let defaultModel = '';
  let hasApiKey = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
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
      apiKeyHint.textContent = 'Stored encrypted at rest. Required before you can pick a non-default model.';
    }
  }

  function renderModelHint() {
    if (!hasApiKey) {
      modelHint.textContent = 'Add a personal API key below to choose a different model. Without one, all requests use the server default (' + defaultModel + ').';
      return;
    }
    if (!modelSelect.value) {
      modelHint.textContent = 'Currently using the server default (' + defaultModel + ').';
    } else {
      modelHint.textContent = '';
    }
  }

  function renderModelEnabled() {
    modelSelect.disabled = !hasApiKey;
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
