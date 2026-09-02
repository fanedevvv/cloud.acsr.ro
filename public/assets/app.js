'use strict';

const $ = (id) => document.getElementById(id);
const FLAT = ['all', 'highlights', 'archive', 'trash'];
const TITLES = { all: 'Poze', highlights: 'Favorite', archive: 'Arhivă', trash: 'Coș' };
const EMPTY = {
  all: 'Nicio poză încă.',
  highlights: 'Nicio favorită. Apasă ⭐ pe o poză.',
  archive: 'Arhiva e goală.',
  trash: 'Coșul e gol.',
};
const DENSITY = { s: 132, m: 200, l: 284 };

let csrf = '';
let media = [];
let archiveList = [];
let trashList = [];
let albums = [];
let memories = [];
let query = '';
let filterType = 'all';
let filterFav = false;
let filterYear = '';
let density = 'm';
let cur = { view: 'all', albumId: null, album: null, items: [] };

const selected = new Set();
let lbList = [];
let lbIndex = -1;
let slideTimer = null;

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try { density = localStorage.getItem('density') || 'm'; } catch {}
  try {
    const r = await fetch('/api/csrf');
    if (r.status === 401) return location.replace('/login');
    csrf = (await r.json()).token;
  } catch {
    return location.replace('/login');
  }
  markThemeMenu(currentThemeMode());
  updateThemeColor();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColor);
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

async function loadAll() {
  media = await api('/api/media');
  updateStorage();
  try { memories = await api('/api/memories'); } catch { memories = []; }
}
async function loadArchive() { archiveList = await api('/api/media?filter=archive'); }
async function loadTrash() { trashList = await api('/api/media?filter=trash'); }
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

// ─── Temă ──────────────────────────────────────────────────────────────────
function currentThemeMode() {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
}
function setTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', mode);
  } catch {}
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  markThemeMenu(mode);
  updateThemeColor();
}
function markThemeMenu(mode) {
  document.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('sel', b.dataset.theme === mode));
}
function updateThemeColor() {
  const attr = document.documentElement.getAttribute('data-theme');
  const dark = attr === 'dark' || (!attr && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', dark ? '#131316' : '#ffffff');
}

// ─── Router ─────────────────────────────────────────────────────────────────
function route() {
  clearSel();
  stopSlideshow();
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/album\/([0-9a-f-]{36})$/i);

  if (m) {
    cur.view = 'album'; cur.albumId = m[1];
    showView();
    loadAlbum(m[1]).then(renderAlbum).catch(() => { location.hash = '#/albums'; });
  } else if (h === '/albums') {
    cur.view = 'albums';
    showView();
    loadAlbums().then(renderAlbums);
  } else if (h === '/shares') {
    cur.view = 'shares';
    showView();
    loadAlbums().then(renderShares);
  } else if (h === '/highlights') {
    cur.view = 'highlights'; showView(); renderGrid();
  } else if (h === '/archive') {
    cur.view = 'archive'; showView(); loadArchive().then(renderGrid);
  } else if (h === '/trash') {
    cur.view = 'trash'; showView(); loadTrash().then(renderGrid);
  } else {
    cur.view = 'all'; showView(); renderGrid();
  }
  updateNav();
}

function showView() {
  $('viewGrid').hidden = !FLAT.includes(cur.view);
  $('viewAlbums').hidden = cur.view !== 'albums';
  $('viewShares').hidden = cur.view !== 'shares';
  $('viewAlbum').hidden = cur.view !== 'album';
}

function updateNav() {
  document.querySelectorAll('.side-link').forEach((a) => {
    const v = a.dataset.view;
    const on = v === cur.view || (v === 'albums' && cur.view === 'album');
    a.classList.toggle('active', on);
  });
}

// ─── Date labels ───────────────────────────────────────────────────────────
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
const targetRowH = () => {
  const base = DENSITY[density] || 200;
  return window.innerWidth < 700 ? Math.round(base * 0.62) : base;
};
// Fără dimensiuni reale (video fără ffprobe) folosim un raport moderat ca să nu
// domine grila.
const aspect = (it) => (it.width && it.height ? it.width / it.height : it.type === 'video' ? 1.4 : 1);

function justify(items, width, th) {
  const W = Math.floor(width);
  const rows = [];
  let row = [];
  let arSum = 0;
  for (const it of items) {
    const ar = Math.max(0.4, Math.min(3.4, aspect(it)));
    row.push({ it, ar });
    arSum += ar;
    if (arSum * th + GAP * (row.length - 1) >= W) {
      const h = (W - GAP * (row.length - 1)) / arSum;
      const cells = row.map((r) => ({ it: r.it, w: Math.round(r.ar * h), h: Math.round(h) }));
      // Corectează eroarea de rotunjire pe ultima celulă: rândul plin trebuie
      // să încapă fix în lățime, altfel se taie pe telefon.
      const used = cells.reduce((s, c) => s + c.w, 0) + GAP * (cells.length - 1);
      cells[cells.length - 1].w += W - used;
      rows.push(cells);
      row = []; arSum = 0;
    }
  }
  if (row.length) {
    const h = Math.min(th, (W - GAP * (row.length - 1)) / arSum);
    rows.push(row.map((r) => ({ it: r.it, w: Math.round(r.ar * h), h: Math.round(h) })));
  }
  return rows;
}

function contentWidth(el) {
  const cs = getComputedStyle(el);
  const w = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 900;
  return w - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
}

function buildGallery(container, list) {
  container._list = list;
  container.textContent = '';
  const width = contentWidth(container);
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

  if (cur.view !== 'trash') {
    const fav = document.createElement('button');
    fav.className = 'fav-btn' + (it.favorite ? ' on' : '');
    fav.type = 'button';
    fav.innerHTML = '<span class="msi">star</span>';
    fav.title = 'Favorite';
    fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(it, fav); });
    b.appendChild(fav);
  }

  b.addEventListener('click', () => {
    if (selected.size > 0) toggleSelect(it.id);
    else openLightbox(gridData(), it.id);
  });
  return b;
}

function applySearch(list) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((m) =>
    (m.originalName || '').toLowerCase().includes(q) ||
    (m.caption || '').toLowerCase().includes(q) ||
    dayLabel(m.takenAt || m.createdAt).toLowerCase().includes(q) ||
    (m.takenAt || m.createdAt).slice(0, 10).includes(q));
}

function applyFilters(list) {
  return list.filter((m) => {
    if (filterType !== 'all' && m.type !== filterType) return false;
    if (filterFav && !m.favorite) return false;
    if (filterYear && String(new Date(m.takenAt || m.createdAt).getFullYear()) !== filterYear) return false;
    return true;
  });
}

function gridData() {
  if (cur.view === 'album') return cur.items;
  if (cur.view === 'trash') return applySearch(trashList);
  let base;
  if (cur.view === 'highlights') base = media.filter((m) => m.favorite);
  else if (cur.view === 'archive') base = archiveList;
  else base = media;
  return applyFilters(applySearch(base));
}

// ─── Randare ───────────────────────────────────────────────────────────────
function renderGrid() {
  const list = gridData();
  $('gridTitle').textContent = TITLES[cur.view] || 'Poze';
  $('emptyTrashBtn').hidden = cur.view !== 'trash' || trashList.length === 0;
  $('trashNote').hidden = cur.view !== 'trash';
  renderChips();
  renderMemories();
  buildGallery($('grid'), list);
  $('gridEmpty').hidden = list.length > 0;
  $('gridEmptyText').textContent = EMPTY[cur.view] || 'Gol.';
}

function renderChips() {
  const show = cur.view === 'all' || cur.view === 'highlights' || cur.view === 'archive';
  $('chips').hidden = !show;
  if (!show) return;
  document.querySelectorAll('.chip[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === filterType));
  $('chipFav').classList.toggle('on', filterFav);
  const sel = $('chipYear');
  const src = cur.view === 'highlights' ? media.filter((m) => m.favorite) : cur.view === 'archive' ? archiveList : media;
  const years = [...new Set(src.map((m) => new Date(m.takenAt || m.createdAt).getFullYear()))].sort((a, b) => b - a);
  const want = ['<option value="">Toți anii</option>'].concat(years.map((y) => '<option value="' + y + '">' + y + '</option>')).join('');
  if (sel.dataset.built !== want) { sel.innerHTML = want; sel.dataset.built = want; }
  sel.value = filterYear;
}

function renderMemories() {
  const strip = $('memStrip');
  const show = cur.view === 'all' && !query && memories.length > 0;
  strip.hidden = !show;
  if (!show) return;
  strip.textContent = '';
  const byYear = new Map();
  for (const it of memories) {
    const y = new Date(it.takenAt || it.createdAt).getFullYear();
    if (!byYear.has(y)) byYear.set(y, it);
  }
  const now = new Date().getFullYear();
  for (const [y, it] of byYear) {
    const c = document.createElement('button');
    c.className = 'mem-card';
    c.type = 'button';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + it.id + '/thumb';
    const capEl = document.createElement('span');
    capEl.className = 'mem-cap';
    const n = now - y;
    capEl.textContent = n === 1 ? 'Acum un an' : 'Acum ' + n + ' ani';
    c.appendChild(img);
    c.appendChild(capEl);
    c.onclick = () => openLightbox(memories, it.id);
    strip.appendChild(c);
  }
}

function dateRange(aIso, bIso) {
  if (!aIso) return '';
  const a = new Date(aIso);
  const b = new Date(bIso || aIso);
  const full = { day: 'numeric', month: 'long', year: 'numeric' };
  if (a.toDateString() === b.toDateString()) return cap(a.toLocaleDateString('ro-RO', full));
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameYear && a.getMonth() === b.getMonth()) {
    return a.getDate() + '–' + b.toLocaleDateString('ro-RO', full);
  }
  if (sameYear) {
    return a.toLocaleDateString('ro-RO', { day: 'numeric', month: 'long' }) +
      ' – ' + b.toLocaleDateString('ro-RO', full);
  }
  return a.toLocaleDateString('ro-RO', full) + ' – ' + b.toLocaleDateString('ro-RO', full);
}

function renderAlbum() {
  showView();
  updateNav();
  if (!cur.album) return;
  if (document.activeElement !== $('albumTitle')) $('albumTitle').textContent = cur.album.name;
  const a = cur.album;
  const n = a.count != null ? a.count : cur.items.length;
  const parts = [n + (n === 1 ? ' element' : ' elemente')];
  const range = dateRange(a.firstAt, a.lastAt);
  if (range) parts.push(range);
  if (a.shareToken) parts.push('partajat');
  $('albumSub').textContent = parts.join('  ·  ');
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
  if (FLAT.includes(cur.view)) renderGrid();
  else if (cur.view === 'album') renderAlbum();
  else if (cur.view === 'albums') renderAlbums();
  else if (cur.view === 'shares') renderShares();
}

function observeResize() {
  let t;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      for (const c of [$('grid'), $('albumGrid')]) {
        if (c && c._list && !c.closest('.view').hidden) buildGallery(c, c._list);
      }
    }, 120);
  });
  ro.observe(document.querySelector('.main'));
}

// ─── Favorite ──────────────────────────────────────────────────────────────
async function toggleFav(it, btn) {
  it.favorite = !it.favorite;
  if (btn) btn.classList.toggle('on', it.favorite);
  try {
    await api('/api/media/' + it.id, { method: 'PATCH', body: { favorite: it.favorite } });
  } catch (e) {
    it.favorite = !it.favorite;
    if (btn) btn.classList.toggle('on', it.favorite);
    return toast(e.message);
  }
  const local = media.find((m) => m.id === it.id);
  if (local) local.favorite = it.favorite;
  if (cur.view === 'highlights') renderGrid();
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
  if (n > 0) renderSelActions();
}

function selBtn(icon, title, fn) {
  const b = document.createElement('button');
  b.className = 'icon-btn2';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = '<span class="msi">' + icon + '</span>';
  b.onclick = fn;
  return b;
}

function renderSelActions() {
  const box = $('selActions');
  box.textContent = '';
  const ids = () => [...selected];
  if (cur.view === 'trash') {
    box.appendChild(selBtn('restore_from_trash', 'Restaurează', () => bulk((id) => api('/api/media/' + id + '/restore', { method: 'POST' }), 'Restaurat')));
    box.appendChild(selBtn('delete_forever', 'Șterge definitiv', () => {
      if (!confirm('Ștergi definitiv ' + selected.size + ' elemente?')) return;
      bulk((id) => api('/api/media/' + id, { method: 'DELETE' }), 'Șters definitiv');
    }));
    return;
  }
  if (cur.view === 'archive') {
    box.appendChild(selBtn('unarchive', 'Scoate din arhivă', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: false } }), 'Scos din arhivă')));
  } else {
    box.appendChild(selBtn('add', 'Adaugă în album', (e) => {
      if (!selected.size) return;
      openChooser(e.currentTarget);
    }));
    box.appendChild(selBtn('star', 'Marchează favorite', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { favorite: true } }), 'Adăugat la favorite')));
    box.appendChild(selBtn('inventory_2', 'Arhivează', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: true } }), 'Arhivat')));
  }
  if (cur.view === 'album') {
    box.appendChild(selBtn('remove', 'Scoate din album', async () => {
      try {
        await api('/api/albums/' + cur.albumId + '/items', { method: 'DELETE', body: { ids: ids() } });
        toast('Scos din album');
        await loadAlbum(cur.albumId);
        await loadAlbums();
        clearSel();
        renderAlbum();
      } catch (e) { toast(e.message); }
    }));
  }
  box.appendChild(selBtn('download', 'Descarcă (ZIP)', () => {
    location.href = '/api/download?ids=' + [...selected].join(',');
  }));
  box.appendChild(selBtn('delete', 'Mută în coș', () => bulk((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș')));
}

async function bulk(fn, okMsg) {
  const ids = [...selected];
  for (const id of ids) {
    try { await fn(id); } catch { /* continuă */ }
  }
  toast(okMsg);
  await loadAll();
  await loadAlbums();
  if (cur.view === 'archive') await loadArchive();
  if (cur.view === 'trash') await loadTrash();
  if (cur.view === 'album') await loadAlbum(cur.albumId);
  clearSel();
  rerender();
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

// ─── Partajare (album sau o singură poză) ──────────────────────────────────
let shareCtx = null; // { kind: 'album'|'photo', id, item? }

async function openShareModal(kind, id, item) {
  shareCtx = { kind, id, item: item || null };
  const apiBase = kind === 'album' ? '/api/albums/' + id + '/share' : '/api/media/' + id + '/share';
  const pubPrefix = kind === 'album' ? '/s/' : '/p/';

  let token = kind === 'album'
    ? (cur.album && cur.album.shareToken)
    : (item && item.shareToken);

  if (!token) {
    try {
      const d = await api(apiBase, { method: 'POST' });
      token = d.token;
      if (kind === 'album' && cur.album) cur.album.shareToken = token;
      if (kind === 'photo' && item) item.shareToken = token;
      const local = media.find((m) => m.id === id);
      if (local) local.shareToken = token;
      await loadAlbums();
    } catch (e) { return toast(e.message); }
  }

  $('shareTitle').textContent = kind === 'album' ? 'Partajează albumul' : 'Partajează poza';
  $('shareDesc').textContent = kind === 'album'
    ? 'Oricine are linkul poate vedea toate pozele din album, fără parolă.'
    : 'Oricine are linkul poate vedea această poză, fără parolă.';
  $('shareUrl').value = location.origin + pubPrefix + token;
  $('shareQrWrap').hidden = true;
  $('shareQr').removeAttribute('src');
  $('shareModal').hidden = false;
  if (kind === 'album') renderAlbum();
}

async function revokeShare() {
  if (!shareCtx) return;
  const { kind, id, item } = shareCtx;
  const apiBase = kind === 'album' ? '/api/albums/' + id + '/share' : '/api/media/' + id + '/share';
  try {
    await api(apiBase, { method: 'DELETE' });
    if (kind === 'album' && cur.album) cur.album.shareToken = null;
    if (kind === 'photo' && item) item.shareToken = null;
    const local = media.find((m) => m.id === id);
    if (local) local.shareToken = null;
    await loadAlbums();
    $('shareModal').hidden = true;
    toast('Link dezactivat');
    if (kind === 'album') renderAlbum();
  } catch (e) { toast(e.message); }
}

// ─── Picker ────────────────────────────────────────────────────────────────
const pickerSel = new Set();
function openPicker() {
  pickerSel.clear();
  $('pickerTitle').textContent = 'Alege poze';
  $('pickerConfirm').hidden = false;
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

// ─── Titlu album editabil pe loc ──────────────────────────────────────────
function startTitleEdit() {
  $('albumMenu').hidden = true;
  const h = $('albumTitle');
  h.setAttribute('contenteditable', 'true');
  h.focus();
  const r = document.createRange();
  r.selectNodeContents(h);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// ─── Alegerea copertei albumului ─────────────────────────────────────────
function openCoverPicker() {
  $('albumMenu').hidden = true;
  const grid = $('pickerGrid');
  grid.textContent = '';
  $('pickerTitle').textContent = 'Alege coperta';
  $('pickerConfirm').hidden = true;
  if (!cur.items.length) {
    const p = document.createElement('p');
    p.className = 'picker-empty muted';
    p.textContent = 'Albumul e gol.';
    grid.appendChild(p);
  }
  for (const it of cur.items) {
    const b = document.createElement('button');
    b.className = 'p-tile';
    b.type = 'button';
    if (cur.album && cur.album.coverId === it.id) b.classList.add('sel');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + it.id + '/thumb';
    b.appendChild(img);
    b.onclick = async () => {
      try {
        const a = await api('/api/albums/' + cur.albumId, { method: 'PATCH', body: { coverId: it.id } });
        cur.album = a;
        await loadAlbums();
        $('pickerModal').hidden = true;
        toast('Copertă setată');
      } catch (e) { toast(e.message); }
    };
    grid.appendChild(b);
  }
  $('pickerCount').textContent = '';
  $('pickerModal').hidden = false;
}

// ─── Lightbox ──────────────────────────────────────────────────────────────
const lb = $('lightbox');
const lbStage = $('lbStage');
const lbDl = $('lbDownload');
const lbStrip = $('lbStrip');

function sizeStr(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function openLightbox(list, id) {
  lbList = list;
  lbIndex = list.findIndex((x) => x.id === id);
  if (lbIndex < 0) return;
  lb.hidden = false;
  document.body.classList.add('no-scroll');
  renderStrip();
  showLb();
}

function closeLightbox() {
  resetZoom();
  stopSlideshow();
  lb.hidden = true;
  lb.classList.remove('has-info');
  $('lbInfo').hidden = true;
  lbStage.textContent = '';
  document.body.classList.remove('no-scroll');
}

let zoom = { s: 1, x: 0, y: 0 };
function zoomImg() { return lbStage.querySelector('img'); }
function applyZoom() {
  const im = zoomImg();
  if (!im) return;
  im.style.transform = 'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.s + ')';
  lbStage.classList.toggle('zoomed', zoom.s > 1.01);
}
function resetZoom() { zoom = { s: 1, x: 0, y: 0 }; lbStage.classList.remove('zoomed', 'grabbing'); const im = zoomImg(); if (im) im.style.transform = ''; }
function zoomAt(factor, cx, cy) {
  const im = zoomImg();
  if (!im) return;
  const r = lbStage.getBoundingClientRect();
  const ox = cx - r.left - r.width / 2;
  const oy = cy - r.top - r.height / 2;
  const ns = Math.max(1, Math.min(6, zoom.s * factor));
  const k = ns / zoom.s;
  zoom.x = ox - (ox - zoom.x) * k;
  zoom.y = oy - (oy - zoom.y) * k;
  zoom.s = ns;
  if (zoom.s === 1) { zoom.x = 0; zoom.y = 0; }
  applyZoom();
}
function initLightboxZoom() {
  const pts = new Map();
  let lastDist = 0;
  lbStage.addEventListener('wheel', (e) => {
    if (!zoomImg()) return;
    e.preventDefault();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });
  lbStage.addEventListener('dblclick', (e) => {
    if (!zoomImg()) return;
    if (zoom.s > 1.01) resetZoom();
    else zoomAt(2.5, e.clientX, e.clientY);
  });
  lbStage.addEventListener('pointerdown', (e) => {
    if (!zoomImg()) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1 && zoom.s > 1.01) { lbStage.classList.add('grabbing'); lbStage.setPointerCapture(e.pointerId); }
  });
  lbStage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const p = [...pts.values()];
      const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (lastDist) zoomAt(dist / lastDist, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
      lastDist = dist;
    } else if (pts.size === 1 && zoom.s > 1.01) {
      zoom.x += dx; zoom.y += dy; applyZoom();
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) lastDist = 0;
    if (pts.size === 0) lbStage.classList.remove('grabbing');
  };
  lbStage.addEventListener('pointerup', up);
  lbStage.addEventListener('pointercancel', up);
}

function showLb() {
  const it = lbList[lbIndex];
  lbStage.textContent = '';
  resetZoom();
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

  const trash = cur.view === 'trash';
  lb.querySelector('.lb-fav').hidden = trash;
  lb.querySelector('.lb-archive').hidden = trash;
  lb.querySelector('.lb-del').hidden = trash;
  lb.querySelector('.lb-slideshow').hidden = trash;
  lb.querySelector('.lb-share').hidden = trash;
  lb.querySelector('.lb-restore').hidden = !trash;
  lb.querySelector('.lb-purge').hidden = !trash;
  lb.querySelector('.lb-fav').classList.toggle('on', !!it.favorite);
  lb.querySelector('.lb-share').classList.toggle('on', !!it.shareToken);

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

  const ta = document.createElement('textarea');
  ta.placeholder = 'Adaugă o descriere…';
  ta.value = it.caption || '';
  ta.addEventListener('change', async () => {
    it.caption = ta.value;
    try { await api('/api/media/' + it.id, { method: 'PATCH', body: { caption: ta.value } }); }
    catch (e) { toast(e.message); }
    const local = media.find((m) => m.id === it.id);
    if (local) local.caption = ta.value;
  });
  body.appendChild(ta);

  const rows = [];
  if (it.originalName) rows.push(['image', it.originalName]);
  if (it.width && it.height) rows.push(['straighten', it.width + ' × ' + it.height + '  ·  ' + (it.width * it.height / 1e6).toFixed(1) + ' MP']);
  if (it.size) rows.push(['sd_card', sizeStr(it.size)]);
  rows.push([it.type === 'video' ? 'movie' : 'photo_camera', it.type === 'video' ? 'Videoclip' : 'Fotografie']);
  if (it.favorite) rows.push(['star', 'La favorite']);
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

async function lbFav() {
  const it = lbList[lbIndex];
  if (!it) return;
  await toggleFav(it, null);
  lb.querySelector('.lb-fav').classList.toggle('on', !!it.favorite);
  if (!$('lbInfo').hidden) renderInfo();
}

async function lbMutate(fn, msg, removeFromList) {
  const it = lbList[lbIndex];
  if (!it) return;
  try { await fn(it.id); } catch (e) { return toast(e.message); }
  toast(msg);
  await loadAll();
  await loadAlbums();
  if (cur.view === 'archive') await loadArchive();
  if (cur.view === 'trash') await loadTrash();
  if (cur.view === 'album') { await loadAlbum(cur.albumId); lbList = cur.items; }
  else if (removeFromList) { lbList.splice(lbIndex, 1); }
  rerender();
  if (!lbList.length) return closeLightbox();
  lbIndex = Math.min(lbIndex, lbList.length - 1);
  renderStrip();
  showLb();
}

// ─── Slideshow ─────────────────────────────────────────────────────────────
function toggleSlideshow() {
  if (slideTimer) return stopSlideshow();
  slideTimer = setInterval(() => stepLb(1), 3500);
  const i = lb.querySelector('.lb-slideshow .msi');
  if (i) i.textContent = 'pause';
}
function stopSlideshow() {
  if (!slideTimer) return;
  clearInterval(slideTimer);
  slideTimer = null;
  const i = lb.querySelector('.lb-slideshow .msi');
  if (i) i.textContent = 'play_arrow';
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
    $('uploadTitle').textContent = 'Se încarcă ' + (i + 1) + '/' + files.length + '…';
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
  $('uploadTitle').textContent = 'Gata — ' + ok + '/' + files.length + ' încărcate';
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

window.__cloudUpload = (files) => uploadFiles([...files]);

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
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); setTheme(b.dataset.theme); };
  });
  $('logoutBtn').onclick = async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } }); } catch {}
    location.replace('/login');
  };

  $('densityBtn').onclick = () => {
    density = density === 'm' ? 'l' : density === 'l' ? 's' : 'm';
    try { localStorage.setItem('density', density); } catch {}
    rerender();
  };
  $('helpBtn').onclick = () => { $('helpModal').hidden = false; };
  $('helpClose').onclick = () => { $('helpModal').hidden = true; };

  $('search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    $('searchClear').hidden = !query;
    if (FLAT.includes(cur.view)) renderGrid();
  });
  $('searchClear').onclick = () => {
    $('search').value = ''; query = ''; $('searchClear').hidden = true;
    if (FLAT.includes(cur.view)) renderGrid();
  };

  const fileInput = $('fileInput');
  $('uploadBtn').onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });
  $('uploadClose').onclick = () => { $('uploadTray').hidden = true; $('uploadList').textContent = ''; };

  $('emptyTrashBtn').onclick = async () => {
    if (!confirm('Golești coșul? Toate elementele se șterg definitiv.')) return;
    try {
      await api('/api/trash/empty', { method: 'POST' });
      await loadTrash();
      await loadAll();
      renderGrid();
      toast('Coș golit');
    } catch (e) { toast(e.message); }
  };

  $('selCancel').onclick = clearSel;

  $('chooserNew').onclick = async () => {
    const name = prompt('Nume album nou');
    if (!name || !name.trim()) return;
    try {
      const a = await api('/api/albums', { method: 'POST', body: { name: name.trim() } });
      await addToAlbum(a.id, [...selected]);
      closeChooser();
    } catch (e) { toast(e.message); }
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
  $('albumShare').onclick = () => openShareModal('album', cur.albumId);

  // meniul ⋮ al albumului
  $('albumMenuBtn').onclick = (e) => { e.stopPropagation(); $('albumMenu').hidden = !$('albumMenu').hidden; };
  document.addEventListener('click', () => { $('albumMenu').hidden = true; });
  $('albumCoverBtn').onclick = () => openCoverPicker();
  $('albumRename').onclick = () => startTitleEdit();
  $('albumDelete').onclick = async () => {
    if (!confirm('Ștergi albumul „' + cur.album.name + '”? Pozele rămân în galerie.')) return;
    try {
      await api('/api/albums/' + cur.albumId, { method: 'DELETE' });
      await loadAlbums();
      location.hash = '#/albums';
    } catch (e) { toast(e.message); }
  };

  // titlu editabil pe loc (stil Google Photos)
  const title = $('albumTitle');
  title.addEventListener('click', startTitleEdit);
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    else if (e.key === 'Escape') { title.textContent = cur.album ? cur.album.name : ''; title.blur(); }
  });
  title.addEventListener('blur', async () => {
    title.removeAttribute('contenteditable');
    if (!cur.album) return;
    const name = title.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name || name === cur.album.name) { title.textContent = cur.album.name; return; }
    try {
      const a = await api('/api/albums/' + cur.albumId, { method: 'PATCH', body: { name } });
      cur.album = a;
      await loadAlbums();
      renderAlbum();
      toast('Titlu salvat');
    } catch (e) { title.textContent = cur.album.name; toast(e.message); }
  });

  $('shareCopy').onclick = async () => {
    const v = $('shareUrl').value;
    try { await navigator.clipboard.writeText(v); toast('Link copiat'); }
    catch {
      $('shareUrl').select();
      try { document.execCommand('copy'); toast('Link copiat'); } catch { toast('Copiază manual'); }
    }
  };
  $('shareRevoke').onclick = () => {
    if (!confirm('Dezactivezi linkul? Nu va mai funcționa pentru nimeni.')) return;
    revokeShare();
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
    else if (act === 'prev') { stopSlideshow(); stepLb(-1); }
    else if (act === 'next') { stopSlideshow(); stepLb(1); }
    else if (act === 'info') toggleInfo();
    else if (act === 'fav') lbFav();
    else if (act === 'slideshow') toggleSlideshow();
    else if (act === 'share') { const it = lbList[lbIndex]; if (it) openShareModal('photo', it.id, it); }
    else if (act === 'archive') lbMutate((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: true } }), 'Arhivat', true);
    else if (act === 'trash') lbMutate((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', true);
    else if (act === 'restore') lbMutate((id) => api('/api/media/' + id + '/restore', { method: 'POST' }), 'Restaurat', true);
    else if (act === 'purge') {
      if (confirm('Ștergi definitiv acest fișier?')) lbMutate((id) => api('/api/media/' + id, { method: 'DELETE' }), 'Șters definitiv', true);
    } else if (e.target === lb || e.target === lbStage) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    // Modalele au prioritate, chiar și peste lightbox
    if (e.key === 'Escape') {
      if (!$('helpModal').hidden) { $('helpModal').hidden = true; return; }
      if (!$('shareModal').hidden) { $('shareModal').hidden = true; return; }
      if (!$('pickerModal').hidden) { $('pickerModal').hidden = true; return; }
    }
    if (!lb.hidden) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') { stopSlideshow(); stepLb(-1); }
      else if (e.key === 'ArrowRight') { stopSlideshow(); stepLb(1); }
      else if (e.key === 'i') toggleInfo();
      else if (e.key === 'f' && cur.view !== 'trash') lbFav();
      else if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && cur.view !== 'trash') {
        lbMutate((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', true);
      }
      return;
    }
    if (e.key === '?') { $('helpModal').hidden = false; return; }
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

  // filtre (chips)
  document.querySelectorAll('.chip[data-type]').forEach((b) => {
    b.onclick = () => { filterType = b.dataset.type; renderGrid(); };
  });
  $('chipFav').onclick = () => { filterFav = !filterFav; renderGrid(); };
  $('chipYear').onchange = (e) => { filterYear = e.target.value; renderGrid(); };

  // cod QR în fereastra de partajare
  $('shareQrBtn').onclick = () => {
    const w = $('shareQrWrap');
    if (w.hidden) {
      $('shareQr').src = '/qr?data=' + encodeURIComponent($('shareUrl').value);
      w.hidden = false;
    } else {
      w.hidden = true;
    }
  };

  initLightboxZoom();

  // ─── Import Google Takeout ───────────────────────────────────────────────
  let importTimer = null;
  const stopPoll = () => { if (importTimer) { clearInterval(importTimer); importTimer = null; } };
  $('importBtn').onclick = (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    $('importProgress').hidden = true;
    $('importFile').value = '';
    $('importStart').disabled = false;
    $('importModal').hidden = false;
  };
  $('importClose').onclick = () => { stopPoll(); $('importModal').hidden = true; };
  $('importStart').onclick = () => {
    const file = $('importFile').files[0];
    if (!file) return toast('Alege un fișier .zip');
    $('importStart').disabled = true;
    $('importProgress').hidden = false;
    $('importBar').style.width = '0%';
    $('importStat').textContent = 'Se încarcă arhiva…';

    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/takeout');
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable) $('importBar').style.width = (ev.loaded / ev.total * 40).toFixed(1) + '%';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) return location.replace('/login');
      let jobId;
      try { jobId = JSON.parse(xhr.responseText).jobId; } catch {}
      if (!jobId) { $('importStat').textContent = 'Eroare la pornirea importului'; $('importStart').disabled = false; return; }
      pollImport(jobId);
    });
    xhr.addEventListener('error', () => { $('importStat').textContent = 'Eroare de rețea'; $('importStart').disabled = false; });
    xhr.send(fd);
  };

  function pollImport(jobId) {
    stopPoll();
    importTimer = setInterval(async () => {
      let j;
      try { j = await api('/api/import/status/' + jobId); } catch { return; }
      const PH = { starting: 'Se pregătește…', reading: 'Se citește arhiva…', importing: 'Se importă', albums: 'Se refac albumele…', done: 'Gata', error: 'Eroare' };
      const pct = j.total ? 40 + (j.done / j.total) * 60 : (j.phase === 'done' ? 100 : 45);
      $('importBar').style.width = Math.min(100, pct).toFixed(1) + '%';
      const bits = [PH[j.phase] || j.phase];
      if (j.total) bits.push(j.done + '/' + j.total);
      if (j.added) bits.push('+' + j.added);
      if (j.duplicates) bits.push(j.duplicates + ' dubluri');
      if (j.albums) bits.push(j.albums + ' albume');
      $('importStat').textContent = bits.join('  ·  ');
      if (j.phase === 'done' || j.phase === 'error') {
        stopPoll();
        $('importStart').disabled = false;
        toast(j.phase === 'done'
          ? ('Import gata: +' + j.added + (j.duplicates ? ', ' + j.duplicates + ' dubluri' : '') + (j.albums ? ', ' + j.albums + ' albume' : ''))
          : 'Import cu erori');
        await loadAll(); await loadAlbums();
        if (cur.view === 'album') await loadAlbum(cur.albumId);
        rerender();
      }
    }, 1500);
  }
}
