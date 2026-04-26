const $ = (id) => document.getElementById(id);

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function summarize(p) {
  const bits = [`id ${p.id.slice(0, 8)}`];
  if (p.type === 'merge') {
    if (p.leftHeaders && p.leftHeaders.length) bits.push(`${p.leftHeaders.length} left cols`);
    if (p.rightHeaders && p.rightHeaders.length) bits.push(`${p.rightHeaders.length} right cols`);
    if (p.columns && p.columns.length) bits.push(`${p.columns.length} merged cols`);
    if (p.priority) bits.push(`${p.priority} priority`);
  } else {
    if (p.targetHeaders && p.targetHeaders.length) bits.push(`${p.targetHeaders.length} target cols`);
    const savedCount = (p.transformations || []).filter(t => t.code && t.code.trim()).length;
    if (savedCount) bits.push(`${savedCount} transformations`);
  }
  bits.push(`updated ${fmtDate(p.updatedAt)}`);
  return bits.join(' · ');
}

async function render() {
  const listEl = $('project-list');
  const emptyEl = $('empty-state');
  const projects = await Projects.list();

  listEl.innerHTML = '';
  if (!projects.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'project-row';

    const main = document.createElement('a');
    main.className = 'project-main';
    main.href = Projects.url(p);

    const nameEl = document.createElement('div');
    nameEl.className = 'project-name';
    nameEl.appendChild(document.createTextNode(p.name || 'Untitled project'));
    const badge = document.createElement('span');
    badge.className = `project-type ${p.type || 'transform'}`;
    badge.textContent = p.type || 'transform';
    nameEl.appendChild(document.createTextNode(' '));
    nameEl.appendChild(badge);

    const metaEl = document.createElement('div');
    metaEl.className = 'project-meta';
    metaEl.textContent = summarize(p);

    main.appendChild(nameEl);
    main.appendChild(metaEl);

    const actions = document.createElement('div');
    actions.className = 'project-actions';
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const snapshot = { ...p };
      await Projects.remove(p.id);
      await render();
      showUndoToast(snapshot);
    });
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

// Undo-delete toast. The full project payload is captured BEFORE the
// server delete fires; clicking Undo re-uploads it. After UNDO_WINDOW_MS
// the snapshot is dropped — there's no second-chance restore once the
// toast expires.
const UNDO_WINDOW_MS = 8000;
let activeUndo = null; // { snapshot, timer, el }

function dismissUndoToast() {
  if (!activeUndo) return;
  clearTimeout(activeUndo.timer);
  activeUndo.el.remove();
  activeUndo = null;
}

function showUndoToast(snapshot) {
  dismissUndoToast();

  const toast = document.createElement('div');
  toast.className = 'undo-toast';

  const label = document.createElement('span');
  label.textContent = `Deleted "${snapshot.name || 'Untitled project'}"`;
  toast.appendChild(label);

  const btn = document.createElement('button');
  btn.textContent = 'Undo';
  btn.addEventListener('click', async () => {
    const snap = activeUndo && activeUndo.snapshot;
    dismissUndoToast();
    if (!snap) return;
    await Projects.restore(snap);
    await render();
  });
  toast.appendChild(btn);

  document.body.appendChild(toast);
  activeUndo = {
    snapshot,
    el: toast,
    timer: setTimeout(dismissUndoToast, UNDO_WINDOW_MS),
  };
}

// New-project dropdown
const menuBtn = $('new-project-btn');
const menu = $('new-project-menu');

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});

document.addEventListener('click', (e) => {
  if (menu.hidden) return;
  if (e.target === menuBtn || menu.contains(e.target)) return;
  menu.hidden = true;
});

menu.querySelectorAll('[data-type]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.type;
    const p = await Projects.create({ type });
    window.location.href = Projects.url(p);
  });
});

(async () => {
  // Wait for any orphan-merge prompt to settle so the freshly-merged
  // projects show up in the listing immediately.
  if (window.Auth) await window.Auth.ready;
  await render();
})();
