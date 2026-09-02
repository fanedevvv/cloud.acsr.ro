'use strict';
// Înregistrează service worker-ul
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Dacă am ajuns aici dintr-un "Share" de pe telefon, preia fișierele din cache
if (location.search.includes('share=1')) {
  (async () => {
    try {
      const cache = await caches.open('share-inbox');
      const cntRes = await cache.match('/__count');
      const n = cntRes ? parseInt(await cntRes.text(), 10) : 0;
      const files = [];
      for (let i = 0; i < n; i++) {
        const r = await cache.match('/__file/' + i);
        if (!r) continue;
        const blob = await r.blob();
        const name = decodeURIComponent(r.headers.get('X-Filename') || ('fisier-' + i));
        files.push(new File([blob], name, { type: blob.type }));
      }
      await caches.delete('share-inbox');
      history.replaceState(null, '', '/');
      if (files.length && window.__cloudUpload) window.__cloudUpload(files);
    } catch (e) { /* ignorăm */ }
  })();
}
