// Modal queue that asks the user which side wins for each sync conflict.
//
// Usage:
//   const decisions = await ConflictDialog.resolve([
//     { local, remote },   // both are full project objects (parsed)
//     ...
//   ]);
//   // decisions: array same length as input, each
//   //   { choice: 'local' | 'remote' | 'cancel' }
//
// The promise resolves once the user has clicked through every conflict
// (or hit "Cancel all"). Conflicts are presented one at a time, top of
// the queue first, so the user can focus on each without scanning a
// wall of diffs.
(function (global) {
  function summarize(p) {
    if (!p) return { lines: ['(missing)'] };
    const lines = [];
    lines.push(`name: ${p.name || '(unnamed)'}`);
    lines.push(`type: ${p.type || 'transform'}`);
    if (p.deleted) lines.push('deleted: yes');
    if (p.updatedAt) lines.push(`updated: ${new Date(p.updatedAt).toLocaleString()}`);

    if (p.type === 'merge') {
      if (p.leftHeaders) lines.push(`left cols: ${p.leftHeaders.length}`);
      if (p.rightHeaders) lines.push(`right cols: ${p.rightHeaders.length}`);
      if (p.columns) lines.push(`merged cols: ${p.columns.length}`);
      if (p.priority) lines.push(`priority: ${p.priority}`);
    } else {
      if (p.sourceHeaders) lines.push(`source cols: ${p.sourceHeaders.length}`);
      if (p.targetHeaders) lines.push(`target cols: ${p.targetHeaders.length}`);
      const xCount = (p.transformations || []).filter(t => t.code && t.code.trim()).length;
      if (xCount) lines.push(`transformations: ${xCount}`);
    }
    return { lines };
  }

  function buildPanel(label, project) {
    const wrap = document.createElement('div');
    wrap.className = 'cf-panel';

    const head = document.createElement('div');
    head.className = 'cf-panel-head';
    head.textContent = label;
    wrap.appendChild(head);

    const summary = summarize(project);
    const body = document.createElement('div');
    body.className = 'cf-panel-body';
    for (const line of summary.lines) {
      const row = document.createElement('div');
      row.textContent = line;
      body.appendChild(row);
    }
    wrap.appendChild(body);

    const details = document.createElement('details');
    details.className = 'cf-panel-raw';
    const sum = document.createElement('summary');
    sum.textContent = 'Show raw JSON';
    details.appendChild(sum);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(project, null, 2);
    details.appendChild(pre);
    wrap.appendChild(details);

    return wrap;
  }

  function showOne({ local, remote, index, total }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cf-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'cf-dialog';

      const title = document.createElement('div');
      title.className = 'cf-title';
      const projectName =
        (local && local.name) || (remote && remote.name) || '(unnamed project)';
      title.textContent = `Sync conflict (${index + 1} of ${total}): ${projectName}`;
      dialog.appendChild(title);

      const blurb = document.createElement('div');
      blurb.className = 'cf-blurb';
      blurb.textContent =
        'This project was changed both on this device and on another. Pick which version to keep — the other will be overwritten.';
      dialog.appendChild(blurb);

      const panels = document.createElement('div');
      panels.className = 'cf-panels';
      panels.appendChild(buildPanel('This device', local));
      panels.appendChild(buildPanel('Server', remote));
      dialog.appendChild(panels);

      const actions = document.createElement('div');
      actions.className = 'cf-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel all';
      cancelBtn.addEventListener('click', () => done('cancel-all'));
      actions.appendChild(cancelBtn);

      const spacer = document.createElement('div');
      spacer.className = 'cf-spacer';
      actions.appendChild(spacer);

      const localBtn = document.createElement('button');
      localBtn.textContent = 'Keep this device';
      localBtn.addEventListener('click', () => done('local'));
      actions.appendChild(localBtn);

      const remoteBtn = document.createElement('button');
      remoteBtn.className = 'primary';
      remoteBtn.textContent = 'Keep server';
      remoteBtn.addEventListener('click', () => done('remote'));
      actions.appendChild(remoteBtn);

      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      function done(choice) {
        overlay.remove();
        resolve(choice);
      }
    });
  }

  async function resolve(conflicts) {
    const decisions = [];
    let cancelled = false;
    for (let i = 0; i < conflicts.length; i++) {
      if (cancelled) {
        decisions.push({ choice: 'cancel' });
        continue;
      }
      const choice = await showOne({
        local: conflicts[i].local,
        remote: conflicts[i].remote,
        index: i,
        total: conflicts.length,
      });
      if (choice === 'cancel-all') {
        cancelled = true;
        decisions.push({ choice: 'cancel' });
      } else {
        decisions.push({ choice }); // 'local' | 'remote'
      }
    }
    return decisions;
  }

  global.ConflictDialog = { resolve };
})(window);
