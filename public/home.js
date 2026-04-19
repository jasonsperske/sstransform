const $ = (id) => document.getElementById(id);

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
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
    main.href = `/transform/${encodeURIComponent(p.id)}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'project-name';
    nameEl.textContent = p.name || 'Untitled project';

    const metaBits = [];
    metaBits.push(`id ${p.id.slice(0, 8)}`);
    if (p.targetHeaders && p.targetHeaders.length) {
      metaBits.push(`${p.targetHeaders.length} target cols`);
    }
    const savedCount = (p.transformations || []).filter(t => t.code && t.code.trim()).length;
    if (savedCount) metaBits.push(`${savedCount} transformations`);
    metaBits.push(`updated ${fmtDate(p.updatedAt)}`);

    const metaEl = document.createElement('div');
    metaEl.className = 'project-meta';
    metaEl.textContent = metaBits.join(' · ');

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

$('new-project-btn').addEventListener('click', () => {
  const p = Projects.create();
  window.location.href = `/transform/${encodeURIComponent(p.id)}`;
});

render();
