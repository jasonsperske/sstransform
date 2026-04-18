// State
const state = {
  source: null,        // { sheets: {name: {headers, rows}}, activeSheet, file }
  target: null,        // { sheets: {name: {headers, rows}}, activeSheet, file }
  transformations: [], // [{ targetColumn, code, notes }]
  output: null,        // [{col: val, ...}, ...]
};

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

// Grid rendering. cellClass(header, row) → string | null for extra per-cell styling.
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

// Workbook-side logic
function setSheetOptions(selectEl, names, activeName) {
  selectEl.innerHTML = '';
  names.forEach(n => {
    const o = el('option', { value: n }, n);
    if (n === activeName) o.selected = true;
    selectEl.appendChild(o);
  });
  selectEl.hidden = names.length <= 1;
}

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
}

function renderActiveSheet(kind) {
  const s = state[kind];
  if (!s) return;
  const sheet = s.sheets[s.activeSheet];
  const showRows = kind === 'source' ? sheet.rows : sheet.rows.slice(0, 1);
  $(`${kind}-info`).textContent =
    `${s.fileName} · ${s.activeSheet} · ${sheet.headers.length} columns · ${sheet.rows.length} data rows`;
  renderGrid($(`${kind}-grid`), sheet.headers, showRows);
}

function updateProposeEnabled() {
  const ok = state.source && state.target
    && state.source.sheets[state.source.activeSheet].headers.length
    && state.target.sheets[state.target.activeSheet].headers.length;
  $('propose-btn').disabled = !ok;
}

// Transformation execution
function compile(code) {
  if (!code || !code.trim()) return { ok: false, error: 'empty' };
  try {
    const fn = new Function('row', code);
    return { ok: true, fn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function runOne(code, row) {
  const c = compile(code);
  if (!c.ok) return { ok: false, error: c.error };
  try {
    const v = c.fn(row);
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Transformation rendering
function renderTransformations() {
  const container = $('transformations');
  container.innerHTML = '';
  const sampleRow = sourceSample()[0];
  state.transformations.forEach((t, idx) => {
    const title = el('div', { className: 'xform-title' }, t.targetColumn);
    if (!t.code || !t.code.trim()) {
      title.appendChild(el('span', { className: 'empty-hint' }, '(no mapping)'));
    }
    const notes = el('div', { className: 'xform-notes' }, t.notes || '');

    const codeArea = el('textarea', { className: 'code', spellcheck: 'false' });
    codeArea.value = t.code || '';
    codeArea.addEventListener('input', () => {
      state.transformations[idx].code = codeArea.value;
      schedulePreview();
    });

    const preview = el('span', { className: 'preview' }, '—');
    const runBtn = el('button', {
      onClick: () => {
        if (!sampleRow) {
          preview.textContent = 'no sample row';
          preview.classList.add('err');
          return;
        }
        const r = runOne(codeArea.value, sampleRow);
        preview.classList.remove('err');
        if (r.ok) {
          preview.textContent = `→ ${formatPreview(r.value)}`;
        } else {
          preview.textContent = `error: ${r.error}`;
          preview.classList.add('err');
        }
      },
    }, 'Run on first sample');

    const refineArea = el('textarea', { placeholder: `refinement for "${t.targetColumn}" (e.g. 'uppercase', 'include area code')` });
    const refineBtn = el('button', {
      onClick: async () => {
        refineBtn.disabled = true;
        refineBtn.textContent = 'refining…';
        try {
          await requestTransformations({
            refinementComment: refineArea.value,
            targetColumn: t.targetColumn,
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
      el('div', { className: 'xform-actions' }, [runBtn, preview]),
      el('div', { className: 'xform-refine' }, [refineArea, refineBtn]),
    ]);

    const row = el('div', { className: 'xform' }, [
      el('div', {}, [title, notes]),
      body,
    ]);
    container.appendChild(row);
  });

  $('refine-all').hidden = state.transformations.length === 0;
  $('transform-btn').disabled = state.transformations.length === 0;
  renderPreview();
}

// Debounced preview so typing feels cheap
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
}

function renderPreview() {
  const container = $('preview-grid');
  const bar = $('preview-bar');
  const info = $('preview-info');
  if (!state.transformations.length || !state.source || !state.target) {
    container.innerHTML = '';
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const tgtHeaders = state.target.sheets[state.target.activeSheet].headers;
  const sample = sourceSample();
  const compiled = state.transformations.map(t => ({
    targetColumn: t.targetColumn,
    compiled: compile(t.code),
  }));
  const errorCells = new Set(); // `${rowIdx}|${col}`
  const rows = sample.map((srcRow, rowIdx) => {
    const o = {};
    for (const { targetColumn, compiled: c } of compiled) {
      if (!c.ok) { o[targetColumn] = ''; continue; }
      try {
        const v = c.fn(srcRow);
        o[targetColumn] = v == null ? '' : v;
      } catch (e) {
        o[targetColumn] = `⚠ ${e.message}`;
        errorCells.add(`${rowIdx}|${targetColumn}`);
      }
    }
    return o;
  });
  const rowIdxOf = new Map(rows.map((r, i) => [r, i]));
  renderGrid(container, tgtHeaders, rows, sample.length, (col, row) => {
    return errorCells.has(`${rowIdxOf.get(row)}|${col}`) ? 'cell-err' : null;
  });
  const errorCount = errorCells.size;
  const unmapped = state.transformations.filter(t => !t.code || !t.code.trim()).length;
  const bits = [`${sample.length} sample rows × ${tgtHeaders.length} cols`];
  if (unmapped) bits.push(`${unmapped} unmapped`);
  if (errorCount) bits.push(`${errorCount} cell errors`);
  info.textContent = bits.join(' · ');
  info.className = 'status' + (errorCount ? ' error' : '');
}

function formatPreview(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

// Sample data from source
function sourceSample() {
  if (!state.source) return [];
  const sheet = state.source.sheets[state.source.activeSheet];
  const n = parseInt($('sample-size').value, 10) || 10;
  return sheet.rows.slice(0, n);
}

// API call
async function requestTransformations({ refinementComment, targetColumn } = {}) {
  const srcSheet = state.source.sheets[state.source.activeSheet];
  const tgtSheet = state.target.sheets[state.target.activeSheet];
  const body = {
    sourceHeaders: srcSheet.headers,
    targetHeaders: tgtSheet.headers,
    sourceSample: sourceSample(),
  };
  if (state.transformations.length) body.existingTransformations = state.transformations;
  if (refinementComment) body.refinementComment = refinementComment;
  if (targetColumn) body.targetColumn = targetColumn;

  const statusEl = $('propose-status');
  statusEl.textContent = 'asking Claude…';
  statusEl.className = 'status';

  const res = await fetch('/api/transform', {
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
  // Align to target column order, preserve any previously-edited codes not returned.
  const byCol = new Map(data.transformations.map(t => [t.targetColumn, t]));
  state.transformations = tgtSheet.headers.map(h => {
    if (byCol.has(h)) return byCol.get(h);
    const prior = state.transformations.find(t => t.targetColumn === h);
    return prior || { targetColumn: h, code: '', notes: '' };
  });
  renderTransformations();
  statusEl.textContent = `${data.transformations.length} transformations ready`;
  statusEl.className = 'status success';
}

// Event wiring
$('source-file').addEventListener('change', (e) => loadFile(e.target, 'source'));
$('target-file').addEventListener('change', (e) => loadFile(e.target, 'target'));
$('source-sheet').addEventListener('change', (e) => {
  state.source.activeSheet = e.target.value;
  renderActiveSheet('source');
  schedulePreview();
});
$('target-sheet').addEventListener('change', (e) => {
  state.target.activeSheet = e.target.value;
  renderActiveSheet('target');
});
$('sample-size').addEventListener('input', () => schedulePreview());

$('propose-btn').addEventListener('click', async () => {
  $('propose-btn').disabled = true;
  try {
    state.transformations = []; // fresh proposal
    await requestTransformations();
  } catch (e) { /* status shown */ }
  finally { $('propose-btn').disabled = false; }
});

$('refine-all-btn').addEventListener('click', async () => {
  const comment = $('refine-all-comment').value.trim();
  if (!comment) return;
  $('refine-all-btn').disabled = true;
  $('refine-all-btn').textContent = 'refining…';
  try {
    await requestTransformations({ refinementComment: comment });
    $('refine-all-comment').value = '';
  } catch (e) { /* status shown */ }
  finally {
    $('refine-all-btn').disabled = false;
    $('refine-all-btn').textContent = 'Refine all';
  }
});

$('transform-btn').addEventListener('click', () => {
  const srcSheet = state.source.sheets[state.source.activeSheet];
  const tgtHeaders = state.target.sheets[state.target.activeSheet].headers;
  const compiled = state.transformations.map(t => ({
    targetColumn: t.targetColumn,
    compiled: compile(t.code),
  }));
  const out = [];
  let errors = 0;
  for (const row of srcSheet.rows) {
    const o = {};
    for (const { targetColumn, compiled: c } of compiled) {
      if (!c.ok) { o[targetColumn] = ''; continue; }
      try {
        const v = c.fn(row);
        o[targetColumn] = v == null ? '' : v;
      } catch { o[targetColumn] = ''; errors++; }
    }
    out.push(o);
  }
  state.output = out;
  renderGrid($('output-grid'), tgtHeaders, out);
  $('download-btn').disabled = false;
  const statusEl = $('output-status');
  statusEl.textContent = `transformed ${out.length} rows` + (errors ? ` (${errors} cell errors)` : '');
  statusEl.className = 'status' + (errors ? '' : ' success');
});

$('download-btn').addEventListener('click', () => {
  if (!state.output) return;
  const tgtHeaders = state.target.sheets[state.target.activeSheet].headers;
  const aoa = [tgtHeaders, ...state.output.map(r => tgtHeaders.map(h => r[h] ?? ''))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transformed');
  const srcName = state.source.fileName.replace(/\.xlsx?$/i, '');
  XLSX.writeFile(wb, `${srcName}-transformed.xlsx`);
});
