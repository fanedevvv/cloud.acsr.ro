'use strict';

let csrf = '';
let items = [];

const gallery = document.getElementById('gallery');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const r = await fetch('/api/csrf');
    if (r.status === 401) return (location.href = '/login');
    csrf = (await r.json()).token;
  } catch {
    return (location.href = '/login');
  }
  await loadMedia();
})();

async function loadMedia() {
  const r = await fetch('/api/media');
  if (r.status === 401) return (location.href = '/login');
  items = await r.json();
  render();
}

// ─── Randare galerie grupată pe zi ──────────────────────────────────────────
function dayKey(it) {
  return (it.takenAt || it.createdAt).slice(0, 10);
}

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' });
}

function render() {
  gallery.querySelectorAll('.group').forEach((n) => n.remove());
  emptyEl.hidden = items.length > 0;
  countEl.textContent = items.length ? `${items.length} elemente` : '';

  const groups = new Map();
  for (const it of items) {
    const k = dayKey(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  const frag = document.createDocumentFragment();
  for (const [, list] of groups) {
    const section = document.createElement('section');
    section.className = 'group';

    const h = document.createElement('h2');
    h.textContent = fmtDay(list[0].takenAt || list[0].createdAt);
    section.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const it of list) grid.appendChild(tile(it));
    section.appendChild(grid);

    frag.appendChild(section);
  }
  gallery.appendChild(frag);
}

function tile(it) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.type = 'button';
  b.dataset.id = it.id;

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/media/${it.id}/thumb`;
  img.alt = it.originalName || '';
  b.appendChild(img);

  if (it.type === 'video') {
    const badge = document.createElement('span');
    badge.className = 'play-badge';
    badge.textContent = '▶';
    b.appendChild(badge);
  }

  b.addEventListener('click', () => openLightbox(it.id));
  return b;
}

// ─── Lightbox ───────────────────────────────────────────────────────────────
const lightbox = document.getElementById('lightbox');
const lbStage = document.getElementById('lbStage');
let lbIndex = -1;

function openLightbox(id) {
  lbIndex = items.findIndex((x) => x.id === id);
  if (lbIndex < 0) return;
  lightbox.hidden = false;
  document.body.classList.add('no-scroll');
  showLb();
}

function closeLightbox() {
  lightbox.hidden = true;
  lbStage.textContent = '';
  document.body.classList.remove('no-scroll');
}

function showLb() {
  const it = items[lbIndex];
  lbStage.textContent = '';
  if (!it) return;

  if (it.type === 'video') {
    const v = document.createElement('video');
    v.src = `/media/${it.id}/full`;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    lbStage.appendChild(v);
  } else {
    const i = document.createElement('img');
    i.src = `/media/${it.id}/full`;
    i.alt = it.originalName || '';
    lbStage.appendChild(i);
  }
}

function step(n) {
  if (!items.length) return;
  lbIndex = (lbIndex + n + items.length) % items.length;
  showLb();
}

async function deleteCurrent() {
  const it = items[lbIndex];
  if (!it) return;
  if (!confirm('Ștergi definitiv acest fișier?')) return;

  const r = await fetch(`/api/media/${it.id}`, {
    method: 'DELETE',
    headers: { 'x-csrf-token': csrf },
  });
  if (!r.ok) {
    alert('Ștergere eșuată');
    return;
  }
  items.splice(lbIndex, 1);
  render();
  if (!items.length) return closeLightbox();
  lbIndex = Math.min(lbIndex, items.length - 1);
  showLb();
}

lightbox.addEventListener('click', (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (act === 'close' || e.target === lightbox) closeLightbox();
  else if (act === 'prev') step(-1);
  else if (act === 'next') step(1);
  else if (act === 'delete') deleteCurrent();
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

// ─── Upload ─────────────────────────────────────────────────────────────────
const fileInput = document.getElementById('fileInput');
const tray = document.getElementById('uploadTray');
const trayList = document.getElementById('uploadList');
const trayTitle = document.getElementById('uploadTitle');

document.getElementById('uploadBtn').addEventListener('click', () => fileInput.click());
document.getElementById('uploadClose').addEventListener('click', () => {
  tray.hidden = true;
  trayList.textContent = '';
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles([...fileInput.files]);
  fileInput.value = '';
});

async function uploadFiles(files) {
  tray.hidden = false;
  const rows = files.map((f) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'u-name';
    name.textContent = f.name;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    li.appendChild(name);
    li.appendChild(bar);
    trayList.appendChild(li);
    return { li, fill };
  });

  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    trayTitle.textContent = `Se încarcă ${i + 1}/${files.length}…`;
    try {
      await uploadOne(files[i], rows[i].fill);
      rows[i].li.classList.add('ok');
      ok++;
    } catch (err) {
      rows[i].li.classList.add('fail');
      rows[i].fill.style.width = '100%';
      rows[i].li.title = err && err.message ? err.message : 'eșuat';
    }
  }
  trayTitle.textContent = `Gata — ${ok}/${files.length} încărcate`;
  await loadMedia();
}

function uploadOne(file, fill) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('files', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-csrf-token', csrf);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        fill.style.width = ((e.loaded / e.total) * 100).toFixed(1) + '%';
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) return (location.href = '/login');
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error('HTTP ' + xhr.status));
      }
      fill.style.width = '100%';
      try {
        const res = JSON.parse(xhr.responseText);
        const first = res.items && res.items[0];
        if (first && first.error) return reject(new Error(first.error));
      } catch { /* fără JSON valid */ }
      resolve();
    });
    xhr.addEventListener('error', () => reject(new Error('rețea')));
    xhr.send(fd);
  });
}

// ─── Drag & drop pe toată pagina ────────────────────────────────────────────
const dropOverlay = document.getElementById('dropOverlay');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (files.length) uploadFiles(files);
});

// ─── Logout ─────────────────────────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
  } catch { /* oricum redirecționăm */ }
  location.href = '/login';
});
