// Thin wrapper around gtag. No-ops when GA isn't configured (gtag undefined),
// so callers don't need to guard each event. Loaded on every page so the
// handle is always available; layout.ejs only injects gtag.js when GA is set.
(function (global) {
  function track(name, params) {
    try {
      if (typeof global.gtag === 'function') {
        global.gtag('event', name, params || {});
      }
    } catch (_) { /* never let analytics break a UI handler */ }
  }
  global.Analytics = { track };
})(window);
