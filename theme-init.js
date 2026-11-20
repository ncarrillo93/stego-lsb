(function () {
  var saved = 'auto';
  try {
    var value = localStorage.getItem('stego-theme');
    if (value === 'light' || value === 'dark' || value === 'auto') {
      saved = value;
    }
  } catch (_) {}

  var resolved =
    saved === 'auto'
      ? window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : saved;

  document.documentElement.setAttribute('data-bs-theme', resolved);
})();
