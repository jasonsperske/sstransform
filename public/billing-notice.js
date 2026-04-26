// One-shot popups for billing-related state changes that the user needs
// to know about mid-task. Today this is just the "you ran out of tokens
// during this request" notice; the response itself is still rendered as
// usual — the popup is purely informational so the user understands why
// the next request will be on the free model.
(function (global) {
  function showExhausted({ previousLabel, defaultLabel }) {
    const overlay = document.createElement('div');
    overlay.className = 'cf-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'cf-dialog';
    dialog.style.width = 'min(440px, 100%)';

    const title = document.createElement('div');
    title.className = 'cf-title';
    title.textContent = 'Out of tokens';
    dialog.appendChild(title);

    const blurb = document.createElement('div');
    blurb.className = 'cf-blurb';
    blurb.textContent =
      `That request used your last prepaid tokens. Your model has been reset from ${previousLabel} to ${defaultLabel} (free). The response below was still generated for you. Buy more tokens to switch back.`;
    dialog.appendChild(blurb);

    const actions = document.createElement('div');
    actions.className = 'cf-actions';

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Got it';
    dismissBtn.addEventListener('click', () => overlay.remove());
    actions.appendChild(dismissBtn);

    const spacer = document.createElement('div');
    spacer.className = 'cf-spacer';
    actions.appendChild(spacer);

    const buyBtn = document.createElement('button');
    buyBtn.type = 'button';
    buyBtn.className = 'primary';
    buyBtn.textContent = 'Buy more tokens';
    buyBtn.addEventListener('click', () => {
      window.location.href = '/settings#billing';
    });
    actions.appendChild(buyBtn);

    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  global.BillingNotice = { showExhausted };
})(window);
