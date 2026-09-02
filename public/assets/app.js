'use strict';

const $ = (id) => document.getElementById(id);

let csrf = '';
let media = [];
let albums = [];
let query = '';
let cur = { view: 'all', albumId: null, album: null, items: [] };

const selected = new Set();
let lbList = [];
let lbIndex = -1;

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const r = await fetch('/api/csrf');
    if (r.status === 401) return location.replace('/login');
    csrf = (await r.json()).token;
  } catch {
    return location.replace('/login');
  }
  window.addEventListener('hashchange', route);
  wire();
  observeResize();
  try {
    await Promise.all([loadAll(), loadAlbums()]);
  } catch { /* api() a redirecționat la 401 */ }
  route();
})();

async function api(path, opts = {}) {
  const o = Object.assign({ headers: {} }, opts);
  if (o.method && o.method !== 'GET') {
    o.headers['x-csrf-token'] = csrf;
    if (o.body && typeof o.body === 'object') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
  }
  const r = await fetch(path, o);
  if (r.status === 401) { location.replace('/login'); throw new Error('401'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

async function loadAll() { media = await api('/api/media'); updateStorage(); }
async function loadAlbums() { albums = await api('/api/albums'); }
async function loadAlbum(id) {
  const d = await api('/api/albums/' + encodeURIComponent(id));
  cur.album = d.album;
  cur.items = d.items;
}

function updateStorage() {
  if (!$('storageText')) return;
  const bytes = media.reduce((s, m) => s + (m.size || 0), 0);
  const gb = bytes / 1e9;
  $('storageText').textContent =
    (gb >= 1 ? gb.toFixed(2) + ' GB' : Math.round(bytes / 1e6) + ' MB') +
    ' folosiți · ' + media.length + ' elemente';
  $('storageFill').style.width = Math.max(3, Math.min(100, (gb / 50) * 100)) + '%';
}

// ─── Router ─────────────────────────────────────────────────────────────────
function route() {
  clearSel();
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/album\/([0-9a-f-]{36})$/i);

  if (m) {
    cur.view = 'album'; cur.albumId = m[1];
    showView();
    loadAlbum(m[1]).then(renderAlbum).catch(() => { location.hash = '#/albums'; });
  } else if (h === '/albums') {
    cur.view = 'albums'; cur.albumId = null;
    showView();
    loadAlbums().then(renderAlbums);
  } else if (h === '/shares') {
    cur.view = 'shares'; cur.albumId = null;
    showView();
    loadAlbums().then(renderShares);
  } else {
    cur.view = 'all'; cur.albumId = null;
    showView();
    renderAll();
  }
  updateNav();
}

function showView() {
  $('viewAll').hidden = cur.view !== 'all';
  $('viewAlbums').hidden = cur.view !== 'albums';
  $('viewShares').hidden = cur.view !== 'shares';
  $('viewAlbum').hidden = cur.view !== 'album';
}

function updateNav() {
  document.querySelectorAll('.side-link').forEach((a) => {
    const v = a.dataset.view;
    const on =
      (v === 'all' && cur.view === 'all') ||
      (v === 'albums' && (cur.view === 'albums' || cur.view === 'album')) ||
      (v === 'shares' && cur.view === 'shares');
    a.classList.toggle('active', on);
  });
}

// ─── Etichete de zi ────────────────────────────────────────────────────────
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) return 'Azi';
  if (diff === 1) return 'Ieri';
  if (diff > 1 && diff < 7) return cap(d.toLocaleDateString('ro-RO', { weekday: 'long' }));
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('ro-RO', sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupByDay(list) {
  const groups = new Map();
  for (const it of list) {
    const k = (it.takenAt || it.createdAt).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return groups;
}

// ─── Layout justified ──────────────────────────────────────────────────────
const GAP = 4;
const targetRowH = () => (window.innerWidth < 700 ? 112 : 200);
const aspect = (it) => (it.width && it.height ? it.width / it.height : it.type === 'video' ? 16 / 9 : 1);

function justify(items, width, th) {
  const rows = [];
  let row = [];
  let arSum = 0;
  for (const it of items) {
    const ar = Math.max(0.4, Math.min(3.4, aspect(it)));
    row.push({ it, ar });
    arSum += ar;
    if (arSum * th + GAP * (row.length - 1) >= width) {
      const h = (width - GAP * (row.length - 1)) / arSum;
      rows.push(row.map((r) => ({ it: r.it, w: Math.round(r.ar * h), h: Math.round(h) })));
      row = []; arSum = 0;
    }
  }
  if (row.length) {
    const h = Math.min(th, (width - GAP * (row.length - 1)) / arSum);
    rows.push(row.map((r) => ({ it: r.it, w: Math.round(r.ar * h), h: Math.round(h) })));
  }
  return rows;
}

function buildGallery(container, list) {
  container._list = list;
  container.textContent = '';
  const width = container.clientWidth || container.parentElement.clientWidth || 900;
  const th = targetRowH();

  const frag = document.createDocumentFragment();
  for (const [, items] of groupByDay(list)) {
    const day = document.createElement('section');
    day.className = 'j-day';
    day.appendChild(dayHead(items[0].takenAt || items[0].createdAt, items.map((x) => x.id)));
    for (const r of justify(items, width, th)) {
      const rowEl = document.createElement('div');
      rowEl.className = 'j-row';
      for (const cell of r) rowEl.appendChild(jtile(cell));
      day.appendChild(rowEl);
    }
    frag.appendChild(day);
  }
  container.appendChild(frag);
}

function dayHead(dateIso, ids) {
  const wrap = document.createElement('div');
  wrap.className = 'j-dayhead';
  const chk = document.createElement('span');
  chk.className = 'daychk';
  if (ids.length && ids.every((id) => selected.has(id))) chk.classList.add('on');
  chk.addEventListener('click', () => {
    const on = ids.every((id) => selected.has(id));
    for (const id of ids) { if (on) selected.delete(id); else selected.add(id); }
    updateSelBar();
    rerender();
  });
  const lbl = document.createElement('span');
  lbl.className = 'daylabel';
  lbl.textContent = dayLabel(dateIso);
  wrap.appendChild(chk);
  wrap.appendChild(lbl);
  return wrap;
}

function jtile(cell) {
  const it = cell.it;
  const b = document.createElement('button');
  b.className = 'j-tile';
  b.type = 'button';
  b.dataset.id = it.id;
  b.style.width = cell.w + 'px';
  b.style.height = cell.h + 'px';
  if (selected.has(it.id)) b.classList.add('sel');

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = '/media/' + it.id + '/thumb';
  img.alt = it.originalName || '';
  b.appendChild(img);

  if (it.type === 'video') {
    const s = document.createElement('span');
    s.className = 'play-badge';
    s.textContent = '▶';
    b.appendChild(s);
  }

  const chk = document.createElement('span');
  chk.className = 'chk';
  chk.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(it.id); });
  b.appendChild(chk);

  b.addEventListener('click', () => {
    if (selected.size > 0) toggleSelect(it.id);
    else openLightbox(currentList(), it.id, true);
  });
  return b;
}

const currentList = () => (cur.view === 'album' ? cur.items : filteredMedia());

function filteredMedia() {
  if (!query) return media;
  const q = query.toLowerCase();
  return media.filter((m) =>
    (m.originalName || '').toLowerCase().includes(q) ||
    dayLabel(m.takenAt || m.createdAt).toLowerCase().includes(q) ||
    (m.takenAt || m.createdAt).slice(0, 10).includes(q));
}

// ─── Randare vederi ────────────────────────────────────────────────────────
function renderAll() {
  const list = filteredMedia();
  buildGallery($('allGrid'), list);
  $('allEmpty').hidden = list.length > 0;
}

function renderAlbum() {
  showView();
  updateNav();
  if (!cur.album) return;
  $('albumTitle').textContent = cur.album.name;
  buildGallery($('albumGrid'), cur.items);
  $('albumEmpty').hidden = cur.items.length > 0;
}

function albumCard(a) {
  const card = document.createElement('a');
  card.className = 'album-card';
  card.href = '#/album/' + a.id;

  const cover = document.createElement('div');
  cover.className = 'album-cover';
  if (a.coverId) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + a.coverId + '/thumb';
    cover.appendChild(img);
  } else {
    cover.classList.add('empty');
    cover.textContent = '🗀';
  }

  const meta = document.createElement('div');
  meta.className = 'album-meta';
  const nm = document.createElement('div');
  nm.className = 'album-name';
  nm.textContent = a.name;
  const sub = document.createElement('div');
  sub.className = 'album-sub muted';
  sub.textContent = a.count + (a.count === 1 ? ' element' : ' elemente') + (a.shareToken ? ' · partajat' : '');
  meta.appendChild(nm);
  meta.appendChild(sub);

  card.appendChild(cover);
  card.appendChild(meta);
  return card;
}

function renderAlbums() {
  const grid = $('albumsGrid');
  grid.textContent = '';
  $('albumsEmpty').hidden = albums.length > 0;
  for (const a of albums) grid.appendChild(albumCard(a));
}

function renderShares() {
  const shared = albums.filter((a) => a.shareToken);
  const grid = $('sharesGrid');
  grid.textContent = '';
  $('sharesEmpty').hidden = shared.length > 0;
  for (const a of shared) grid.appendChild(albumCard(a));
}

function rerender() {
  if (cur.view === 'all') renderAll();
  else if (cur.view === 'album') renderAlbum();
  else if (cur.view === 'albums') renderAlbums();
  else if (cur.view === 'shares') renderShares();
}

function observeResize() {
  let t;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      for (const c of [$('allGrid'), $('albumGrid')]) {
        if (c && c._list && !c.closest('.view').hidden) buildGallery(c, c._list);
      }
    }, 120);
  });
  ro.observe(document.querySelector('.main'));
}

// ─── Selecție ──────────────────────────────────────────────────────────────
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  document.querySelectorAll('.j-tile').forEach((el) => {
    if (el.dataset.id === id) el.classList.toggle('sel', selected.has(id));
  });
  syncDayChecks();
  updateSelBar();
}

function syncDayChecks() {
  document.querySelectorAll('.j-day').forEach((day) => {
    const ids = [...day.querySelectorAll('.j-tile')].map((el) => el.dataset.id);
    const chk = day.querySelector('.daychk');
    if (chk) chk.classList.toggle('on', ids.length > 0 && ids.every((id) => selected.has(id)));
  });
}

function clearSel() {
  if (!selected.size) { updateSelBar(); return; }
  selected.clear();
  document.querySelectorAll('.j-tile.sel').forEach((el) => el.classList.remove('sel'));
  document.querySelectorAll('.daychk.on').forEach((el) => el.classList.remove('on'));
  updateSelBar();
}

function updateSelBar() {
  const n = selected.size;
  $('selBar').hidden = n === 0;
  document.body.classList.toggle('selecting', n > 0);
  $('selCount').textContent = n;
  $('selRemove').hidden = cur.view !== 'album';
}

// ─── Chooser ───────────────────────────────────────────────────────────────
function openChooser(anchor) {
  const menu = $('chooser');
  const list = $('chooserList');
  list.textContent = '';
  if (!albums.length) {
    const p = document.createElement('div');
    p.className = 'menu-empty muted';
    p.textContent = 'Niciun album.';
    list.appendChild(p);
  }
  for (const a of albums) {
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.textContent = a.name;
    b.onclick = () => { addToAlbum(a.id, [...selected]); closeChooser(); };
    list.appendChild(b);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.top = rect.bottom + 6 + 'px';
  menu.style.right = window.innerWidth - rect.right + 'px';
  menu.hidden = false;
  setTimeout(() => document.addEventListener('click', outsideChooser), 0);
}
function outsideChooser(e) { if (!$('chooser').contains(e.target)) closeChooser(); }
function closeChooser() {
  $('chooser').hidden = true;
  document.removeEventListener('click', outsideChooser);
}

async function addToAlbum(albumId, ids) {
  try {
    const d = await api('/api/albums/' + albumId + '/items', { method: 'POST', body: { ids } });
    toast('Adăugat ' + d.added + ' în album');
    await loadAlbums();
    clearSel();
    if (cur.view === 'albums') renderAlbums();
  } catch (e) { toast(e.message); }
}

// ─── Partajare ─────────────────────────────────────────────────────────────
const shareLink = (token) => location.origin + '/s/' + token;

async function openShare() {
  let token = cur.album && cur.album.shareToken;
  if (!token) {
    try {
      const d = await api('/api/albums/' + cur.albumId + '/share', { method: 'POST' });
      token = d.token;
      cur.album.shareToken = token;
      await loadAlbums();
    } catch (e) { return toast(e.message); }
  }
  $('shareUrl').value = shareLink(token);
  $('shareModal').hidden = false;
}

// ─── Picker ────────────────────────────────────────────────────────────────
const pickerSel = new Set();
function openPicker() {
  pickerSel.clear();
  const inAlbum = new Set(cur.items.map((x) => x.id));
  const avail = media.filter((x) => !inAlbum.has(x.id));
  const grid = $('pickerGrid');
  grid.textContent = '';

  if (!avail.length) {
    const p = document.createElement('p');
    p.className = 'picker-empty muted';
    p.textContent = 'Toate pozele sunt deja în album.';
    grid.appendChild(p);
  }
  for (const it of avail) {
    const b = document.createElement('button');
    b.className = 'p-tile';
    b.type = 'button';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + it.id + '/thumb';
    b.appendChild(img);
    const c = document.createElement('span');
    c.className = 'chk';
    b.appendChild(c);
    b.onclick = () => {
      if (pickerSel.has(it.id)) { pickerSel.delete(it.id); b.classList.remove('sel'); }
      else { pickerSel.add(it.id); b.classList.add('sel'); }
      $('pickerCount').textContent = pickerSel.size + ' alese';
    };
    grid.appendChild(b);
  }
  $('pickerCount').textContent = '0 alese';
  $('pickerModal').hidden = false;
}

// ─── Lightbox ──────────────────────────────────────────────────────────────
const lb = $('lightbox');
const lbStage = $('lbStage');
const lbDelBtn = lb.querySelector('.lb-del');
const lbDl = $('lbDownload');
const lbStrip = $('lbStrip');

function sizeStr(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function openLightbox(list, id, canDelete) {
  lbList = list;
  lbIndex = list.findIndex((x) => x.id === id);
  if (lbIndex < 0) return;
  lbDelBtn.hidden = !canDelete;
  lb.hidden = false;
  document.body.classList.add('no-scroll');
  renderStrip();
  showLb();
}

function closeLightbox() {
  lb.hidden = true;
  lb.classList.remove('has-info');
  $('lbInfo').hidden = true;
  lbStage.textContent = '';
  document.body.classList.remove('no-scroll');
}

function showLb() {
  const it = lbList[lbIndex];
  lbStage.textContent = '';
  if (!it) return;
  if (it.type === 'video') {
    const v = document.createElement('video');
    v.src = '/media/' + it.id + '/full';
    v.controls = true; v.autoplay = true; v.playsInline = true;
    lbStage.appendChild(v);
  } else {
    const im = document.createElement('img');
    im.src = '/media/' + it.id + '/full';
    im.alt = it.originalName || '';
    lbStage.appendChild(im);
  }
  lbDl.href = '/media/' + it.id + '/full';
  lbDl.setAttribute('download', it.originalName || it.id);

  lbStrip.querySelectorAll('.strip-thumb').forEach((el, i) => {
    el.classList.toggle('cur', i === lbIndex);
    if (i === lbIndex) el.scrollIntoView({ inline: 'center', block: 'nearest' });
  });
  if (!$('lbInfo').hidden) renderInfo();
}

function renderStrip() {
  lbStrip.textContent = '';
  lbList.forEach((it, i) => {
    const t = document.createElement('button');
    t.className = 'strip-thumb' + (i === lbIndex ? ' cur' : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + it.id + '/thumb';
    t.appendChild(img);
    t.onclick = () => { lbIndex = i; showLb(); };
    lbStrip.appendChild(t);
  });
}

function renderInfo() {
  const it = lbList[lbIndex];
  const body = $('lbInfoBody');
  body.textContent = '';
  if (!it) return;
  const d = new Date(it.takenAt || it.createdAt);

  const date = document.createElement('div');
  date.className = 'info-date';
  date.textContent = cap(d.toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  const time = document.createElement('div');
  time.className = 'info-time';
  time.textContent = d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  body.appendChild(date);
  body.appendChild(time);

  const rows = [];
  if (it.originalName) rows.push(['image', it.originalName]);
  if (it.width && it.height) rows.push(['straighten', `${it.width} × ${it.height}  ·  ${(it.width * it.height / 1e6).toFixed(1)} MP`]);
  if (it.size) rows.push(['sd_card', sizeStr(it.size)]);
  rows.push([it.type === 'video' ? 'movie' : 'photo_camera', it.type === 'video' ? 'Videoclip' : 'Fotografie']);
  for (const [ic, txt] of rows) {
    const row = document.createElement('div');
    row.className = 'info-row';
    const i = document.createElement('span');
    i.className = 'msi';
    i.textContent = ic;
    const s = document.createElement('span');
    s.textContent = txt;
    row.appendChild(i);
    row.appendChild(s);
    body.appendChild(row);
  }
}

function toggleInfo() {
  const on = $('lbInfo').hidden;
  $('lbInfo').hidden = !on;
  lb.classList.toggle('has-info', on);
  if (on) renderInfo();
}

function stepLb(d) {
  if (!lbList.length) return;
  lbIndex = (lbIndex + d + lbList.length) % lbList.length;
  showLb();
}

async function deleteCurrentLb() {
  const it = lbList[lbIndex];
  if (!it || !confirm('Ștergi definitiv acest fișier?')) return;
  try {
    await api('/api/media/' + it.id, { method: 'DELETE' });
  } catch (e) { return toast(e.message); }
  await loadAll();
  await loadAlbums();
  if (cur.view === 'album') { await loadAlbum(cur.albumId); lbList = cur.items; }
  else lbList = filteredMedia();
  rerender();
  if (!lbList.length) return closeLightbox();
  lbIndex = Math.min(lbIndex, lbList.length - 1);
  renderStrip();
  showLb();
}

// ─── Upload ────────────────────────────────────────────────────────────────
async function uploadFiles(files) {
  $('uploadTray').hidden = false;
  const list = $('uploadList');
  const rows = files.map((f) => {
    const li = document.createElement('li');
    const nm = document.createElement('span');
    nm.className = 'u-name';
    nm.textContent = f.name;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    li.appendChild(nm);
    li.appendChild(bar);
    list.appendChild(li);
    return { li, fill };
  });

  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    $('uploadTitle').textContent = `Se încarcă ${i + 1}/${files.length}…`;
    try {
      await uploadOne(files[i], rows[i].fill);
      rows[i].li.classList.add('ok');
      ok++;
    } catch (e) {
      rows[i].li.classList.add('fail');
      rows[i].fill.style.width = '100%';
      rows[i].li.title = e && e.message ? e.message : 'eșuat';
    }
  }
  $('uploadTitle').textContent = `Gata — ${ok}/${files.length} încărcate`;
  await loadAll();
  await loadAlbums();
  rerender();
}

function uploadOne(file, fill) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('files', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) fill.style.width = ((e.loaded / e.total) * 100).toFixed(1) + '%';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) return location.replace('/login');
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('HTTP ' + xhr.status));
      fill.style.width = '100%';
      try {
        const res = JSON.parse(xhr.responseText);
        const first = res.items && res.items[0];
        if (first && first.error) return reject(new Error(first.error));
      } catch { /* fără JSON */ }
      resolve();
    });
    xhr.addEventListener('error', () => reject(new Error('rețea')));
    xhr.send(fd);
  });
}

// ─── Toast ─────────────────────────────────────────────────────────────────
let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

// ─── Wiring ────────────────────────────────────────────────────────────────
function wire() {
  const openSide = () => { $('side').classList.add('open'); $('sideScrim').hidden = false; };
  const closeSide = () => { $('side').classList.remove('open'); $('sideScrim').hidden = true; };
  $('menuBtn').onclick = openSide;
  $('menuClose').onclick = closeSide;
  $('sideScrim').onclick = closeSide;
  document.querySelectorAll('.side-link').forEach((a) => a.addEventListener('click', closeSide));

  $('acctBtn').onclick = (e) => { e.stopPropagation(); $('acctMenu').hidden = !$('acctMenu').hidden; };
  document.addEventListener('click', () => { $('acctMenu').hidden = true; });
  $('logoutBtn').onclick = async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } }); } catch {}
    location.replace('/login');
  };

  $('search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    $('searchClear').hidden = !query;
    if (cur.view === 'all') renderAll();
  });
  $('searchClear').onclick = () => {
    $('search').value = ''; query = ''; $('searchClear').hidden = true;
    if (cur.view === 'all') renderAll();
  };

  const fileInput = $('fileInput');
  $('uploadBtn').onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });
  $('uploadClose').onclick = () => { $('uploadTray').hidden = true; $('uploadList').textContent = ''; };

  $('selCancel').onclick = clearSel;
  $('selAdd').onclick = (e) => {
    if (!selected.size) return toast('Nimic selectat');
    openChooser(e.currentTarget);
  };
  $('chooserNew').onclick = async () => {
    const name = prompt('Nume album nou');
    if (!name || !name.trim()) return;
    try {
      const a = await api('/api/albums', { method: 'POST', body: { name: name.trim() } });
      await addToAlbum(a.id, [...selected]);
      closeChooser();
    } catch (e) { toast(e.message); }
  };
  $('selRemove').onclick = async () => {
    if (!selected.size || cur.view !== 'album') return;
    try {
      await api('/api/albums/' + cur.albumId + '/items', { method: 'DELETE', body: { ids: [...selected] } });
      toast('Scos din album');
      await loadAlbum(cur.albumId);
      await loadAlbums();
      clearSel();
      renderAlbum();
    } catch (e) { toast(e.message); }
  };
  $('selDelete').onclick = async () => {
    if (!selected.size) return;
    if (!confirm(`Ștergi definitiv ${selected.size} fișiere?`)) return;
    for (const id of [...selected]) {
      try { await api('/api/media/' + id, { method: 'DELETE' }); } catch { /* continuă */ }
    }
    toast('Șters');
    await loadAll();
    await loadAlbums();
    if (cur.view === 'album') await loadAlbum(cur.albumId);
    clearSel();
    rerender();
  };

  $('newAlbumBtn').onclick = async () => {
    const name = prompt('Nume album');
    if (!name || !name.trim()) return;
    try {
      await api('/api/albums', { method: 'POST', body: { name: name.trim() } });
      await loadAlbums();
      renderAlbums();
    } catch (e) { toast(e.message); }
  };
  $('albumBack').onclick = () => { location.hash = '#/albums'; };
  $('albumAdd').onclick = () => openPicker();
  $('albumShare').onclick = () => openShare();
  $('albumRename').onclick = async () => {
    const name = prompt('Nume nou', cur.album.name);
    if (!name || !name.trim()) return;
    try {
      await api('/api/albums/' + cur.albumId, { method: 'PATCH', body: { name: name.trim() } });
      cur.album.name = name.trim();
      $('albumTitle').textContent = cur.album.name;
      await loadAlbums();
      toast('Redenumit');
    } catch (e) { toast(e.message); }
  };
  $('albumDelete').onclick = async () => {
    if (!confirm('Ștergi albumul „' + cur.album.name + '”? Pozele rămân în galerie.')) return;
    try {
      await api('/api/albums/' + cur.albumId, { method: 'DELETE' });
      await loadAlbums();
      location.hash = '#/albums';
    } catch (e) { toast(e.message); }
  };

  $('shareCopy').onclick = async () => {
    const v = $('shareUrl').value;
    try {
      await navigator.clipboard.writeText(v);
      toast('Link copiat');
    } catch {
      $('shareUrl').select();
      try { document.execCommand('copy'); toast('Link copiat'); } catch { toast('Copiază manual'); }
    }
  };
  $('shareRevoke').onclick = async () => {
    if (!confirm('Dezactivezi linkul? Nu va mai funcționa pentru nimeni.')) return;
    try {
      await api('/api/albums/' + cur.albumId + '/share', { method: 'DELETE' });
      cur.album.shareToken = null;
      await loadAlbums();
      $('shareModal').hidden = true;
      toast('Link dezactivat');
    } catch (e) { toast(e.message); }
  };
  $('shareClose').onclick = () => { $('shareModal').hidden = true; };

  $('pickerClose').onclick = () => { $('pickerModal').hidden = true; };
  $('pickerConfirm').onclick = async () => {
    if (!pickerSel.size) { $('pickerModal').hidden = true; return; }
    try {
      const d = await api('/api/albums/' + cur.albumId + '/items', { method: 'POST', body: { ids: [...pickerSel] } });
      $('pickerModal').hidden = true;
      toast('Adăugat ' + d.added);
      await loadAlbum(cur.albumId);
      await loadAlbums();
      renderAlbum();
    } catch (e) { toast(e.message); }
  };

  lb.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (act === 'close') closeLightbox();
    else if (act === 'prev') stepLb(-1);
    else if (act === 'next') stepLb(1);
    else if (act === 'delete') deleteCurrentLb();
    else if (act === 'info') toggleInfo();
    else if (e.target === lb || e.target === lbStage) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!lb.hidden) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLb(-1);
      else if (e.key === 'ArrowRight') stepLb(1);
      else if (e.key === 'i') toggleInfo();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('shareModal').hidden) $('shareModal').hidden = true;
      else if (!$('pickerModal').hidden) $('pickerModal').hidden = true;
      else if (selected.size) clearSel();
    }
  });

  const dropOverlay = $('dropOverlay');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
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
}
