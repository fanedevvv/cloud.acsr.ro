'use strict';
// Versiunea trebuie bumpată odată cu assets (?v=N)
const V = 'v57';
const SHELL = 'shell-' + V;
const RUNTIME = 'runtime-' + V;
const PRECACHE = [
  '/',
  '/login',
  '/register',
  '/assets/styles.css?v=' + V,
  '/assets/app.js?v=' + V,
  '/assets/login.js?v=' + V,
  '/assets/register.js?v=' + V,
  '/assets/theme-init.js',
  '/assets/pwa.js?v=' + V,
  '/assets/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME && k !== 'share-inbox').map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Share target de pe telefon: preia fișierele și trimite pagina să le încarce
  if (url.pathname === '/share-target' && req.method === 'POST') {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('files').filter(Boolean);
        const cache = await caches.open('share-inbox');
        await cache.put('/__count', new Response(String(files.length)));
        for (let i = 0; i < files.length; i++) {
          await cache.put('/__file/' + i, new Response(files[i], {
            headers: {
              'Content-Type': files[i].type || 'application/octet-stream',
              'X-Filename': encodeURIComponent(files[i].name || ('fisier-' + i)),
            },
          }));
        }
      } catch (err) { /* ignorăm */ }
      return Response.redirect('/?share=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API și fișierele media: mereu din rețea (conținut privat / proaspăt)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') ||
      url.pathname.startsWith('/s/') || url.pathname.startsWith('/p/') || url.pathname === '/qr') {
    return;
  }

  // Navigări: rețea, cu revenire la shell-ul din cache
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/') .then((r) => r || caches.match('/login')))
    );
    return;
  }

  // Assets: din cache, actualizat în fundal (stale-while-revalidate)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) caches.open(RUNTIME).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
  }
});
