/* Aplică tema salvată înainte de primul paint (fără flash). */
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* localStorage indisponibil */ }
})();
