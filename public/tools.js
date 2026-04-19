// Runtime helpers exposed on window for use inside user/Claude-authored
// function bodies (matchCode, column code, etc.)

(function (global) {
  function levenshteinDistance(a, b) {
    const s = a == null ? '' : String(a);
    const t = b == null ? '' : String(b);
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    const m = s.length;
    const n = t.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      const si = s.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,       // deletion
          curr[j - 1] + 1,   // insertion
          prev[j - 1] + cost // substitution
        );
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  global.levenshteinDistance = levenshteinDistance;
})(window);
