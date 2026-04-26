// State
const state = {
  source: null,        // { sheets: {name: {headers, rows}}, activeSheet, file }
  target: null,        // { sheets: {name: {headers, rows}}, activeSheet, file }
  transformations: [], // [{ targetColumn, code, notes }]
  output: null,        // [{col: val, ...}, ...]
};

// Project (server-stored via projects.js, keyed by URL id)
let project = null;

async function initProject() {
  const id = window.__PROJECT_ID__;
  const now = Date.now();
  const blank = (pid) => ({
    id: pid, type: 'transform', name: '',
    createdAt: now, updatedAt: now,
    sourceHeaders: [], targetHeaders: [], transformations: [],
  });
  if (id) {
    project = (await Projects.get(id)) || blank(id);
  } else {
    project = blank(Projects.randomId());
    window.history.replaceState(null, '', `/transform/${encodeURIComponent(project.id)}`);
  }
}

function hydrateFromProject() {
  if (!project) return;
  $('project-name').value = project.name || '';
  const savedHeaderRows = project.targetHeaderRowCount || 1;
  $('target-header-rows').value = savedHeaderRows;
  if (project.targetHeaders && project.targetHeaders.length) {
    state.target = {
      sheets: { saved: { headers: project.targetHeaders.slice(), headerRows: [project.targetHeaders.slice()], rows: [] } },
      sheetNames: ['saved'],
      activeSheet: 'saved',
      fileName: '(saved project)',
      headerRowCount: savedHeaderRows,
    };
    setSheetOptions($('target-sheet'), ['saved'], 'saved');
    renderActiveSheet('target');
    lockTarget(true);
  }
  if (project.transformations && project.transformations.length) {
    state.transformations = project.transformations.map(t => ({ ...t }));
    renderTransformations();
  }
  updateProjectMeta();
  updateProposeEnabled();
}

function lockTarget(locked) {
  const step = $('target-step');
  const fileBtn = $('target-file-btn');
  const editBtn = $('target-edit-btn');
  const note = $('target-locked-note');
  const headerRowsInput = $('target-header-rows');
  if (!step) return;
  step.classList.toggle('locked', locked);
  fileBtn.hidden = locked;
  editBtn.hidden = !locked;
  note.hidden = !locked;
  headerRowsInput.disabled = locked;
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
  if (state.source) {
    const sh = state.source.sheets[state.source.activeSheet];
    project.sourceHeaders = sh.headers.slice();
  }
  if (state.target) {
    const sh = state.target.sheets[state.target.activeSheet];
    project.targetHeaders = sh.headers.slice();
    project.targetHeaderRowCount = state.target.headerRowCount || 1;
  }
  project.transformations = state.transformations.map(t => ({
    targetColumn: t.targetColumn,
    code: t.code || '',
    notes: t.notes || '',
  }));
  savesInFlight++;
  lastSaveError = null;
  updateProjectMeta();
  Projects.upsert(project)
    .catch(e => { lastSaveError = e; console.warn('project save failed', e); })
    .finally(() => { savesInFlight--; updateProjectMeta(); });
}

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

// XLSX parsing. Returns the raw bytes alongside parsed sheets so the target
// workbook can be re-opened later with cellStyles:true for the styled output.
function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(new Uint8Array(e.target.result));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function colLabel(i) { return XLSX.utils.encode_col(i); }

// Excel often pads !ref out to row 1,048,576 even when only a few rows are
// populated. sheet_to_json honors !ref and would allocate ~1M empty rows
// (seconds of work). Rewrite !ref to the actual populated extent first.
function tightenRef(ws) {
  const cellAddr = /^[A-Z]+\d+$/;
  let maxR = -1, maxC = -1, minR = Infinity, minC = Infinity;
  for (const key of Object.keys(ws)) {
    if (!cellAddr.test(key)) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  if (maxR < 0) { ws['!ref'] = 'A1:A1'; return; }
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: Math.min(minR, 0), c: Math.min(minC, 0) },
    e: { r: maxR, c: maxC },
  });
}

// Belt-and-suspenders: even with !ref tightened, a data gap at the tail would
// leave trailing blanks. Cheap once the row count is bounded.
function trimTrailingBlankRows(rows) {
  let end = rows.length;
  while (end > 0) {
    const r = rows[end - 1];
    const empty = !r || r.every(v => v === '' || v == null);
    if (!empty) break;
    end--;
  }
  return end === rows.length ? rows : rows.slice(0, end);
}

// Flatten N header rows into a single label per column. Joins non-blank cells
// across rows with " / "; dedupes consecutive duplicates (so vertical merges
// that propagate an anchor downward don't produce "Foo / Foo"); falls back to
// the column letter when all blank.
function flattenHeaderRows(headerRows, colCount) {
  const headers = [];
  for (let c = 0; c < colCount; c++) {
    const parts = [];
    for (const hr of headerRows) {
      const v = hr[c];
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s) continue;
      if (parts[parts.length - 1] === s) continue;
      parts.push(s);
    }
    headers.push(parts.length ? parts.join(' / ') : colLabel(c));
  }
  return headers;
}

// Merges that overlap rows [0, n) get clipped to that window. Anchor values
// are propagated into every covered header cell so flattening produces e.g.
// "Electrical / Voltage" for both columns under a horizontal "Electrical"
// merge. Returns both the filled-in headerRows (new arrays, not mutated in
// place) and the clipped merge list for the preview to render colspans.
function resolveHeaderMerges(headerRows, merges, n) {
  const filled = headerRows.map(r => (r || []).slice());
  const clipped = [];
  if (!merges) return { headerRows: filled, merges: clipped };
  for (const m of merges) {
    if (m.s.r >= n) continue; // merge starts below the header region
    const endR = Math.min(m.e.r, n - 1);
    const anchor = (filled[m.s.r] && filled[m.s.r][m.s.c]);
    for (let r = m.s.r; r <= endR; r++) {
      if (!filled[r]) filled[r] = [];
      for (let c = m.s.c; c <= m.e.c; c++) filled[r][c] = anchor ?? '';
    }
    clipped.push({ s: { r: m.s.r, c: m.s.c }, e: { r: endR, c: m.e.c } });
  }
  return { headerRows: filled, merges: clipped };
}

function parseSource(bytes) {
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheets = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    tightenRef(ws);
    const rows = trimTrailingBlankRows(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
    const headers = (rows[0] || []).map(h => String(h ?? '').trim());
    const data = rows.slice(1).map(row => {
      const o = {};
      headers.forEach((h, i) => { o[h] = row[i] ?? ''; });
      return o;
    });
    sheets[name] = { headers, rows: data };
  }
  return { sheets, sheetNames: wb.SheetNames };
}

function parseTarget(bytes, headerRowCount) {
  const n = Math.max(1, headerRowCount | 0);
  const wb = XLSX.read(bytes, { type: 'array', cellStyles: true });
  const sheets = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    tightenRef(ws);
    const rows = trimTrailingBlankRows(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }));
    const rawHeaderRows = rows.slice(0, n);
    const { headerRows, merges: headerMerges } = resolveHeaderMerges(rawHeaderRows, ws['!merges'], n);
    const colCount = headerRows.reduce((m, r) => Math.max(m, r.length), 0);
    const headers = flattenHeaderRows(headerRows, colCount);
    const data = rows.slice(n).map(row => {
      const o = {};
      headers.forEach((h, i) => { o[h] = row[i] ?? ''; });
      return o;
    });
    sheets[name] = { headers, headerRows, headerMerges, rows: data };
  }
  return { sheets, sheetNames: wb.SheetNames };
}

function alignTransformationsToHeaders(newHeaders) {
  const byCol = new Map(state.transformations.map(t => [t.targetColumn, t]));
  state.transformations = newHeaders.map(h => byCol.get(h) || { targetColumn: h, code: '', notes: '' });
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
    const bytes = await readFileBytes(file);
    let parsed;
    if (kind === 'target') {
      const headerRowCount = Math.max(1, parseInt($('target-header-rows').value, 10) || 1);
      parsed = parseTarget(bytes, headerRowCount);
      state.target = {
        sheets: parsed.sheets,
        sheetNames: parsed.sheetNames,
        activeSheet: parsed.sheetNames[0],
        fileName: file.name,
        bytes,
        headerRowCount,
      };
      const activeHeaders = state.target.sheets[state.target.activeSheet].headers;
      alignTransformationsToHeaders(activeHeaders);
    } else {
      parsed = parseSource(bytes);
      state.source = {
        sheets: parsed.sheets,
        sheetNames: parsed.sheetNames,
        activeSheet: parsed.sheetNames[0],
        fileName: file.name,
      };
    }
    setSheetOptions($(`${kind}-sheet`), parsed.sheetNames, state[kind].activeSheet);
    renderActiveSheet(kind);
    if (kind === 'target') renderTransformations();
  } catch (err) {
    infoEl.textContent = `error: ${err.message}`;
  }
  updateProposeEnabled();
  saveCurrent();
  schedulePreview();
}

// Re-parse the in-memory target workbook when header-rows count changes.
function reparseTarget() {
  if (!state.target || !state.target.bytes) return;
  const headerRowCount = Math.max(1, parseInt($('target-header-rows').value, 10) || 1);
  if (state.target.headerRowCount === headerRowCount) return;
  const activeSheet = state.target.activeSheet;
  const parsed = parseTarget(state.target.bytes, headerRowCount);
  state.target.sheets = parsed.sheets;
  state.target.headerRowCount = headerRowCount;
  state.target.activeSheet = parsed.sheetNames.includes(activeSheet) ? activeSheet : parsed.sheetNames[0];
  alignTransformationsToHeaders(state.target.sheets[state.target.activeSheet].headers);
  renderActiveSheet('target');
  renderTransformations();
  saveCurrent();
  schedulePreview();
}

function renderActiveSheet(kind) {
  const s = state[kind];
  if (!s) return;
  const sheet = s.sheets[s.activeSheet];
  const infoBits = [s.fileName, s.activeSheet, `${sheet.headers.length} columns`, `${sheet.rows.length} data rows`];
  if (kind === 'target' && s.headerRowCount > 1) infoBits.splice(3, 0, `${s.headerRowCount} header rows`);
  $(`${kind}-info`).textContent = infoBits.join(' · ');

  if (kind === 'source') {
    renderGrid($(`${kind}-grid`), sheet.headers, sheet.rows);
    return;
  }
  // Destination preview: captured rows rendered AS the <thead>, with no body.
  // Honors !merges so visually-merged header cells stay merged in the preview.
  const container = $('target-grid');
  container.innerHTML = '';
  const headerRows = sheet.headerRows || [sheet.headers];
  if (!headerRows.length) return;

  const covered = new Set(); // "r,c" for cells absorbed by a prior anchor
  const anchor = new Map();  // "r,c" → { rowspan, colspan }
  for (const m of (sheet.headerMerges || [])) {
    anchor.set(`${m.s.r},${m.s.c}`, { rowspan: m.e.r - m.s.r + 1, colspan: m.e.c - m.s.c + 1 });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        covered.add(`${r},${c}`);
      }
    }
  }

  const table = el('table', { className: 'grid' });
  const thead = el('thead');
  headerRows.forEach((hr, r) => {
    const tr = el('tr');
    tr.appendChild(el('th', { className: 'row-num' }, ''));
    sheet.headers.forEach((_, c) => {
      if (covered.has(`${r},${c}`)) return;
      const v = hr[c];
      const th = el('th', {}, v === undefined || v === null ? '' : String(v));
      const span = anchor.get(`${r},${c}`);
      if (span) {
        if (span.rowspan > 1) th.setAttribute('rowspan', String(span.rowspan));
        if (span.colspan > 1) th.setAttribute('colspan', String(span.colspan));
      }
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  });
  table.appendChild(thead);
  container.appendChild(table);
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
    codeArea.addEventListener('blur', saveCurrent);

    const preview = el('span', { className: 'preview' }, '—');
    const runBtn = el('button', {
      onClick: () => {
        const sampleRow = sourceSample()[0];
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
            trackEvent: { name: 'refine_column', params: { surface: 'transform', column: t.targetColumn } },
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
async function requestTransformations({ refinementComment, targetColumn, suggestName, trackEvent } = {}) {
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
  if (suggestName) body.suggestName = true;

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
  if (trackEvent) {
    Analytics.track(trackEvent.name, { ...trackEvent.params, model: data.model });
  }
  if (data.tokensExhausted && window.BillingNotice) {
    BillingNotice.showExhausted(data.tokensExhausted);
  }
  // Align to target column order, preserve any previously-edited codes not returned.
  const byCol = new Map(data.transformations.map(t => [t.targetColumn, t]));
  state.transformations = tgtSheet.headers.map(h => {
    if (byCol.has(h)) return byCol.get(h);
    const prior = state.transformations.find(t => t.targetColumn === h);
    return prior || { targetColumn: h, code: '', notes: '' };
  });
  if (data.suggestedName && !$('project-name').value.trim()) {
    $('project-name').value = data.suggestedName;
  }
  renderTransformations();
  statusEl.textContent = `${data.transformations.length} transformations ready`;
  statusEl.className = 'status success';
  saveCurrent();
}

// Event wiring
(async () => {
  // Wait for any post-login orphan-merge prompt before fetching the
  // project — otherwise a deep link to a just-merged project id would
  // 404 against the user's account and load as blank.
  if (window.Auth) await window.Auth.ready;
  await initProject();
  hydrateFromProject();
})();
$('project-name').addEventListener('blur', saveCurrent);
$('source-file').addEventListener('change', (e) => loadFile(e.target, 'source'));
$('target-file').addEventListener('change', (e) => loadFile(e.target, 'target'));
$('target-edit-btn').addEventListener('click', () => lockTarget(false));
$('source-sheet').addEventListener('change', (e) => {
  state.source.activeSheet = e.target.value;
  renderActiveSheet('source');
  schedulePreview();
});
$('target-sheet').addEventListener('change', (e) => {
  state.target.activeSheet = e.target.value;
  alignTransformationsToHeaders(state.target.sheets[state.target.activeSheet].headers);
  renderActiveSheet('target');
  renderTransformations();
  schedulePreview();
  saveCurrent();
});
$('sample-size').addEventListener('input', () => schedulePreview());

$('propose-btn').addEventListener('click', async () => {
  $('propose-btn').disabled = true;
  try {
    state.transformations = []; // fresh proposal
    const suggestName = !$('project-name').value.trim();
    await requestTransformations({
      suggestName,
      trackEvent: { name: 'button_click', params: { button: 'propose_columns', surface: 'transform' } },
    });
  } catch (e) { /* status shown */ }
  finally { $('propose-btn').disabled = false; }
});

$('refine-all-btn').addEventListener('click', async () => {
  const comment = $('refine-all-comment').value.trim();
  if (!comment) return;
  $('refine-all-btn').disabled = true;
  $('refine-all-btn').textContent = 'refining…';
  try {
    await requestTransformations({
      refinementComment: comment,
      trackEvent: { name: 'refine_all', params: { surface: 'transform' } },
    });
    $('refine-all-comment').value = '';
  } catch (e) { /* status shown */ }
  finally {
    $('refine-all-btn').disabled = false;
    $('refine-all-btn').textContent = 'Refine all';
  }
});

$('transform-btn').addEventListener('click', () => {
  Analytics.track('button_click', { button: 'run_transform', surface: 'transform' });
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

// SheetJS/xlsx-js-style reads fill info flat on cell.s (patternType/fgColor/
// bgColor) but its writer looks for s.fill/s.font/s.border/s.alignment. This
// rewraps known flat keys into the nested shape. Known font/border flat keys
// are also handled defensively in case the reader populates them.
function normalizeCellStyle(s) {
  if (!s || typeof s !== 'object') return s;
  const fillKeys = ['patternType', 'fgColor', 'bgColor'];
  const fontKeys = ['name', 'sz', 'bold', 'italic', 'underline', 'strike', 'color'];
  const borderKeys = ['top', 'bottom', 'left', 'right', 'diagonal'];
  const alignKeys = ['horizontal', 'vertical', 'wrapText', 'textRotation', 'indent', 'readingOrder'];

  const out = { ...s };
  const pull = (keys, target) => {
    const picked = {};
    let any = false;
    for (const k of keys) {
      if (out[k] !== undefined) {
        picked[k] = out[k];
        delete out[k];
        any = true;
      }
    }
    if (any) out[target] = { ...(out[target] || {}), ...picked };
  };
  pull(fillKeys, 'fill');
  pull(fontKeys, 'font');
  pull(borderKeys, 'border');
  pull(alignKeys, 'alignment');

  // An "empty" fill (patternType:'none' with no colors) tells Excel to ignore
  // the fill entry; pass it through unchanged so the writer emits nothing.
  if (out.fill && out.fill.patternType === 'none' && !out.fill.fgColor && !out.fill.bgColor) {
    delete out.fill;
  }
  return out;
}

function coerceCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return { t: 'n', v };
  if (typeof v === 'boolean') return { t: 'b', v };
  if (v instanceof Date) return { t: 'd', v };
  return { t: 's', v: String(v) };
}

// Write the output into a clone of the target workbook so header-row styles
// (fonts, fills, borders, merges, row heights, col widths) carry through.
// Falls back to a plain sheet when we don't have the original bytes (e.g. a
// saved-only project loaded without re-uploading the destination file).
function downloadStyledFromTarget() {
  const label = '[styled download]';
  console.time(`${label} total`);

  const tgtHeaders = state.target.sheets[state.target.activeSheet].headers;
  const headerRowCount = Math.max(1, state.target.headerRowCount || 1);

  console.time(`${label} XLSX.read`);
  const wb = XLSX.read(state.target.bytes, { type: 'array', cellStyles: true, sheetStubs: true });
  console.timeEnd(`${label} XLSX.read`);

  const sheetName = state.target.activeSheet;
  const ws = wb.Sheets[sheetName];
  const cellAddr = /^[A-Z]+\d+$/;

  // !ref fresh off disk still has Excel's ~1M-row padding. Tighten it before
  // the writer walks the range.
  console.time(`${label} tightenRef`);
  tightenRef(ws);
  console.timeEnd(`${label} tightenRef`);

  // !rows from Excel is often padded to 1,048,576 entries (mostly empty).
  // Drop anything past the real last row so the writer doesn't iterate a
  // million blanks.
  console.time(`${label} trim !rows`);
  if (Array.isArray(ws['!rows'])) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    ws['!rows'] = ws['!rows'].slice(0, range.e.r + 1);
  }
  console.timeEnd(`${label} trim !rows`);

  // Rewrap header-cell styles into the nested shape xlsx-js-style writes, and
  // simultaneously delete any data cells below the header block.
  console.time(`${label} normalize+clear cells`);
  let normalizedCount = 0, clearedCount = 0;
  for (const key of Object.keys(ws)) {
    if (!cellAddr.test(key)) continue;
    const { r } = XLSX.utils.decode_cell(key);
    if (r >= headerRowCount) {
      delete ws[key];
      clearedCount++;
    } else {
      ws[key] = { ...ws[key], s: normalizeCellStyle(ws[key].s) };
      normalizedCount++;
    }
  }
  console.timeEnd(`${label} normalize+clear cells`);
  console.log(`${label} normalized=${normalizedCount} cleared=${clearedCount} outputRows=${state.output.length} outputCols=${tgtHeaders.length}`);

  // Write transformed rows starting at row = headerRowCount.
  console.time(`${label} write data cells`);
  state.output.forEach((rowObj, i) => {
    const R = headerRowCount + i;
    tgtHeaders.forEach((h, C) => {
      const cell = coerceCell(rowObj[h]);
      if (!cell) return;
      ws[XLSX.utils.encode_cell({ r: R, c: C })] = cell;
    });
  });
  console.timeEnd(`${label} write data cells`);

  // Extend !ref to cover the new data range (preserve original start corner).
  const prev = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const endRow = headerRowCount + Math.max(0, state.output.length - 1);
  const endCol = Math.max(prev.e.c, tgtHeaders.length - 1);
  ws['!ref'] = XLSX.utils.encode_range({ s: prev.s, e: { r: Math.max(prev.e.r, endRow), c: endCol } });

  const srcName = state.source.fileName.replace(/\.xlsx?$/i, '');
  console.time(`${label} XLSX.writeFile`);
  XLSX.writeFile(wb, `${srcName}-transformed.xlsx`);
  console.timeEnd(`${label} XLSX.writeFile`);
  console.timeEnd(`${label} total`);
}

$('download-btn').addEventListener('click', () => {
  if (!state.output) return;
  Analytics.track('button_click', { button: 'download_output', surface: 'transform' });
  if (state.target && state.target.bytes) {
    downloadStyledFromTarget();
    return;
  }
  const tgtHeaders = state.target.sheets[state.target.activeSheet].headers;
  const aoa = [tgtHeaders, ...state.output.map(r => tgtHeaders.map(h => r[h] ?? ''))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transformed');
  const srcName = state.source.fileName.replace(/\.xlsx?$/i, '');
  XLSX.writeFile(wb, `${srcName}-transformed.xlsx`);
});

$('target-header-rows').addEventListener('change', reparseTarget);
