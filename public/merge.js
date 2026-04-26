// State
const state = {
  left: null,
  right: null,
  priority: 'left',
  matchCode: '',
  matchNotes: '',
  matchColumns: [], // [{ left, right, strategy }]
  columns: [],      // [{ name, code, notes }]
  output: null,
};

// Project
let project = null;

// DOM helpers
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'onClick') e.addEventListener('click', v);
    else if (k === 'onInput') e.addEventListener('input', v);
    else if (k === 'hidden') e.hidden = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
};

// XLSX parsing
function parseWorkbook(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const sheets = {};
        for (const name of wb.SheetNames) {
          const ws = wb.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
          const headers = (rows[0] || []).map(h => String(h ?? '').trim());
          const data = rows.slice(1).map(row => {
            const o = {};
            headers.forEach((h, i) => { o[h] = row[i] ?? ''; });
            return o;
          });
          sheets[name] = { headers, rows: data };
        }
        resolve({ sheets, sheetNames: wb.SheetNames });
      } catch (err) { reject(err); }
    };
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function renderGrid(container, headers, rows, maxRows = 50, cellClass = null) {
  container.innerHTML = '';
  if (!headers || !headers.length) return;
  const table = el('table', { className: 'grid' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', { className: 'row-num' }, ''));
  headers.forEach(h => headRow.appendChild(el('th', {}, h || '(blank)')));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  rows.slice(0, maxRows).forEach((row, i) => {
    const tr = el('tr');
    tr.appendChild(el('td', { className: 'row-num' }, String(i + 1)));
    headers.forEach(h => {
      const v = row[h];
      const td = el('td', {}, v === '' || v == null ? '' : String(v));
      if (v === '' || v == null) td.classList.add('blank');
      if (cellClass) {
        const extra = cellClass(h, row);
        if (extra) td.classList.add(extra);
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function setSheetOptions(selectEl, names, activeName) {
  selectEl.innerHTML = '';
  names.forEach(n => {
    const o = el('option', { value: n }, n);
    if (n === activeName) o.selected = true;
    selectEl.appendChild(o);
  });
  selectEl.hidden = names.length <= 1;
}

function compile(code, argNames = ['row']) {
  if (!code || !code.trim()) return { ok: false, error: 'empty' };
  try {
    const fn = new Function(...argNames, code);
    return { ok: true, fn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Project =====

async function initProject() {
  const id = window.__PROJECT_ID__;
  const now = Date.now();
  const blank = (pid) => ({
    id: pid, type: 'merge', name: '',
    createdAt: now, updatedAt: now,
    leftHeaders: [], rightHeaders: [],
    priority: 'left', matchCode: '', matchNotes: '', matchColumns: [], columns: [],
  });
  if (id) {
    project = (await Projects.get(id)) || blank(id);
  } else {
    project = blank(Projects.randomId());
    window.history.replaceState(null, '', `/merge/${encodeURIComponent(project.id)}`);
  }
}

function hydrateFromProject() {
  if (!project) return;
  $('project-name').value = project.name || '';

  state.priority = project.priority || 'left';
  const radio = document.querySelector(`input[name="priority"][value="${state.priority}"]`);
  if (radio) radio.checked = true;

  state.matchCode = project.matchCode || '';
  state.matchNotes = project.matchNotes || '';
  state.matchColumns = (project.matchColumns || []).map(m => ({ ...m }));
  state.columns = (project.columns || []).map(c => ({ ...c }));

  if (state.matchCode || state.columns.length) {
    renderMatchAndColumns();
  }

  updateProjectMeta();
  updateProposeEnabled();
}

let savesInFlight = 0;
let lastSaveError = null;

function updateProjectMeta() {
  const meta = $('project-meta');
  if (!meta || !project) return;
  const bits = [`id ${project.id.slice(0, 8)}`];
  if (savesInFlight > 0) bits.push('saving…');
  else if (lastSaveError) bits.push('save failed');
  else if (project.updatedAt) bits.push(`saved ${new Date(project.updatedAt).toLocaleTimeString()}`);
  meta.textContent = bits.join(' · ');
  meta.classList.toggle('save-error', !!lastSaveError && savesInFlight === 0);
}

function saveCurrent() {
  if (!project) return;
  project.name = $('project-name').value.trim();
  if (state.left) project.leftHeaders = state.left.sheets[state.left.activeSheet].headers.slice();
  if (state.right) project.rightHeaders = state.right.sheets[state.right.activeSheet].headers.slice();
  project.priority = state.priority;
  project.matchCode = state.matchCode;
  project.matchNotes = state.matchNotes;
  project.matchColumns = state.matchColumns.map(m => ({
    left: m.left || '',
    right: m.right || '',
    strategy: m.strategy || '',
  }));
  project.columns = state.columns.map(c => ({
    name: c.name,
    code: c.code || '',
    notes: c.notes || '',
  }));
  savesInFlight++;
  lastSaveError = null;
  updateProjectMeta();
  Projects.upsert(project)
    .catch(e => { lastSaveError = e; console.warn('project save failed', e); })
    .finally(() => { savesInFlight--; updateProjectMeta(); });
}

// ===== File loading =====

async function loadFile(fileInput, kind) {
  const file = fileInput.files[0];
  if (!file) return;
  const infoEl = $(`${kind}-info`);
  infoEl.textContent = `parsing ${file.name}…`;
  try {
    const parsed = await parseWorkbook(file);
    const activeSheet = parsed.sheetNames[0];
    state[kind] = { sheets: parsed.sheets, sheetNames: parsed.sheetNames, activeSheet, fileName: file.name };
    setSheetOptions($(`${kind}-sheet`), parsed.sheetNames, activeSheet);
    renderActiveSheet(kind);
  } catch (err) {
    infoEl.textContent = `error: ${err.message}`;
  }
  updateProposeEnabled();
  saveCurrent();
  schedulePreview();
}

function renderActiveSheet(kind) {
  const s = state[kind];
  if (!s) return;
  const sheet = s.sheets[s.activeSheet];
  $(`${kind}-info`).textContent =
    `${s.fileName} · ${s.activeSheet} · ${sheet.headers.length} columns · ${sheet.rows.length} data rows`;
  renderGrid($(`${kind}-grid`), sheet.headers, sheet.rows);
}

function updateProposeEnabled() {
  const ok = state.left && state.right
    && state.left.sheets[state.left.activeSheet].headers.length
    && state.right.sheets[state.right.activeSheet].headers.length;
  $('propose-btn').disabled = !ok;
}

// ===== Match & columns rendering =====

let matchWired = false;
function renderMatchAndColumns() {
  $('match-editor').hidden = false;

  // Join section — structured matchColumns + notes + code
  const disp = $('match-columns-display');
  disp.innerHTML = '';
  (state.matchColumns || []).forEach(mc => {
    const row = el('div', { className: 'match-col-row' }, [
      el('span', { className: 'match-col-side' }, mc.left || '—'),
      el('span', { className: 'match-col-arrow' }, '↔'),
      el('span', { className: 'match-col-side' }, mc.right || '—'),
      mc.strategy ? el('span', { className: 'match-col-strategy' }, mc.strategy) : null,
    ]);
    disp.appendChild(row);
  });
  $('match-notes').textContent = state.matchNotes || '';

  const matchArea = $('match-code');
  matchArea.value = state.matchCode;
  if (!matchWired) {
    matchArea.addEventListener('input', () => {
      state.matchCode = matchArea.value;
      schedulePreview();
    });
    matchArea.addEventListener('blur', saveCurrent);
    matchWired = true;
  }

  // Per-column editors with refine input
  const list = $('columns-list');
  list.innerHTML = '';
  state.columns.forEach((col, idx) => {
    const title = el('div', { className: 'xform-title' }, col.name);
    if (!col.code || !col.code.trim()) {
      title.appendChild(el('span', { className: 'empty-hint' }, '(no code)'));
    }
    const notes = el('div', { className: 'xform-notes' }, col.notes || '');

    const codeArea = el('textarea', { className: 'code', spellcheck: 'false' });
    codeArea.value = col.code || '';
    codeArea.addEventListener('input', () => {
      state.columns[idx].code = codeArea.value;
      schedulePreview();
    });
    codeArea.addEventListener('blur', saveCurrent);

    const refineArea = el('textarea', {
      placeholder: `refinement for "${col.name}" (e.g. 'uppercase', 'prefer right side', 'format as E.164')`,
    });
    const refineBtn = el('button', {
      onClick: async () => {
        const comment = refineArea.value.trim();
        if (!comment) return;
        refineBtn.disabled = true;
        refineBtn.textContent = 'refining…';
        try {
          await requestMerge({
            refinementComment: comment,
            refineColumn: col.name,
            trackEvent: { name: 'refine_column', params: { surface: 'merge', column: col.name } },
          });
          refineArea.value = '';
        } catch (e) {
          alert('refine failed: ' + e.message);
        } finally {
          refineBtn.disabled = false;
          refineBtn.textContent = 'Refine';
        }
      },
    }, 'Refine');

    const body = el('div', { className: 'xform-body' }, [
      codeArea,
      el('div', { className: 'xform-refine' }, [refineArea, refineBtn]),
    ]);
    const row = el('div', { className: 'xform' }, [el('div', {}, [title, notes]), body]);
    list.appendChild(row);
  });

  $('refine-all').hidden = state.columns.length === 0 && !state.matchCode;
  $('merge-btn').disabled = state.columns.length === 0 || !state.matchCode;
}

// ===== Preview =====

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
}

function leftSample() {
  if (!state.left) return [];
  const n = parseInt($('sample-size').value, 10) || 10;
  return state.left.sheets[state.left.activeSheet].rows.slice(0, n);
}
function rightSample() {
  if (!state.right) return [];
  const n = parseInt($('sample-size').value, 10) || 10;
  return state.right.sheets[state.right.activeSheet].rows.slice(0, n);
}

function runMerge(leftRows, rightRows) {
  const matchC = compile(state.matchCode, ['leftRow', 'rightRow']);
  const columnC = state.columns.map(c => ({
    name: c.name,
    compiled: compile(c.code, ['left', 'right', 'priority']),
  }));
  const errorCells = new Set();

  const buildRow = (l, r, rowIdx) => {
    const o = {};
    for (const { name, compiled: c } of columnC) {
      if (!c.ok) { o[name] = ''; continue; }
      try {
        const v = c.fn(l, r, state.priority);
        o[name] = v == null ? '' : v;
      } catch (e) {
        o[name] = `⚠ ${e.message}`;
        errorCells.add(`${rowIdx}|${name}`);
      }
    }
    return o;
  };

  const doMatch = (l, r) => {
    if (!matchC.ok) return false;
    try { return !!matchC.fn(l, r); } catch { return false; }
  };

  // Prioritize the priority-side rows first in output order.
  const primaryIsLeft = state.priority !== 'right';
  const primary = primaryIsLeft ? leftRows : rightRows;
  const secondary = primaryIsLeft ? rightRows : leftRows;

  const matched = new Set();
  const merged = [];

  primary.forEach((pRow) => {
    let foundIdx = -1;
    for (let i = 0; i < secondary.length; i++) {
      if (matched.has(i)) continue;
      const ok = primaryIsLeft ? doMatch(pRow, secondary[i]) : doMatch(secondary[i], pRow);
      if (ok) { foundIdx = i; break; }
    }
    if (foundIdx >= 0) matched.add(foundIdx);
    const leftR = primaryIsLeft ? pRow : (foundIdx >= 0 ? secondary[foundIdx] : null);
    const rightR = primaryIsLeft ? (foundIdx >= 0 ? secondary[foundIdx] : null) : pRow;
    merged.push(buildRow(leftR, rightR, merged.length));
  });

  secondary.forEach((sRow, i) => {
    if (matched.has(i)) return;
    const leftR = primaryIsLeft ? null : sRow;
    const rightR = primaryIsLeft ? sRow : null;
    merged.push(buildRow(leftR, rightR, merged.length));
  });

  return { merged, errorCells };
}

function renderPreview() {
  const container = $('preview-grid');
  const info = $('preview-info');
  if (!state.columns.length || !state.matchCode || !state.left || !state.right) {
    container.innerHTML = '';
    info.textContent = '';
    return;
  }
  const { merged, errorCells } = runMerge(leftSample(), rightSample());
  const headers = state.columns.map(c => c.name);
  const rowIdx = new Map(merged.map((r, i) => [r, i]));
  renderGrid(container, headers, merged, 100, (col, row) => {
    return errorCells.has(`${rowIdx.get(row)}|${col}`) ? 'cell-err' : null;
  });
  const bits = [`${merged.length} merged rows × ${headers.length} cols`];
  if (errorCells.size) bits.push(`${errorCells.size} cell errors`);
  info.textContent = bits.join(' · ');
  info.className = 'status' + (errorCells.size ? ' error' : '');
}

// ===== API =====

async function requestMerge({ refinementComment, suggestName, refineColumn, refineMatch, trackEvent } = {}) {
  const body = {
    leftHeaders: state.left.sheets[state.left.activeSheet].headers,
    rightHeaders: state.right.sheets[state.right.activeSheet].headers,
    leftSample: leftSample(),
    rightSample: rightSample(),
    priority: state.priority,
  };
  if (state.matchCode) body.existingMatchCode = state.matchCode;
  if (state.matchColumns && state.matchColumns.length) body.existingMatchColumns = state.matchColumns;
  if (state.columns.length) body.existingColumns = state.columns;
  if (refinementComment) body.refinementComment = refinementComment;
  if (refineColumn) body.refineColumn = refineColumn;
  if (refineMatch) body.refineMatch = true;
  if (suggestName) body.suggestName = true;

  const statusEl = $('propose-status');
  statusEl.textContent = 'asking Claude…';
  statusEl.className = 'status';

  const res = await fetch('/api/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    statusEl.textContent = `error: ${err.error}`;
    statusEl.className = 'status error';
    throw new Error(err.error);
  }
  const data = await res.json();
  if (trackEvent) {
    Analytics.track(trackEvent.name, { ...trackEvent.params, model: data.model });
  }
  if (data.tokensExhausted && window.BillingNotice) {
    BillingNotice.showExhausted(data.tokensExhausted);
  }

  if (refineColumn) {
    const byName = new Map((data.columns || []).map(c => [c.name, c]));
    state.columns = state.columns.map(c => {
      const updated = byName.get(c.name);
      return updated ? { name: updated.name, code: updated.code || '', notes: updated.notes || '' } : c;
    });
  } else if (refineMatch) {
    state.matchCode = data.matchCode || '';
    state.matchNotes = data.matchNotes || '';
    state.matchColumns = (data.matchColumns || []).map(m => ({ ...m }));
  } else {
    state.matchCode = data.matchCode || '';
    state.matchNotes = data.matchNotes || '';
    state.matchColumns = (data.matchColumns || []).map(m => ({ ...m }));
    state.columns = (data.columns || []).map(c => ({
      name: c.name,
      code: c.code || '',
      notes: c.notes || '',
    }));
  }

  if (data.suggestedName && !$('project-name').value.trim()) {
    $('project-name').value = data.suggestedName;
  }
  renderMatchAndColumns();
  schedulePreview();
  statusEl.textContent = refineColumn
    ? `column "${refineColumn}" refined`
    : refineMatch
      ? 'match refined'
      : `match + ${state.columns.length} columns ready`;
  statusEl.className = 'status success';
  saveCurrent();
}

// ===== Event wiring =====

(async () => {
  // Wait for any post-login orphan-merge prompt before fetching the
  // project — otherwise a deep link to a just-merged project id would
  // 404 against the user's account and load as blank.
  if (window.Auth) await window.Auth.ready;
  await initProject();
  hydrateFromProject();
})();

$('project-name').addEventListener('blur', saveCurrent);
$('left-file').addEventListener('change', (e) => loadFile(e.target, 'left'));
$('right-file').addEventListener('change', (e) => loadFile(e.target, 'right'));
$('left-sheet').addEventListener('change', (e) => {
  state.left.activeSheet = e.target.value;
  renderActiveSheet('left');
  schedulePreview();
});
$('right-sheet').addEventListener('change', (e) => {
  state.right.activeSheet = e.target.value;
  renderActiveSheet('right');
  schedulePreview();
});
$('sample-size').addEventListener('input', () => schedulePreview());

document.querySelectorAll('input[name="priority"]').forEach(r => {
  r.addEventListener('change', (e) => {
    state.priority = e.target.value;
    saveCurrent();
    schedulePreview();
  });
});

$('propose-btn').addEventListener('click', async () => {
  $('propose-btn').disabled = true;
  try {
    state.matchCode = '';
    state.matchColumns = [];
    state.columns = [];
    const suggestName = !$('project-name').value.trim();
    await requestMerge({
      suggestName,
      trackEvent: { name: 'button_click', params: { button: 'propose_merge', surface: 'merge' } },
    });
  } catch (e) { /* status shown */ }
  finally { $('propose-btn').disabled = false; }
});

$('match-refine-btn').addEventListener('click', async () => {
  const comment = $('match-refine-comment').value.trim();
  if (!comment) return;
  const btn = $('match-refine-btn');
  btn.disabled = true;
  btn.textContent = 'refining…';
  try {
    await requestMerge({
      refinementComment: comment,
      refineMatch: true,
      trackEvent: { name: 'refine_match', params: { surface: 'merge' } },
    });
    $('match-refine-comment').value = '';
  } catch (e) { /* status shown */ }
  finally {
    btn.disabled = false;
    btn.textContent = 'Refine match';
  }
});

$('refine-all-btn').addEventListener('click', async () => {
  const comment = $('refine-all-comment').value.trim();
  if (!comment) return;
  $('refine-all-btn').disabled = true;
  $('refine-all-btn').textContent = 'refining…';
  try {
    await requestMerge({
      refinementComment: comment,
      trackEvent: { name: 'refine_all', params: { surface: 'merge' } },
    });
    $('refine-all-comment').value = '';
  } catch (e) { /* status shown */ }
  finally {
    $('refine-all-btn').disabled = false;
    $('refine-all-btn').textContent = 'Refine';
  }
});

$('merge-btn').addEventListener('click', () => {
  Analytics.track('button_click', { button: 'run_merge', surface: 'merge' });
  const leftRows = state.left.sheets[state.left.activeSheet].rows;
  const rightRows = state.right.sheets[state.right.activeSheet].rows;
  const { merged, errorCells } = runMerge(leftRows, rightRows);
  state.output = merged;
  const headers = state.columns.map(c => c.name);
  renderGrid($('output-grid'), headers, merged);
  $('download-btn').disabled = false;
  const statusEl = $('output-status');
  statusEl.textContent = `merged ${merged.length} rows` + (errorCells.size ? ` (${errorCells.size} cell errors)` : '');
  statusEl.className = 'status' + (errorCells.size ? '' : ' success');
});

$('download-btn').addEventListener('click', () => {
  if (!state.output) return;
  Analytics.track('button_click', { button: 'download_output', surface: 'merge' });
  const headers = state.columns.map(c => c.name);
  const aoa = [headers, ...state.output.map(r => headers.map(h => r[h] ?? ''))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Merged');
  const leftName = (state.left.fileName || 'merged').replace(/\.xlsx?$/i, '');
  XLSX.writeFile(wb, `${leftName}-merged.xlsx`);
});
