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

function render() {
  const listEl = $('project-list');
  const emptyEl = $('empty-state');
  const projects = Projects.list();

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
    delBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!confirm(`Delete "${p.name || 'Untitled project'}"?`)) return;
      Projects.remove(p.id);
      render();
    });
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
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
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    const p = Projects.create({ type });
    window.location.href = Projects.url(p);
  });
});

render();
