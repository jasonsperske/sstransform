// On every page load for an authenticated visitor, check whether the
// current session id still owns any projects (i.e. work created while
// anonymous, before this session got attached to a user). If so, prompt
// the user to either merge those into their account or discard them.
//
// The popup deliberately has no "decide later" button — leaving orphans
// lying around just causes the prompt to reappear on every page load,
// which is worse UX than forcing a one-time choice. The X / backdrop
// click does dismiss without action, in case the user wants to think
// about it; they'll see it again next reload.
(function (global) {
  if (!global.__currentUser) return;

  const READY = Promise.resolve();
  let promptPromise = null;

  // Other modules can `await Auth.ready` before doing their first
  // `/api/projects` call so a freshly-merged project is already keyed to
  // the user when they fetch.
  global.Auth = {
    get ready() { return promptPromise || READY; },
  };

  promptPromise = (async () => {
    let orphans = [];
    try {
      const r = await fetch('/api/orphan-projects', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      orphans = data.projects || [];
    } catch (e) {
      console.warn('orphan check failed', e);
      return;
    }
    if (!orphans.length) return;
    await showMergeDialog(orphans);
  })();

  function summarize(p) {
    const name = (p.project && p.project.name) || 'Untitled project';
    const type = (p.project && p.project.type) || 'transform';
    return { name, type };
  }

  function showMergeDialog(orphans) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cf-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'cf-dialog';
      dialog.style.width = 'min(520px, 100%)';

      const title = document.createElement('div');
      title.className = 'cf-title';
      title.textContent = `Bring ${orphans.length} project${orphans.length === 1 ? '' : 's'} into your account?`;
      dialog.appendChild(title);

      const blurb = document.createElement('div');
      blurb.className = 'cf-blurb';
      blurb.textContent =
        "These were created before you signed in. Merging keeps them under your account; discarding deletes them.";
      dialog.appendChild(blurb);

      const list = document.createElement('div');
      list.className = 'cf-panel-body';
      list.style.padding = '12px 18px';
      list.style.maxHeight = '240px';
      list.style.overflow = 'auto';
      orphans.forEach(p => {
        const { name, type } = summarize(p);
        const row = document.createElement('div');
        row.style.padding = '4px 0';
        const nameEl = document.createElement('strong');
        nameEl.textContent = name;
        const typeEl = document.createElement('span');
        typeEl.style.color = '#666';
        typeEl.style.marginLeft = '8px';
        typeEl.textContent = `(${type})`;
        row.appendChild(nameEl);
        row.appendChild(typeEl);
        list.appendChild(row);
      });
      dialog.appendChild(list);

      const actions = document.createElement('div');
      actions.className = 'cf-actions';

      const discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.textContent = 'Discard';
      discardBtn.addEventListener('click', async () => {
        discardBtn.disabled = true;
        mergeBtn.disabled = true;
        try {
          await fetch('/api/orphan-projects/discard', {
            method: 'POST', credentials: 'same-origin',
          });
        } catch (e) { console.warn('discard failed', e); }
        close('discarded');
      });
      actions.appendChild(discardBtn);

      const spacer = document.createElement('div');
      spacer.className = 'cf-spacer';
      actions.appendChild(spacer);

      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      mergeBtn.className = 'primary';
      mergeBtn.textContent = 'Merge into my account';
      mergeBtn.addEventListener('click', async () => {
        mergeBtn.disabled = true;
        discardBtn.disabled = true;
        try {
          await fetch('/api/orphan-projects/merge', {
            method: 'POST', credentials: 'same-origin',
          });
        } catch (e) { console.warn('merge failed', e); }
        close('merged');
      });
      actions.appendChild(mergeBtn);

      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      // Backdrop click dismisses without action — orphans stay, prompt
      // reappears on the next reload. Clicks inside the dialog don't bubble.
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close('dismissed');
      });
      document.body.appendChild(overlay);

      function close(reason) {
        overlay.remove();
        resolve(reason);
      }
    });
  }
})(window);
