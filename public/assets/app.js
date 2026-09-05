'use strict';

const $ = (id) => document.getElementById(id);
const FLAT = ['all', 'highlights', 'archive', 'trash', 'locked'];
const TITLES = { all: 'Poze', highlights: 'Favorite', archive: 'Arhivă', trash: 'Coș', locked: 'Folder blocat' };
const EMPTY = {
  all: 'Nicio poză încă.',
  highlights: 'Nicio favorită. Apasă ⭐ pe o poză.',
  archive: 'Arhiva e goală.',
  trash: 'Coșul e gol.',
  locked: 'Folderul blocat e gol. Mută aici poze din selecție.',
};
// Niveluri de zoom pe grilă (ca la Google Photos): mare → confortabil → compact → mic
const ZOOM = [
  { rowH: 340, group: 'day' },
  { rowH: 210, group: 'day' },
  { rowH: 124, group: 'month' },
  { rowH: 70, group: 'month', bare: true },
  { rowH: 46, group: 'year', bare: true },
];
const ZOOM_LABEL = ['Mare', 'Confortabil', 'Compact', 'Mic', 'An'];

let csrf = '';
let media = [];
let archiveList = [];
let trashList = [];
let lockedList = [];
let lockOpen = false;
let lockConfigured = false;
let searchResults = null;
let searchSeq = 0;
let searchT = null;
let albums = [];
let memories = [];
let events = [];
let stats = null;
let isAdmin = false;
let me = null;
let query = '';
let filterType = 'all';
let filterFav = false;
let filterYear = '';
let filterCat = ''; // '', 'screenshots', 'selfies', 'geo'
let gridZoom = 1;
let lastSelId = null; // pentru selecție cu Shift pe interval
let placesMap = null;
let placesLayer = null;
let cur = { view: 'all', albumId: null, album: null, items: [] };

const selected = new Set();
let lbList = [];
let lbIndex = -1;
let slideTimer = null;

// ─── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const z = localStorage.getItem('gridZoom');
    if (z != null) gridZoom = Math.max(0, Math.min(4, parseInt(z, 10) || 0));
    else { const d = localStorage.getItem('density'); gridZoom = d === 'l' ? 0 : d === 's' ? 2 : 1; }
  } catch {}
  try {
    const r = await fetch('/api/csrf');
    if (r.status === 401) return location.replace('/login');
    const info = await r.json();
    csrf = info.token;
    isAdmin = info.role === 'admin';
    me = info.user || null;
  } catch {
    return location.replace('/login');
  }
  markThemeMenu(currentThemeMode());
  updateThemeColor();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColor);
  window.addEventListener('hashchange', route);
  wire();
  observeResize();
  applyRole();
  try {
    await Promise.all([loadAll(), loadAlbums()]);
  } catch { /* api() a redirecționat la 401 */ }
  route();
  pollSharesBadge();
  setInterval(pollSharesBadge, 3 * 60 * 1000);
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
  loadStats();
  try { memories = await api('/api/memories'); } catch { memories = []; }
  try { events = await api('/api/events/suggestions'); } catch { events = []; }
}
async function loadArchive() { archiveList = await api('/api/media?filter=archive'); }
async function loadTrash() { trashList = await api('/api/media?filter=trash'); }
async function loadAlbums() { albums = await api('/api/albums'); }
async function loadAlbum(id) {
  const d = await api('/api/albums/' + encodeURIComponent(id));
  cur.album = d.album;
  cur.items = d.items;
}

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB';
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}
async function loadStats() {
  try { stats = await api('/api/stats'); } catch { stats = null; }
  updateStorage();
}
function updateStorage() {
  if (!$('storageText')) return;
  const used = stats ? stats.usedBytes : media.reduce((s, m) => s + (m.size || 0), 0);
  const total = stats ? stats.totalBytes : 0;
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const tier = pct > 90 ? 'full' : pct > 70 ? 'warn' : '';

  $('storagePct').textContent = Math.round(pct) + '% folosit';
  $('storagePct').classList.toggle('warn', tier === 'warn');
  $('storagePct').classList.toggle('full', tier === 'full');
  $('storageText').textContent = fmtBytes(used) + (total ? ' din ' + fmtBytes(total) : ' folosiți');

  $('storageFill').style.width = Math.max(1.5, pct || 4) + '%';
  $('storageFill').classList.toggle('warn', tier === 'warn');
  $('storageFill').classList.toggle('full', tier === 'full');
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

function applyRole() {
  document.body.classList.toggle('is-admin', isAdmin);
  const hide = (id, cond) => { const e = document.getElementById(id); if (e) e.hidden = cond; };
  const tl = document.querySelector('.side-link[data-view="trash"]');
  if (tl) tl.hidden = !isAdmin;
  hide('optimizeBtn', !isAdmin);
  hide('indexBtn', !isAdmin);
  hide('facesBtn', !isAdmin);
  hide('retagBtn', !isAdmin);
  hide('dupBtn', !isAdmin);
  hide('cleanupBtn', !isAdmin);
  hide('healthBtn', !isAdmin);
  hide('albumDelete', !isAdmin);
  hide('importBtn', !isAdmin);
  hide('logoutBtn', !(isAdmin || me));
  hide('adminLoginBtn', !!me);
  hide('accountBtn', !me);
  const who = document.getElementById('acctWho');
  if (who) { who.hidden = !me; who.textContent = me ? me.displayName : ''; }
  const av = document.getElementById('acctBtn');
  if (av) {
    if (me) {
      av.innerHTML = '<img src="' + me.avatar + '" alt="">';
      av.title = me.displayName;
    } else {
      av.textContent = isAdmin ? 'A' : 'C';
      av.title = isAdmin ? 'Administrator' : 'Vizitator';
    }
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────
function route() {
  clearSel();
  stopSlideshow();
  if (!lb.hidden) closeLightbox();
  const h = location.hash.replace(/^#/, '');
  if (cur.view === 'locked' && h !== '/locked' && lockOpen) closeLock(true);
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
  } else if (h === '/places') {
    cur.view = 'places';
    showView();
    renderPlaces();
  } else if (h === '/people') {
    cur.view = 'people'; cur.personId = null;
    showView();
    renderPeople();
  } else if (h === '/things') {
    cur.view = 'things'; cur.thingTag = null;
    showView();
    renderThings();
  } else if (/^\/thing\/.+/.test(h)) {
    cur.view = 'things'; cur.thingTag = decodeURIComponent(h.slice('/thing/'.length));
    showView();
    renderThing();
  } else if (/^\/person\/[0-9a-f-]{36}$/i.test(h)) {
    cur.view = 'people'; cur.personId = h.split('/')[2];
    showView();
    renderPerson();
  } else if (h === '/highlights') {
    cur.view = 'highlights'; showView(); renderGrid();
  } else if (h === '/archive') {
    cur.view = 'archive'; showView(); loadArchive().then(renderGrid);
  } else if (h === '/trash') {
    if (!isAdmin) { location.hash = '#/'; return; }
    cur.view = 'trash'; showView(); loadTrash().then(renderGrid);
  } else if (h === '/locked') {
    enterLocked();
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
  $('viewPlaces').hidden = cur.view !== 'places';
  $('viewPeople').hidden = cur.view !== 'people';
  $('viewThings').hidden = cur.view !== 'things';
  if (railEl && !FLAT.includes(cur.view)) railEl.hidden = true;
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

function groupBy(list, by) {
  const groups = new Map();
  const n = by === 'year' ? 4 : by === 'month' ? 7 : 10;
  for (const it of list) {
    const k = (it.takenAt || it.createdAt).slice(0, n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return groups;
}

function monthLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  return cap(d.toLocaleDateString('ro-RO', d.getFullYear() === now.getFullYear()
    ? { month: 'long' } : { month: 'long', year: 'numeric' }));
}

// ─── Layout justified ──────────────────────────────────────────────────────
const GAP = 4;
const targetRowH = () => {
  const base = (ZOOM[gridZoom] || ZOOM[1]).rowH;
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

function buildGallery(container, list, opts) {
  const flat = opts && opts.flat;
  container._list = list;
  // virtualizare: uită plăcuțele vechi
  container.querySelectorAll('.j-tile').forEach((b) => tileObs.unobserve(b));
  loadedTiles.clear();
  container.textContent = '';
  container.dataset.zoom = String(gridZoom);
  const width = contentWidth(container);
  const th = targetRowH();

  const z = ZOOM[gridZoom] || ZOOM[1];
  const frag = document.createDocumentFragment();
  const groups = flat ? [['', list]] : [...groupBy(list, z.group)];
  for (const [, items] of groups) {
    if (!items.length) continue;
    const day = document.createElement('section');
    day.className = 'j-day';
    day.dataset.date = items[0].takenAt || items[0].createdAt;
    if (!flat) day.appendChild(dayHead(items[0].takenAt || items[0].createdAt, items.map((x) => x.id), z.group));
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

function dayHead(dateIso, ids, by) {
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
  lbl.textContent = by === 'year' ? new Date(dateIso).getFullYear() : by === 'month' ? monthLabel(dateIso) : dayLabel(dateIso);
  wrap.appendChild(chk);
  wrap.appendChild(lbl);
  return wrap;
}

// Observator pentru virtualizarea imaginilor din grilă: atașează <img> când
// plăcuța se apropie de ecran, îl scoate când e departe (limitează memoria).
const loadedTiles = new Set();
const tileObs = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const b = en.target;
    if (en.isIntersecting) {
      if (!b.querySelector('img')) {
        const img = document.createElement('img');
        img.decoding = 'async';
        img.src = '/media/' + b.dataset.id + '/thumb';
        img.alt = b._name || '';
        b.insertBefore(img, b.firstChild);
        loadedTiles.add(b);
      }
    }
  }
  // cap: dacă avem prea multe imagini încărcate, scoate-le pe cele departe de ecran
  if (loadedTiles.size > 1400) {
    const vh = window.innerHeight;
    for (const b of loadedTiles) {
      const r = b.getBoundingClientRect();
      if (r.bottom < -2500 || r.top > vh + 2500) {
        const im = b.querySelector('img');
        if (im) im.remove();
        loadedTiles.delete(b);
      }
    }
  }
}, { rootMargin: '900px 0px' });

function jtile(cell) {
  const it = cell.it;
  const b = document.createElement('button');
  b.className = 'j-tile';
  b.type = 'button';
  b.dataset.id = it.id;
  b.style.width = cell.w + 'px';
  b.style.height = cell.h + 'px';
  if (selected.has(it.id)) b.classList.add('sel');

  // imaginea se atașează doar când plăcuța se apropie de ecran (virtualizare)
  b._name = it.originalName || '';
  if (it.type === 'video') {
    const s = document.createElement('span');
    s.className = 'play-badge';
    s.textContent = '▶';
    b.appendChild(s);
  } else if (it.liveVideoId) {
    const s = document.createElement('span');
    s.className = 'live-badge';
    s.innerHTML = '<span class="msi">motion_photos_on</span>';
    b.appendChild(s);
  }
  tileObs.observe(b);

  const chk = document.createElement('span');
  chk.className = 'chk';
  chk.addEventListener('click', (e) => { e.stopPropagation(); pickTile(it.id, e.shiftKey); });
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

  b.addEventListener('click', (e) => {
    if (selected.size > 0 || e.shiftKey) pickTile(it.id, e.shiftKey);
    else openLightbox(gridData(), it.id);
  });
  return b;
}

// Click pe bifă / cu Shift: selecție simplă sau pe interval (ordinea din grilă)
function pickTile(id, shift) {
  const order = gridData().map((x) => x.id);
  if (shift && lastSelId && order.includes(lastSelId) && order.includes(id)) {
    let a = order.indexOf(lastSelId), b = order.indexOf(id);
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) selected.add(order[i]);
    document.querySelectorAll('.j-tile').forEach((el) => {
      if (selected.has(el.dataset.id)) el.classList.add('sel');
    });
    syncDayChecks();
    updateSelBar();
  } else {
    toggleSelect(id);
  }
  lastSelId = id;
}

function isSearching() {
  return !!(query && query.length >= 2 && searchResults &&
    (cur.view === 'all' || cur.view === 'highlights' || cur.view === 'archive'));
}

let searchPending = false;
function scheduleServerSearch(q) {
  clearTimeout(searchT);
  const seq = ++searchSeq;
  searchT = setTimeout(async () => {
    searchPending = true;
    if (FLAT.includes(cur.view)) renderGrid();
    try {
      const rows = await api('/api/search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      searchResults = rows;
    } catch { /* rămâne filtrarea locală */ }
    finally { if (seq === searchSeq) searchPending = false; }
    if (FLAT.includes(cur.view)) renderGrid();
  }, 320);
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
    if (filterCat === 'screenshots' && m.kindAuto !== 'screenshot') return false;
    if (filterCat === 'selfies' && m.kindAuto !== 'selfie') return false;
    if (filterCat === 'geo' && !m.hasGeo) return false;
    if (filterYear && String(new Date(m.takenAt || m.createdAt).getFullYear()) !== filterYear) return false;
    return true;
  });
}

function gridData() {
  if (cur.view === 'people') return cur.personId ? (cur.items || []) : [];
  if (cur.view === 'things') return cur.thingTag ? (cur.items || []) : [];
  if (cur.view === 'album') return applySearch(cur.items);
  if (cur.view === 'trash') return applySearch(trashList);
  if (cur.view === 'locked') return applySearch(lockedList);
  // căutare inteligentă pe server (semantic + OCR) pentru vizualizările globale
  if (query && query.length >= 2 && searchResults && (cur.view === 'all' || cur.view === 'highlights' || cur.view === 'archive')) {
    return searchResults;
  }
  let base;
  if (cur.view === 'highlights') base = media.filter((m) => m.favorite);
  else if (cur.view === 'archive') base = archiveList;
  else base = media;
  return applyFilters(applySearch(base));
}

// ─── Randare ───────────────────────────────────────────────────────────────
function renderGrid() {
  const list = gridData();
  const searching = isSearching();
  $('gridTitle').textContent = searching ? 'Rezultate: „' + query + '”' : (TITLES[cur.view] || 'Poze');
  $('emptyTrashBtn').hidden = cur.view !== 'trash' || trashList.length === 0;
  $('trashNote').hidden = cur.view !== 'trash';
  if ($('lockCloseBtn')) $('lockCloseBtn').hidden = cur.view !== 'locked';
  renderChips();
  renderMemories();
  renderEvents();
  buildGallery($('grid'), list, { flat: searching });
  populateJump(searching ? [] : list);
  const waiting = !!(query && query.length >= 2 && searchPending);
  $('gridEmpty').hidden = list.length > 0;
  $('gridEmptyText').textContent = (waiting && !list.length) ? 'Se caută…'
    : searching ? 'Niciun rezultat.' : (EMPTY[cur.view] || 'Gol.');
  buildTimeRail(searching ? 0 : list.length);
}

function populateJump(list) {
  const sel = $('jumpSel');
  if (!sel) return;
  const months = [...new Set(list.map((m) => (m.takenAt || m.createdAt).slice(0, 7)))].sort().reverse();
  const show = months.length > 3;
  sel.hidden = !show;
  if (!show) return;
  const want = '<option value="">Sari la…</option>' + months.map((k) => {
    const d = new Date(k + '-01');
    return '<option value="' + k + '">' + cap(d.toLocaleDateString('ro-RO', { month: 'long', year: 'numeric' })) + '</option>';
  }).join('');
  if (sel.dataset.built !== want) { sel.innerHTML = want; sel.dataset.built = want; }
}

// ─── Rail de dată (fast-scroll, stil Google Photos) ────────────────────────
let railEl = null, railBubble = null, railDragging = false;
// body e scroller-ul real (overflow-x:hidden + height:100% pe body)
const SCROLLER = document.body;
function docHeight() { return SCROLLER.scrollHeight; }
function scrollPos() { return SCROLLER.scrollTop; }
function scrollToY(y) { SCROLLER.scrollTop = y; }
function ensureRail() {
  if (railEl) return;
  railEl = document.createElement('div');
  railEl.className = 'time-rail';
  railEl.hidden = true;
  railBubble = document.createElement('div');
  railBubble.className = 'tr-bubble';
  railBubble.hidden = true;
  document.body.appendChild(railEl);
  document.body.appendChild(railBubble);

  const jump = (clientY) => {
    const r = railEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    const max = docHeight() - SCROLLER.clientHeight;
    scrollToY(f * max);
    showBubble(clientY, f);
  };
  railEl.addEventListener('pointerdown', (e) => {
    railDragging = true;
    try { railEl.setPointerCapture(e.pointerId); } catch {}
    railEl.classList.add('drag');
    jump(e.clientY);
  });
  railEl.addEventListener('pointermove', (e) => { if (railDragging) jump(e.clientY); });
  const end = (e) => {
    if (!railDragging) return;
    railDragging = false;
    railEl.classList.remove('drag');
    railBubble.hidden = true;
    try { railEl.releasePointerCapture(e.pointerId); } catch {}
  };
  railEl.addEventListener('pointerup', end);
  railEl.addEventListener('pointercancel', end);

  let raf = 0;
  window.addEventListener('scroll', () => {
    if (railEl.hidden || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const max = docHeight() - SCROLLER.clientHeight;
      const f = max > 0 ? scrollPos() / max : 0;
      const dot = railEl.querySelector('.tr-dot');
      if (dot) dot.style.top = (f * 100) + '%';
      railEl.classList.add('active');
      clearTimeout(railEl._fade);
      railEl._fade = setTimeout(() => railEl.classList.remove('active'), 900);
    });
  }, { passive: true, capture: true });
}

function showBubble(clientY, f) {
  const ticks = railEl._ticks || [];
  if (!ticks.length) return;
  let best = ticks[0];
  for (const t of ticks) if (Math.abs(t.f - f) < Math.abs(best.f - f)) best = t;
  railBubble.textContent = best.label;
  railBubble.hidden = false;
  const r = railEl.getBoundingClientRect();
  railBubble.style.top = Math.max(8, Math.min(window.innerHeight - 34, clientY - 14)) + 'px';
  railBubble.style.right = (window.innerWidth - r.left + 8) + 'px';
}

function buildTimeRail(count) {
  ensureRail();
  const grid = $('grid');
  const show = FLAT.includes(cur.view) && count >= 40 && !grid.closest('.view').hidden;
  railEl.hidden = !show;
  if (!show) return;

  const scrollH = docHeight();
  const days = [...grid.querySelectorAll('.j-day')];
  const now = new Date();
  const raw = days.map((el) => {
    const top = el.getBoundingClientRect().top + scrollPos();
    const d = new Date(el.dataset.date || Date.now());
    return { f: top / scrollH, y: d.getFullYear(), m: d.getMonth(), d };
  });
  // Câți ani acoperă? Multe -> etichetăm pe an; altfel pe lună.
  const years = new Set(raw.map((r) => r.y));
  const byYear = years.size > 4;
  const ticks = [];
  let last = '';
  for (const r of raw) {
    const key = byYear ? String(r.y) : (r.y + '-' + r.m);
    if (key === last) continue;
    last = key;
    const label = byYear ? String(r.y)
      : cap(r.d.toLocaleDateString('ro-RO', r.y === now.getFullYear() ? { month: 'short' } : { month: 'short', year: 'numeric' }));
    ticks.push({ f: r.f, label });
  }
  railEl._ticks = ticks;

  railEl.textContent = '';
  const dot = document.createElement('div');
  dot.className = 'tr-dot';
  railEl.appendChild(dot);

  // Afișează etichete doar dacă sunt la cel puțin 20px una de alta (fără suprapunere).
  const railH = railEl.getBoundingClientRect().height || 600;
  let lastY = -999;
  for (const t of ticks) {
    const y = t.f * railH;
    if (y - lastY < 20) continue;
    lastY = y;
    const s = document.createElement('span');
    s.className = 'tr-tick';
    s.style.top = (t.f * 100) + '%';
    s.textContent = t.label;
    railEl.appendChild(s);
  }
}

function renderChips() {
  const show = !isSearching() && (cur.view === 'all' || cur.view === 'highlights' || cur.view === 'archive');
  $('chips').hidden = !show;
  if (!show) return;
  document.querySelectorAll('.chip[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === filterType));
  document.querySelectorAll('.chip[data-cat]').forEach((b) => b.classList.toggle('on', b.dataset.cat === filterCat));
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

function dismissedEvents() {
  try { return JSON.parse(localStorage.getItem('dismissedEvents') || '[]'); } catch { return []; }
}
function renderEvents() {
  const strip = $('eventsStrip');
  if (!strip) return;
  const dismissed = new Set(dismissedEvents());
  const list = (events || []).filter((e) => !dismissed.has(e.date));
  const show = cur.view === 'all' && !query && list.length > 0;
  strip.hidden = !show;
  if (!show) return;
  strip.textContent = '';
  for (const ev of list) {
    const c = document.createElement('div');
    c.className = 'evt-card';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = '/media/' + ev.items[0].id + '/thumb';
    c.appendChild(img);
    const dismiss = document.createElement('button');
    dismiss.className = 'evt-dismiss';
    dismiss.type = 'button';
    dismiss.title = 'Ascunde';
    dismiss.innerHTML = '<span class="msi">close</span>';
    dismiss.onclick = (e) => {
      e.stopPropagation();
      const d = dismissedEvents();
      d.push(ev.date);
      localStorage.setItem('dismissedEvents', JSON.stringify(d));
      renderEvents();
    };
    c.appendChild(dismiss);
    const capBox = document.createElement('div');
    capBox.className = 'evt-cap';
    const dateLbl = cap(new Date(ev.date + 'T12:00:00').toLocaleDateString('ro-RO', { day: 'numeric', month: 'long' }));
    capBox.innerHTML = '<span class="evt-title">' + dateLbl + '</span><span class="evt-sub">' + ev.count + ' poze</span>'
      + '<button class="evt-make" type="button"><span class="msi">movie</span>Creează film</button>';
    capBox.querySelector('.evt-make').onclick = (e) => {
      e.stopPropagation();
      for (const it of ev.items) if (!media.find((m) => m.id === it.id)) media.push(it);
      openSlideshow(ev.items.map((it) => it.id));
    };
    c.appendChild(capBox);
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
  const oc = $('albumOwner');
  if (oc) {
    if (a.owner && a.owner.name) {
      oc.hidden = false;
      oc.innerHTML = (a.owner.avatar ? '<img src="' + a.owner.avatar + '" alt="">' : '<span class="msi">person</span>')
        + '<span>de la <b>' + escapeHtml(a.owner.name) + '</b></span>';
    } else oc.hidden = true;
  }
  const ct = $('albumCommentsToggle'), cc = $('albumContribToggle');
  if (ct) ct.classList.toggle('on', a.allowComments !== false);
  if (cc) cc.classList.toggle('on', !!a.allowContrib);
  buildGallery($('albumGrid'), cur.items);
  $('albumEmpty').hidden = cur.items.length > 0;
}

async function toggleAlbumFlag(key) {
  if (!cur.album) return;
  const val = key === 'allowComments' ? !(cur.album.allowComments !== false) : !cur.album.allowContrib;
  try {
    const a = await api('/api/albums/' + cur.albumId, { method: 'PATCH', body: { [key]: val } });
    cur.album = a;
    renderAlbum();
    toast(val ? 'Activat' : 'Dezactivat');
  } catch (e) { toast(e.message); }
}

async function openModeration() {
  $('albumMenu').hidden = true;
  const list = $('cmList');
  list.textContent = 'Se încarcă…';
  $('cmModal').hidden = false;
  let rows = [];
  try { rows = await api('/api/albums/' + cur.albumId + '/comments'); } catch (e) { list.textContent = e.message; return; }
  if (!rows.length) { list.innerHTML = '<p class="muted">Niciun comentariu încă.</p>'; return; }
  list.textContent = '';
  for (const c of rows) {
    const d = document.createElement('div');
    d.className = 'cm-row';
    const txt = c.emoji && !c.body ? c.emoji : (c.emoji ? c.emoji + ' ' : '') + (c.body || '');
    d.innerHTML = '<div><b>' + escapeHtml(c.name) + '</b> '
      + '<span class="muted">' + new Date(c.createdAt).toLocaleString('ro-RO') + (c.mediaId ? ' · pe o poză' : '') + '</span>'
      + '<div class="cm-body">' + escapeHtml(txt) + '</div></div>';
    const del = document.createElement('button');
    del.className = 'icon-btn2';
    del.innerHTML = '<span class="msi">delete</span>';
    del.title = 'Șterge';
    del.onclick = async () => {
      try { await api('/api/albums/' + cur.albumId + '/comments/' + c.id, { method: 'DELETE' }); d.remove(); toast('Șters'); }
      catch (e) { toast(e.message); }
    };
    d.appendChild(del);
    list.appendChild(d);
  }
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
  if (a.owner) {
    const own = document.createElement('div');
    own.className = 'album-owner';
    own.innerHTML = (a.owner.avatar ? '<img src="' + a.owner.avatar + '" alt="">' : '<span class="msi">person</span>')
      + '<span>' + escapeHtml(a.owner.name) + '</span>';
    meta.appendChild(own);
  }
  card.appendChild(cover);
  card.appendChild(meta);

  // trage fișiere de pe disc direct pe album
  card.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault(); e.stopPropagation(); card.classList.add('drop-on');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-on'));
  card.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation();
    card.classList.remove('drop-on');
    const files = [...e.dataTransfer.files];
    const before = new Set(media.map((m) => m.id));
    await uploadFiles(files);
    const fresh = media.filter((m) => !before.has(m.id)).map((m) => m.id);
    if (fresh.length) {
      try {
        const d = await api('/api/albums/' + a.id + '/items', { method: 'POST', body: { ids: fresh } });
        await loadAlbums(); renderAlbums();
        toast(d.added + ' adăugate în „' + a.name + '"');
      } catch (err) { toast(err.message); }
    }
  });
  return card;
}

function renderAlbums() {
  const grid = $('albumsGrid');
  grid.textContent = '';
  $('albumsEmpty').hidden = albums.length > 0;
  for (const a of albums) grid.appendChild(albumCard(a));
}

async function renderShares() {
  const shared = albums.filter((a) => a.shareToken);
  const grid = $('sharesGrid');
  grid.textContent = '';
  $('sharesEmpty').hidden = shared.length > 0;
  for (const a of shared) grid.appendChild(albumCard(a));

  // activitate recentă (comentarii/reacții de la vizitatori)
  let act = [];
  try { act = await api('/api/shares/activity'); } catch {}
  let feed = $('sharesFeed');
  if (!feed) {
    feed = document.createElement('div');
    feed.id = 'sharesFeed';
    feed.className = 'shares-feed';
    $('viewShares').appendChild(feed);
  }
  feed.textContent = '';
  if (act.length) {
    const h = document.createElement('h2');
    h.className = 'shares-feed-h';
    h.textContent = 'Activitate recentă';
    feed.appendChild(h);
    for (const c of act) {
      const row = document.createElement('a');
      row.className = 'feed-row';
      row.href = '#/album/' + c.albumId;
      const what = c.body ? esc0(c.body) : (c.emoji || '');
      row.innerHTML = '<b>' + esc0(c.name) + '</b> ' + (c.emoji && c.body ? c.emoji + ' ' : '') + what
        + '<span class="muted"> · „' + esc0(c.albumName) + '" · ' + relTime0(c.createdAt) + '</span>';
      feed.appendChild(row);
    }
  }
  try { localStorage.setItem('sharesSeen', act[0] ? act[0].createdAt : new Date().toISOString()); } catch {}
  updateSharesBadge(act);
}

function esc0(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function relTime0(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'acum'; if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  return new Date(iso).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
}
function updateSharesBadge(act) {
  const link = document.querySelector('.side-link[data-view="shares"]');
  if (!link) return;
  let seen = ''; try { seen = localStorage.getItem('sharesSeen') || ''; } catch {}
  const fresh = (act || []).some((c) => c.createdAt > seen);
  link.classList.toggle('has-dot', fresh && cur.view !== 'shares');
}
async function pollSharesBadge() {
  try {
    const act = await api('/api/shares/activity');
    updateSharesBadge(act);
  } catch {}
}

function rerender() {
  if (FLAT.includes(cur.view)) renderGrid();
  else if (cur.view === 'album') renderAlbum();
  else if (cur.view === 'albums') renderAlbums();
  else if (cur.view === 'shares') renderShares();
}

function setZoom(z) {
  gridZoom = Math.max(0, Math.min(ZOOM.length - 1, z));
  try { localStorage.setItem('gridZoom', String(gridZoom)); } catch {}
  const btn = $('densityBtn');
  if (btn) {
    btn.title = 'Zoom grilă: ' + ZOOM_LABEL[gridZoom];
    const ic = btn.querySelector('.msi');
    if (ic) ic.textContent = gridZoom >= 3 ? 'calendar_view_month' : gridZoom === 2 ? 'grid_on' : gridZoom === 0 ? 'view_comfy' : 'grid_view';
  }
  rerender();
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
  lastSelId = null;
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
    box.appendChild(selBtn('restore_from_trash', 'Restaurează', () => bulk((id) => api('/api/media/' + id + '/restore', { method: 'POST' }), 'Restaurat', (id) => api('/api/media/' + id + '/trash', { method: 'POST' }))));
    box.appendChild(selBtn('delete_forever', 'Șterge definitiv', async () => {
      const ok = await confirmDanger({
        title: 'Ștergi definitiv?',
        message: 'Cele ' + selected.size + ' elemente selectate se șterg definitiv, fără nicio recuperare posibilă. Scrie ȘTERGE ca să confirmi.',
        word: 'ȘTERGE',
        confirmLabel: 'Șterge definitiv',
      });
      if (!ok) return;
      bulk((id) => api('/api/media/' + id, { method: 'DELETE' }), 'Șters definitiv');
    }));
    return;
  }
  if (cur.view === 'locked') {
    box.appendChild(selBtn('lock_open', 'Scoate din folderul blocat',
      () => bulk((id) => api('/api/media/' + id + '/lock', { method: 'DELETE' }), 'Scos din folderul blocat', (id) => api('/api/media/' + id + '/lock', { method: 'POST' }))));
    box.appendChild(selBtn('download', 'Descarcă (ZIP)', () => { location.href = '/api/download?ids=' + [...selected].join(','); }));
    if (isAdmin) box.appendChild(selBtn('delete', 'Mută în coș', () => bulk((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', (id) => api('/api/media/' + id + '/restore', { method: 'POST' }))));
    return;
  }
  if (cur.view === 'archive') {
    box.appendChild(selBtn('unarchive', 'Scoate din arhivă', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: false } }), 'Scos din arhivă', (id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: true } }))));
  } else {
    box.appendChild(selBtn('add', 'Adaugă în album', (e) => {
      if (!selected.size) return;
      openChooser(e.currentTarget);
    }));
    box.appendChild(selBtn('star', 'Marchează favorite', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { favorite: true } }), 'Adăugat la favorite', (id) => api('/api/media/' + id, { method: 'PATCH', body: { favorite: false } }))));
    box.appendChild(selBtn('inventory_2', 'Arhivează', () => bulk((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: true } }), 'Arhivat', (id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: false } }))));
    box.appendChild(selBtn('lock', 'Mută în folderul blocat', async () => {
      const ok = await ensureLockOpen();
      if (!ok) return;
      bulk((id) => api('/api/media/' + id + '/lock', { method: 'POST' }), 'Mutat în folderul blocat', (id) => api('/api/media/' + id + '/lock', { method: 'DELETE' }));
    }));
    box.appendChild(selBtn('movie', 'Slideshow video', () => openSlideshow([...selected])));
    box.appendChild(selBtn('grid_view', 'Colaj', () => openCollage([...selected])));
    box.appendChild(selBtn('gif_box', 'Animație', () => openAnimation([...selected])));
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
  if (isAdmin) {
    box.appendChild(selBtn('delete', 'Mută în coș', () => bulk((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', (id) => api('/api/media/' + id + '/restore', { method: 'POST' }))));
  }
}

async function bulk(fn, okMsg, undoFn) {
  const ids = [...selected];
  for (const id of ids) {
    try { await fn(id); } catch { /* continuă */ }
  }
  if (undoFn) {
    toast(okMsg, { undo: async () => {
      for (const id of ids) { try { await undoFn(id); } catch {} }
      await loadAll(); await loadAlbums();
      if (cur.view === 'archive') await loadArchive();
      if (cur.view === 'trash') await loadTrash();
      if (cur.view === 'locked') { try { lockedList = await api('/api/media?filter=locked'); } catch {} }
      if (cur.view === 'album') await loadAlbum(cur.albumId);
      rerender();
    } });
  } else toast(okMsg);
  await loadAll();
  await loadAlbums();
  if (cur.view === 'archive') await loadArchive();
  if (cur.view === 'trash') await loadTrash();
  if (cur.view === 'locked') { try { lockedList = await api('/api/media?filter=locked'); } catch {} }
  if (cur.view === 'album') await loadAlbum(cur.albumId);
  clearSel();
  rerender();
}

// ─── Slideshow -> video ────────────────────────────────────────────────────
let slideIds = [];
function imageIdsOnly(ids) {
  return (ids || []).filter((id) => {
    const m = media.find((x) => x.id === id) || (cur.items || []).find((x) => x.id === id);
    return m && m.type === 'image';
  });
}
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// ─── Colaj ──────────────────────────────────────────────────────────────────
async function openCollage(ids) {
  const list = imageIdsOnly(ids).slice(0, 9);
  if (list.length < 2) return toast('Alege cel puțin 2 poze');
  $('collageModal').hidden = false;
  const canvas = $('collageCanvas');
  const ctx = canvas.getContext('2d');
  const SIZE = 1080;
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = Math.ceil(list.length / cols);
  const gap = 8;
  canvas.width = SIZE;
  canvas.height = Math.round(SIZE * rows / cols);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cellW = (SIZE - gap * (cols + 1)) / cols;
  const cellH = (canvas.height - gap * (rows + 1)) / rows;
  const imgs = await Promise.all(list.map((id) => loadImg('/media/' + id + '/preview').catch(() => loadImg('/media/' + id + '/full'))));
  imgs.forEach((im, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const x = gap + c * (cellW + gap), y = gap + r * (cellH + gap);
    const scale = Math.max(cellW / im.width, cellH / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, cellW, cellH); ctx.clip();
    ctx.drawImage(im, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
    ctx.restore();
  });
}
function wireCollage() {
  $('collageClose').onclick = () => { $('collageModal').hidden = true; };
  $('collageSave').onclick = () => {
    $('collageSave').disabled = true;
    $('collageCanvas').toBlob(async (blob) => {
      try {
        const fd = new FormData();
        fd.append('files', blob, 'colaj-' + Date.now() + '.jpg');
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd });
        const d = await r.json();
        if (!r.ok || (d.items && d.items[0] && d.items[0].error)) throw new Error('a eșuat');
        toast('Colaj salvat');
        $('collageModal').hidden = true;
        await loadAll(); rerender();
      } catch (e) { toast(e.message || 'a eșuat'); }
      $('collageSave').disabled = false;
    }, 'image/jpeg', 0.9);
  };
}

// ─── Animație (WebP animat, în buclă) ───────────────────────────────────────
let animIds = [];
function openAnimation(ids) {
  animIds = imageIdsOnly(ids).slice(0, 12);
  if (animIds.length < 2) return toast('Alege cel puțin 2 poze');
  $('animDesc').textContent = animIds.length + ' poze, în buclă';
  $('animProg').hidden = true;
  $('animStart').disabled = false;
  $('animationModal').hidden = false;
}
function wireAnimation() {
  $('animClose').onclick = () => { $('animationModal').hidden = true; };
  $('animStart').onclick = async () => {
    $('animStart').disabled = true;
    $('animProg').hidden = false;
    $('animBar').style.width = '15%';
    $('animStat').textContent = 'Se pregătește…';
    let jobId;
    try {
      const d = await api('/api/animation', { method: 'POST', body: { ids: animIds } });
      jobId = d.jobId;
    } catch (e) { $('animStat').textContent = e.message; $('animStart').disabled = false; return; }
    const poll = setInterval(async () => {
      let j;
      try { j = await api('/api/animation/status/' + jobId); } catch { clearInterval(poll); return; }
      if (j.phase === 'processing') { $('animBar').style.width = '60%'; $('animStat').textContent = 'Se procesează…'; }
      if (j.phase === 'done') {
        clearInterval(poll);
        $('animBar').style.width = '100%';
        $('animStat').textContent = 'Gata!';
        toast('Animație salvată în galerie');
        $('animationModal').hidden = true;
        await loadAll(); rerender();
      }
      if (j.phase === 'error') { clearInterval(poll); $('animStat').textContent = j.error || 'eroare'; $('animStart').disabled = false; }
    }, 1200);
  };
}

function openSlideshow(ids) {
  slideIds = (ids || []).filter((id) => {
    const m = media.find((x) => x.id === id) || (cur.items || []).find((x) => x.id === id);
    return m && m.type === 'image';
  });
  $('slideDesc').textContent = slideIds.length + ' poze';
  $('slideProg').hidden = true;
  $('slideDl').hidden = true;
  $('slideStart').disabled = slideIds.length < 2;
  $('slideModal').hidden = false;
}
function wireSlideshow() {
  $('slideClose').onclick = () => { $('slideModal').hidden = true; };
  $('slideStart').onclick = async () => {
    $('slideStart').disabled = true;
    $('slideProg').hidden = false;
    $('slideDl').hidden = true;
    $('slideBar').style.width = '10%';
    $('slideStat').textContent = 'Se pregătește…';
    let jobId;
    try {
      const d = await api('/api/slideshow', { method: 'POST', body: {
        ids: slideIds, kenburns: $('slideKB').checked, seconds: Number($('slideSecs').value),
      } });
      jobId = d.jobId;
    } catch (e) { $('slideStat').textContent = e.message; $('slideStart').disabled = false; return; }
    const poll = setInterval(async () => {
      let j;
      try { j = await api('/api/slideshow/status/' + jobId); } catch { return; }
      $('slideBar').style.width = (j.phase === 'done' ? 100 : j.phase === 'processing' ? 60 : 20) + '%';
      $('slideStat').textContent = { starting: 'Se pregătește…', processing: 'Se codează cu ffmpeg…', done: 'Gata!', error: 'Eroare' }[j.phase] || j.phase;
      if (j.phase === 'done' || j.phase === 'error') {
        clearInterval(poll);
        $('slideStart').disabled = false;
        if (j.phase === 'done') {
          const a = $('slideDl');
          a.href = '/api/slideshow/' + jobId + '/download';
          a.hidden = false;
          toast('Slideshow gata');
        } else $('slideStat').textContent = 'Eroare: ' + (j.error || '');
      }
    }, 2000);
  };
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
  menu.style.left = '0px'; // resetează înainte de măsurare, ca offsetWidth să nu fie limitat de o poziție veche
  menu.style.right = 'auto';
  menu.hidden = false;
  const menuW = menu.offsetWidth;
  // aliniază marginea dreaptă a meniului cu cea a butonului, dar fără să iasă din ecran (nici la stânga, nici la dreapta)
  const left = Math.max(8, Math.min(rect.right - menuW, window.innerWidth - menuW - 8));
  menu.style.top = rect.bottom + 6 + 'px';
  menu.style.left = left + 'px';
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
  if (kind === 'album') { renderAlbum(); loadShareSuggestions(id); }
  else $('shareSuggest').hidden = true;
}

async function loadShareSuggestions(albumId) {
  const box = $('shareSuggest');
  box.hidden = true;
  let list = [];
  try { list = await api('/api/albums/' + albumId + '/share-suggestions'); } catch { list = []; }
  if (!list.length) return;
  const wrap = $('shareSuggestList');
  wrap.textContent = '';
  list.forEach((u) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'share-suggest-chip';
    chip.innerHTML = '<img src="' + u.avatar + '" alt="">' + escapeHtml(u.displayName) + '<span class="msi">send</span>';
    chip.onclick = async () => {
      chip.disabled = true;
      try {
        await api('/api/albums/' + albumId + '/share/notify', { method: 'POST', body: { userId: u.id } });
        chip.classList.add('sent');
        chip.querySelector('.msi').textContent = 'check';
        toast('Notificare trimisă către ' + u.displayName);
      } catch (e) { toast(e.message); chip.disabled = false; }
    };
    wrap.appendChild(chip);
  });
  box.hidden = false;
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

// ─── Lucruri (categorii CLIP) ────────────────────────────────────────────
const THING_ICON = {
  'Plajă': 'beach_access', 'Munte': 'landscape', 'Mâncare': 'restaurant', 'Apus': 'wb_twilight',
  'Flori': 'local_florist', 'Mașini': 'directions_car', 'Animale': 'pets', 'Clădiri': 'apartment',
  'Noapte': 'nightlight', 'Zăpadă': 'ac_unit', 'Apă': 'water', 'Petreceri': 'celebration',
  'Sport': 'sports_soccer', 'Natură': 'forest', 'Documente': 'description', 'Selfie': 'face',
};
async function renderThings() {
  updateNav();
  $('thingBack').hidden = true;
  $('thingsTitle').textContent = 'Lucruri';
  $('thingGrid').hidden = true;
  $('thingsGrid').hidden = false;
  let list = [];
  try { list = await api('/api/things'); } catch {}
  const grid = $('thingsGrid');
  grid.textContent = '';
  $('thingsEmpty').hidden = list.length > 0;
  for (const t of list) {
    const a = document.createElement('a');
    a.className = 'person-card';
    a.href = '#/thing/' + encodeURIComponent(t.tag);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.style.borderRadius = '16px';
    img.src = '/media/' + t.sampleId + '/thumb';
    const nm = document.createElement('div');
    nm.className = 'person-name';
    nm.innerHTML = '<span class="msi" style="font-size:16px;vertical-align:-3px">' + (THING_ICON[t.tag] || 'label') + '</span> ' + escapeHtml(t.tag);
    const cnt = document.createElement('div');
    cnt.className = 'person-count muted';
    cnt.textContent = t.n + (t.n === 1 ? ' poză' : ' poze');
    a.appendChild(img); a.appendChild(nm); a.appendChild(cnt);
    grid.appendChild(a);
  }
}
async function renderThing() {
  updateNav();
  $('thingsGrid').hidden = true;
  $('thingsEmpty').hidden = true;
  $('thingGrid').hidden = false;
  $('thingBack').hidden = false;
  let d;
  try { d = await api('/api/things/' + encodeURIComponent(cur.thingTag)); } catch { location.hash = '#/things'; return; }
  cur.items = d.items;
  $('thingsTitle').textContent = cur.thingTag;
  buildGallery($('thingGrid'), d.items, { flat: true });
}

// ─── Persoane (grupare fețe) ─────────────────────────────────────────────
async function renderPeople() {
  updateNav();
  $('personBack').hidden = true;
  $('personRename').hidden = true;
  if ($('personMenuWrap')) $('personMenuWrap').hidden = true;
  $('personGrid').hidden = true;
  $('peopleGrid').hidden = false;
  $('peopleTitle').textContent = 'Persoane';
  let list = [];
  try { list = await api('/api/people'); } catch { list = []; }
  const grid = $('peopleGrid');
  grid.textContent = '';
  $('peopleEmpty').hidden = list.length > 0;
  for (const p of list) {
    const a = document.createElement('a');
    a.className = 'person-card';
    a.href = '#/person/' + p.id;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.coverFaceId ? '/api/faces/' + p.coverFaceId + '/crop' : '/media/' + p.coverMediaId + '/thumb';
    const nm = document.createElement('div');
    nm.className = 'person-name';
    nm.textContent = p.name || 'Fără nume';
    if (!p.name) nm.classList.add('unnamed');
    const cnt = document.createElement('div');
    cnt.className = 'person-count muted';
    cnt.textContent = p.n + (p.n === 1 ? ' poză' : ' poze');
    a.appendChild(img); a.appendChild(nm); a.appendChild(cnt);
    grid.appendChild(a);
  }
}

let curPerson = null;
async function renderPerson() {
  updateNav();
  $('peopleGrid').hidden = true;
  $('peopleEmpty').hidden = true;
  $('personGrid').hidden = false;
  $('personBack').hidden = false;
  $('personRename').hidden = false;
  if ($('personMenuWrap')) $('personMenuWrap').hidden = false;
  let d;
  try { d = await api('/api/people/' + cur.personId); } catch { location.hash = '#/people'; return; }
  curPerson = d.person;
  cur.items = d.items;
  $('peopleTitle').textContent = d.person.name || 'Fără nume';
  buildGallery($('personGrid'), d.items, { flat: true });
  decoratePersonTiles();
}

// mic × pe fiecare poză din persoană = „nu e ea aici"
function decoratePersonTiles() {
  const byId = new Map((cur.items || []).map((x) => [x.id, x]));
  $('personGrid').querySelectorAll('.j-tile').forEach((el) => {
    if (el.querySelector('.face-rm')) return;
    const b = document.createElement('button');
    b.className = 'face-rm';
    b.type = 'button';
    b.title = 'Nu e persoana asta aici';
    b.innerHTML = '<span class="msi">close</span>';
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        await api('/api/people/' + cur.personId + '/remove', { method: 'POST', body: { mediaId: el.dataset.id } });
        toast('Scos din persoană');
        renderPerson();
      } catch (err) { toast(err.message); }
    };
    el.appendChild(b);
    if (byId.get(el.dataset.id)) {
      const setC = document.createElement('button');
      setC.className = 'face-cover';
      setC.type = 'button';
      setC.title = 'Fă asta coperta';
      setC.innerHTML = '<span class="msi">wallpaper</span>';
      setC.onclick = async (e) => {
        e.stopPropagation();
        const fid = byId.get(el.dataset.id).faceId;
        if (!fid) return;
        try { await api('/api/people/' + cur.personId, { method: 'PATCH', body: { coverFaceId: fid } }); toast('Copertă setată'); }
        catch (err) { toast(err.message); }
      };
      el.appendChild(setC);
    }
  });
}

async function openPeoplePick() {
  $('personMenu').hidden = true;
  let list = [];
  try { list = await api('/api/people'); } catch {}
  const box = $('peoplePickList');
  box.textContent = '';
  const others = list.filter((p) => p.id !== cur.personId);
  if (!others.length) box.innerHTML = '<p class="muted">Nicio altă persoană.</p>';
  for (const p of others) {
    const b = document.createElement('button');
    b.className = 'pp-row';
    b.type = 'button';
    b.innerHTML = '<img loading="lazy" src="/api/faces/' + (p.coverFaceId || '') + '/crop"><span>' + escapeHtml(p.name || 'Fără nume') + ' · ' + p.n + '</span>';
    b.onclick = async () => {
      if (!confirm('Unești persoana curentă în „' + (p.name || 'Fără nume') + '"?')) return;
      try {
        await api('/api/people/' + cur.personId + '/merge', { method: 'POST', body: { into: p.id } });
        $('peoplePick').hidden = true;
        toast('Unite');
        location.hash = '#/person/' + p.id;
      } catch (e) { toast(e.message); }
    };
    box.appendChild(b);
  }
  $('peoplePick').hidden = false;
}

async function openLinkAccount() {
  $('personMenu').hidden = true;
  let users = [];
  try { users = await api('/api/users/list'); } catch {}
  const box = $('linkAccountList');
  box.textContent = '';
  if (!users.length) box.innerHTML = '<p class="muted">Niciun cont înregistrat.</p>';
  for (const u of users) {
    const b = document.createElement('button');
    b.className = 'pp-row';
    b.type = 'button';
    const on = curPerson && curPerson.linkedUserId === u.id;
    b.innerHTML = '<img loading="lazy" src="/api/users/' + u.id + '/avatar"><span>' + escapeHtml(u.displayName) + ' · @' + escapeHtml(u.username) + '</span>' + (on ? '<span class="msi mi-check" style="opacity:1">check</span>' : '');
    b.onclick = async () => {
      try {
        const d = await api('/api/people/' + cur.personId, { method: 'PATCH', body: { linkedUserId: u.id } });
        curPerson = d.person;
        $('linkAccountModal').hidden = true;
        toast('Legat de ' + u.displayName);
      } catch (e) { toast(e.message); }
    };
    box.appendChild(b);
  }
  $('linkAccountModal').hidden = false;
}

async function renamePerson() {
  if (!curPerson) return;
  const name = prompt('Numele persoanei', curPerson.name || '');
  if (name === null) return;
  try {
    const r = await api('/api/people/' + curPerson.id, { method: 'PATCH', body: { name: name.trim() } });
    curPerson.name = r.name;
    $('peopleTitle').textContent = r.name || 'Fără nume';
    toast('Salvat');
  } catch (e) { toast(e.message); }
}

// ─── Folder blocat (PIN) ──────────────────────────────────────────────────
let lockGateResolve = null;
async function enterLocked() {
  let stt;
  try { stt = await api('/api/lock/status'); } catch { location.hash = '#/'; return; }
  lockConfigured = stt.configured; lockOpen = stt.open;
  if (!lockConfigured) {
    const ok = await openLockGate('setup');
    if (!ok) { location.hash = '#/'; return; }
  } else if (!lockOpen) {
    const ok = await openLockGate('unlock');
    if (!ok) { location.hash = '#/'; return; }
  }
  lockOpen = true;
  cur.view = 'locked';
  showView();
  updateNav();
  try { lockedList = await api('/api/media?filter=locked'); } catch { lockedList = []; }
  renderGrid();
}

function openLockGate(kind) {
  return new Promise((resolve) => {
    lockGateResolve = resolve;
    const setup = kind === 'setup';
    $('lockGateTitle').innerHTML = '<span class="msi">lock</span> ' + (setup ? 'Setează un PIN' : 'Folder blocat');
    $('lockGateDesc').textContent = setup
      ? 'Alege un PIN de 4–12 cifre. Îți va fi cerut ca să deschizi folderul blocat.'
      : 'Introdu PIN-ul ca să vezi ce e aici.';
    $('lockPin').value = ''; $('lockPin2').value = '';
    $('lockPin2').hidden = !setup;
    $('lockGateErr').hidden = true;
    $('lockGateOk').textContent = setup ? 'Setează' : 'Deschide';
    $('lockGate').hidden = false;
    setTimeout(() => $('lockPin').focus(), 30);
    $('lockGate').dataset.kind = kind;
  });
}
function resolveLockGate(v) {
  $('lockGate').hidden = true;
  const r = lockGateResolve; lockGateResolve = null;
  if (r) r(v);
}
async function submitLockGate() {
  const kind = $('lockGate').dataset.kind;
  const pin = $('lockPin').value.trim();
  const err = (m) => { $('lockGateErr').textContent = m; $('lockGateErr').hidden = false; };
  if (!/^[0-9]{4,12}$/.test(pin)) return err('PIN-ul trebuie să aibă 4–12 cifre.');
  try {
    if (kind === 'setup') {
      if (pin !== $('lockPin2').value.trim()) return err('PIN-urile nu se potrivesc.');
      await api('/api/lock/setup', { method: 'POST', body: { pin } });
    } else {
      await api('/api/lock/unlock', { method: 'POST', body: { pin } });
    }
    lockConfigured = true; lockOpen = true;
    resolveLockGate(true);
  } catch (e) { err(e.message || 'PIN greșit'); }
}
async function closeLock(silent) {
  lockOpen = false;
  try { await api('/api/lock/close', { method: 'POST' }); } catch {}
  if (!silent) { toast('Folder blocat'); location.hash = '#/'; }
}
// Asigură folderul deschis (cere PIN dacă e nevoie). Rezolvă true/false.
async function ensureLockOpen() {
  if (lockOpen) return true;
  try {
    const stt = await api('/api/lock/status');
    lockConfigured = stt.configured; lockOpen = stt.open;
  } catch { return false; }
  if (lockOpen) return true;
  return openLockGate(lockConfigured ? 'unlock' : 'setup');
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
  destroyInfoMap();
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
  // la zoom peste 1.4x încarcă originalul (preview-ul devine moale)
  if (zoom.s > 1.4 && im.dataset.full && im.src !== im.dataset.full) {
    im.src = im.dataset.full;
    im.removeAttribute('data-full');
  }
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
    im.src = '/media/' + it.id + '/preview';   // 1600px webp — încarcă rapid
    im.dataset.full = '/media/' + it.id + '/full';
    im.alt = it.originalName || '';
    lbStage.appendChild(im);
    if (it.liveVideoId) setupLivePhoto(it);
  }
  lbDl.href = '/media/' + it.id + '/full';
  lbDl.setAttribute('download', it.originalName || it.id);

  const trash = cur.view === 'trash';
  lb.querySelector('.lb-fav').hidden = trash;
  lb.querySelector('.lb-archive').hidden = trash;
  lb.querySelector('.lb-edit').hidden = trash;
  lb.querySelector('.lb-share').hidden = trash || cur.view === 'locked';
  lb.querySelector('.lb-archive').hidden = trash || cur.view === 'locked';
  lb.querySelector('.lb-del').hidden = trash || !isAdmin;
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

// Live Photo: badge + redă clipul de mișcare la apăsare lungă / hover
function setupLivePhoto(it) {
  const badge = document.createElement('button');
  badge.className = 'lb-live';
  badge.type = 'button';
  badge.innerHTML = '<span class="msi">motion_photos_on</span> LIVE';
  lbStage.appendChild(badge);
  let vid = null;
  const play = () => {
    if (vid || zoom.s > 1.01) return;
    vid = document.createElement('video');
    vid.className = 'lb-live-vid';
    vid.src = '/media/' + it.liveVideoId + '/full';
    vid.muted = true; vid.playsInline = true; vid.autoplay = true;
    vid.onended = stop;
    lbStage.appendChild(vid);
    vid.play().catch(() => {});
  };
  const stop = () => { if (vid) { vid.remove(); vid = null; } };
  badge.addEventListener('pointerdown', (e) => { e.stopPropagation(); play(); });
  badge.addEventListener('pointerup', stop);
  badge.addEventListener('pointerleave', stop);
  badge.addEventListener('click', (e) => e.stopPropagation());
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
  if (it.type === 'video' && it.duration) rows.push(['schedule', fmtDur(it.duration)]);
  rows.push([it.type === 'video' ? 'movie' : 'photo_camera', it.type === 'video' ? 'Videoclip' : 'Fotografie']);
  if (it.camera) rows.push(['photo_camera', it.camera]);
  if (it.lens) rows.push(['camera', it.lens]);
  const shot = [];
  if (it.fNumber) shot.push('ƒ/' + it.fNumber);
  if (it.exposure) shot.push(it.exposure);
  if (it.iso) shot.push('ISO ' + it.iso);
  if (it.focal) shot.push(it.focal + ' mm');
  if (shot.length) rows.push(['tune', shot.join('  ·  ')]);
  if (it.kindAuto === 'screenshot') rows.push(['screenshot', 'Captură de ecran']);
  if (it.kindAuto === 'selfie') rows.push(['face', 'Selfie']);
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

  // context: albume / partajare / persoane / etichete (async)
  const ctxWrap = document.createElement('div');
  ctxWrap.className = 'info-ctx';
  body.appendChild(ctxWrap);
  api('/api/media/' + it.id + '/context').then((c) => {
    if (lbList[lbIndex] !== it) return;
    ctxWrap.textContent = '';
    if (c.people && c.people.length) {
      const r = document.createElement('div'); r.className = 'info-row info-people';
      r.innerHTML = '<span class="msi">group</span>';
      const box = document.createElement('span');
      for (const p of c.people) {
        const a = document.createElement('a');
        a.href = '#/person/' + p.cid;
        a.className = 'info-chip';
        a.innerHTML = '<img src="/api/faces/' + p.faceId + '/crop">' + escapeHtml(p.name || 'Fără nume');
        a.onclick = () => closeLightbox();
        box.appendChild(a);
      }
      r.appendChild(box); ctxWrap.appendChild(r);
    }
    if (c.albums && c.albums.length) {
      const r = document.createElement('div'); r.className = 'info-row';
      r.innerHTML = '<span class="msi">photo_album</span>';
      const box = document.createElement('span');
      c.albums.forEach((al, i) => {
        const a = document.createElement('a');
        a.href = '#/album/' + al.id; a.textContent = al.name; a.className = 'info-link';
        a.onclick = () => closeLightbox();
        box.appendChild(a);
        if (i < c.albums.length - 1) box.appendChild(document.createTextNode(', '));
      });
      r.appendChild(box); ctxWrap.appendChild(r);
    }
    if (c.tags && c.tags.length) {
      const r = document.createElement('div'); r.className = 'info-row';
      r.innerHTML = '<span class="msi">category</span>';
      const box = document.createElement('span');
      c.tags.forEach((t, i) => {
        const a = document.createElement('a');
        a.href = '#/thing/' + encodeURIComponent(t); a.textContent = t; a.className = 'info-link';
        a.onclick = () => closeLightbox();
        box.appendChild(a);
        if (i < c.tags.length - 1) box.appendChild(document.createTextNode(', '));
      });
      r.appendChild(box); ctxWrap.appendChild(r);
    }
    if (c.shared) {
      const r = document.createElement('div'); r.className = 'info-row';
      r.innerHTML = '<span class="msi">link</span><span>Partajată printr-un link</span>';
      ctxWrap.appendChild(r);
    }
  }).catch(() => {});

  destroyInfoMap();
  if (it.lat != null && it.lon != null && window.L) {
    if (it.place) {
      const row = document.createElement('div');
      row.className = 'info-row';
      row.innerHTML = '<span class="msi">location_on</span><span>' + escapeHtml(it.place) + '</span>';
      body.appendChild(row);
    }
    const mp = document.createElement('div');
    mp.className = 'info-map';
    body.appendChild(mp);
    infoMap = L.map(mp, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false })
      .setView([it.lat, it.lon], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(infoMap);
    L.marker([it.lat, it.lon]).addTo(infoMap);
    mp.onclick = () => { location.hash = '#/places'; };
    requestAnimationFrame(() => { if (infoMap) infoMap.invalidateSize(); });
  } else if (isAdmin || (me && it.type)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'info-row info-add-loc';
    row.innerHTML = '<span class="msi">add_location_alt</span><span>Adaugă locație</span>';
    row.onclick = () => openLocationPicker(it);
    body.appendChild(row);
  }
}

// ─── Adaugă locație manual (pentru poze fără GPS) ──────────────────────────
async function openLocationPicker(item) {
  const q = prompt('Caută un loc (oraș, adresă, punct de interes):');
  if (!q || !q.trim()) return;
  let results = [];
  try { results = await api('/api/geo/search?q=' + encodeURIComponent(q.trim())); } catch (e) { toast(e.message); return; }
  if (!results.length) return toast('Niciun rezultat');
  let pick = results[0];
  if (results.length > 1) {
    const list = results.map((r, i) => (i + 1) + '. ' + r.label).join('\n');
    const idx = parseInt(prompt('Alege un rezultat (1-' + results.length + '):\n' + list, '1'), 10);
    if (!idx || idx < 1 || idx > results.length) return;
    pick = results[idx - 1];
  }
  try {
    await api('/api/media/' + item.id, { method: 'PATCH', body: { lat: pick.lat, lon: pick.lon } });
    item.lat = pick.lat; item.lon = pick.lon; item.hasGeo = true;
    const local = media.find((m) => m.id === item.id);
    if (local) { local.lat = pick.lat; local.lon = pick.lon; local.hasGeo = true; }
    toast('Locație adăugată');
    renderInfo();
  } catch (e) { toast(e.message); }
}

let infoMap = null;
function destroyInfoMap() { if (infoMap) { infoMap.remove(); infoMap = null; } }

function fmtDur(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ─── Locuri (hartă) ────────────────────────────────────────────────────────
async function renderPlaces() {
  updateNav();
  let pts = [];
  try { pts = await api('/api/places'); } catch { pts = []; }
  $('placesCount').textContent = pts.length
    ? pts.length + (pts.length === 1 ? ' element cu locație' : ' elemente cu locație') : '';
  $('placesEmpty').hidden = pts.length > 0;
  $('map').hidden = pts.length === 0;
  if (!pts.length || !window.L) return;

  if (!placesMap) {
    placesMap = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(placesMap);
  }
  if (placesLayer) placesLayer.remove();
  placesLayer = (L.markerClusterGroup ? L.markerClusterGroup({ maxClusterRadius: 46 }) : L.layerGroup());

  const bounds = [];
  for (const p of pts) {
    const m = L.marker([p.lat, p.lon]);
    const wrap = document.createElement('div');
    const img = document.createElement('img');
    img.src = '/media/' + p.id + '/thumb';
    img.className = 'map-pop';
    img.loading = 'lazy';
    img.onclick = () => openLightbox(pts, p.id);
    wrap.appendChild(img);
    if (p.place) {
      const c = document.createElement('div');
      c.className = 'map-pop-cap';
      c.textContent = p.place;
      wrap.appendChild(c);
    }
    m.bindPopup(wrap, { minWidth: 160, closeButton: false });
    placesLayer.addLayer(m);
    bounds.push([p.lat, p.lon]);
  }
  placesMap.addLayer(placesLayer);
  requestAnimationFrame(() => {
    placesMap.invalidateSize();
    if (bounds.length) placesMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  });

  // listă de locuri (grupate pe oraș/țară)
  let sum = [];
  try { sum = await api('/api/places/summary'); } catch {}
  const wrap = $('placesList');
  if (wrap) {
    wrap.textContent = '';
    for (const s of sum) {
      if (!s.place) continue;
      const b = document.createElement('button');
      b.className = 'place-row';
      b.type = 'button';
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.src = '/media/' + s.sampleId + '/thumb';
      const t = document.createElement('div');
      t.className = 'place-row-t';
      t.innerHTML = '<b>' + escapeHtml(s.place) + '</b><span class="muted">' + s.n + (s.n === 1 ? ' poză' : ' poze') + '</span>';
      b.appendChild(im); b.appendChild(t);
      b.onclick = () => {
        const here = pts.filter((x) => (x.place || x.city || x.country) === s.place);
        if (here.length && placesMap) placesMap.flyToBounds(here.map((x) => [x.lat, x.lon]), { padding: [50, 50], maxZoom: 14 });
      };
      wrap.appendChild(b);
    }
    wrap.hidden = !sum.length;
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

function openLbEditor() {
  const it = lbList[lbIndex];
  if (!it) return;
  if (it.type === 'video') {
    if (!window.openVideoEditor) return;
    window.openVideoEditor(it, async () => { await loadAll(); await loadAlbums(); rerender(); toast('Salvat'); });
    return;
  }
  if (!window.openEditor) return;
  window.openEditor(it, async (file) => {
    toast('Se salvează copia editată…');
    await uploadFiles([file]);
    toast('Copie editată salvată');
  });
}

async function lbFav() {
  const it = lbList[lbIndex];
  if (!it) return;
  await toggleFav(it, null);
  lb.querySelector('.lb-fav').classList.toggle('on', !!it.favorite);
  if (!$('lbInfo').hidden) renderInfo();
}

async function lbMutate(fn, msg, removeFromList, undoFn) {
  const it = lbList[lbIndex];
  if (!it) return;
  const uid = it.id;
  try { await fn(uid); } catch (e) { return toast(e.message); }
  if (undoFn) {
    toast(msg, { undo: async () => {
      try { await undoFn(uid); } catch {}
      await loadAll(); await loadAlbums();
      if (cur.view === 'archive') await loadArchive();
      if (cur.view === 'trash') await loadTrash();
      if (cur.view === 'album') await loadAlbum(cur.albumId);
      rerender();
    } });
  } else toast(msg);
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
// Confirmare întărită pentru acțiuni permanente/ireversibile: trebuie
// scris exact cuvântul cerut ca butonul de confirmare să se activeze.
function confirmDanger({ title, message, word, confirmLabel }) {
  return new Promise((resolve) => {
    const modal = $('dangerModal');
    $('dangerTitle').textContent = title;
    $('dangerMsg').textContent = message;
    $('dangerConfirm').textContent = confirmLabel || 'Confirmă';
    $('dangerConfirm').disabled = true;
    const input = $('dangerInput');
    input.value = '';
    input.placeholder = word;
    modal.hidden = false;
    setTimeout(() => input.focus(), 50);

    const onInput = () => { $('dangerConfirm').disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); };
    const cleanup = () => {
      modal.hidden = true;
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      $('dangerConfirm').onclick = null;
      $('dangerCancel').onclick = null;
    };
    const onKey = (e) => { if (e.key === 'Enter' && !$('dangerConfirm').disabled) { cleanup(); resolve(true); } };
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    $('dangerConfirm').onclick = () => { cleanup(); resolve(true); };
    $('dangerCancel').onclick = () => { cleanup(); resolve(false); };
  });
}

function toast(msg, opts) {
  const t = $('toast');
  t.textContent = '';
  t.classList.toggle('has-action', !!(opts && opts.undo));
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  clearTimeout(toastT);
  if (opts && opts.undo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo';
    btn.textContent = 'Anulează';
    btn.onclick = async () => {
      t.hidden = true;
      try { await opts.undo(); toast('Anulat'); } catch (e) { toast(e.message || 'nu s-a putut anula'); }
    };
    t.appendChild(btn);
  }
  t.hidden = false;
  toastT = setTimeout(() => { t.hidden = true; }, (opts && opts.undo) ? 6500 : 2600);
}

window.__cloudUpload = (files) => uploadFiles([...files]);
window.__api = api;

// ─── Contul meu ───────────────────────────────────────────────────────────
function wireAccount() {
  const acc = $('accountModal');
  if (!acc) return;
  $('accountBtn').onclick = (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    if (!me) { location.href = '/login'; return; }
    $('accName').value = me.displayName;
    $('accAvatar').src = me.avatar + '?t=' + Date.now();
    $('accUser').textContent = '@' + me.username;
    $('accErr').hidden = true;
    resetAcc2fa();
    render2faStatus();
    acc.hidden = false;
  };
  $('accClose').onclick = () => { acc.hidden = true; };
  $('accAvatarBtn').onclick = () => $('accAvatarInput').click();
  $('accAvatarInput').addEventListener('change', async () => {
    const file = $('accAvatarInput').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      const r = await fetch('/api/account/avatar', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'a eșuat');
      me.hasAvatar = true;
      $('accAvatar').src = d.avatar;
      applyRole();
      toast('Poză salvată');
    } catch (e) { $('accErr').textContent = e.message; $('accErr').hidden = false; }
    $('accAvatarInput').value = '';
  });
  $('accSave').onclick = async () => {
    const name = $('accName').value.trim();
    if (!name) { $('accErr').textContent = 'Numele nu poate fi gol'; $('accErr').hidden = false; return; }
    try {
      const d = await api('/api/account', { method: 'PATCH', body: { displayName: name } });
      me = d.user;
      applyRole();
      acc.hidden = true;
      await loadAlbums();
      if (cur.view === 'albums') renderAlbums();
      if (cur.view === 'album') renderAlbum();
      toast('Salvat');
    } catch (e) { $('accErr').textContent = e.message; $('accErr').hidden = false; }
  };
  wire2fa();
}

function render2faStatus() {
  $('acc2faStatus').textContent = me.totpEnabled ? 'Activată.' : 'Dezactivată — recomandat pentru un cont cu poze reale.';
  $('acc2faToggle').textContent = me.totpEnabled ? 'Dezactivează' : 'Activează';
}
function resetAcc2fa() {
  $('acc2faSetup').hidden = true;
  $('acc2faBackup').hidden = true;
  $('acc2faDisable').hidden = true;
  $('acc2faConfirmCode').value = '';
  $('acc2faDisablePw').value = '';
}
function wire2fa() {
  $('acc2faToggle').onclick = async () => {
    $('accErr').hidden = true;
    if (me.totpEnabled) {
      resetAcc2fa();
      $('acc2faDisable').hidden = false;
      return;
    }
    try {
      const d = await api('/api/account/2fa/setup', { method: 'POST' });
      resetAcc2fa();
      $('acc2faQr').src = d.qr;
      $('acc2faSecret').textContent = d.secret;
      $('acc2faSetup').hidden = false;
    } catch (e) { $('accErr').textContent = e.message; $('accErr').hidden = false; }
  };
  $('acc2faCancel').onclick = () => resetAcc2fa();
  $('acc2faConfirm').onclick = async () => {
    const code = $('acc2faConfirmCode').value.trim();
    if (!/^\d{6}$/.test(code)) { $('accErr').textContent = 'Codul trebuie să aibă 6 cifre'; $('accErr').hidden = false; return; }
    try {
      const d = await api('/api/account/2fa/confirm', { method: 'POST', body: { code } });
      me.totpEnabled = true;
      render2faStatus();
      resetAcc2fa();
      $('acc2faBackupList').innerHTML = d.backupCodes.map((c) => '<div>' + c + '</div>').join('');
      $('acc2faBackup').hidden = false;
      toast('Autentificare în doi pași activată');
    } catch (e) { $('accErr').textContent = e.message; $('accErr').hidden = false; }
  };
  $('acc2faBackupDone').onclick = () => resetAcc2fa();
  $('acc2faDisableCancel').onclick = () => resetAcc2fa();
  $('acc2faDisableConfirm').onclick = async () => {
    const password = $('acc2faDisablePw').value;
    try {
      await api('/api/account/2fa/disable', { method: 'POST', body: { password } });
      me.totpEnabled = false;
      render2faStatus();
      resetAcc2fa();
      toast('Autentificare în doi pași dezactivată');
    } catch (e) { $('accErr').textContent = e.message; $('accErr').hidden = false; }
  };
}

// ─── Notificări push ────────────────────────────────────────────────────────
let pushConfig = null;
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const base64safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64safe);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function getPushSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function subscribePush() {
  if (Notification.permission === 'denied') throw new Error('Notificările sunt blocate din setările browserului');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permisiune refuzată');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(pushConfig.publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}
async function unsubscribePush(sub) {
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ endpoint }) }).catch(() => {});
}
async function refreshPushBtn() {
  if (!pushConfig || !pushConfig.enabled || !me || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    $('pushBtn').hidden = true;
    return;
  }
  $('pushBtn').hidden = false;
  const sub = await getPushSubscription().catch(() => null);
  $('pushBtnLbl').textContent = sub ? 'Dezactivează notificări' : 'Activează notificări';
}
async function initPush() {
  try { pushConfig = await fetch('/api/push/config').then((r) => r.json()); } catch { pushConfig = { enabled: false }; }
  await refreshPushBtn();
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
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); setTheme(b.dataset.theme); };
  });
  $('logoutBtn').onclick = async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } }); } catch {}
    location.replace('/login');
  };

  $('densityBtn').onclick = () => setZoom((gridZoom + 1) % ZOOM.length);
  setZoom(gridZoom); // aplică titlul + iconița

  // Ctrl/Cmd + rotița mouse-ului = zoom pe grilă
  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!FLAT.includes(cur.view) && cur.view !== 'album') return;
    e.preventDefault();
    setZoom(gridZoom + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });
  $('helpBtn').onclick = () => { $('helpModal').hidden = false; };
  $('helpClose').onclick = () => { $('helpModal').hidden = true; };

  $('search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    $('searchClear').hidden = !query;
    if (!query || query.length < 2) { searchResults = null; searchSeq++; }
    else scheduleServerSearch(query);
    if (FLAT.includes(cur.view)) renderGrid();
  });
  $('searchClear').onclick = () => {
    $('search').value = ''; query = ''; $('searchClear').hidden = true;
    searchResults = null; searchSeq++;
    if (FLAT.includes(cur.view)) renderGrid();
  };

  const fileInput = $('fileInput');
  $('uploadBtn').onclick = () => fileInput.click();
  const camInput = $('camInput');
  if ($('camBtn')) $('camBtn').onclick = () => camInput.click();
  camInput.addEventListener('change', () => { if (camInput.files.length) uploadFiles([...camInput.files]); camInput.value = ''; });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFiles([...fileInput.files]);
    fileInput.value = '';
  });
  $('uploadClose').onclick = () => { $('uploadTray').hidden = true; $('uploadList').textContent = ''; };

  $('emptyTrashBtn').onclick = async () => {
    const ok = await confirmDanger({
      title: 'Golești coșul?',
      message: 'Cele ' + trashList.length + ' elemente din coș se șterg definitiv, fără nicio recuperare posibilă. Scrie ȘTERGE ca să confirmi.',
      word: 'ȘTERGE',
      confirmLabel: 'Golește coșul definitiv',
    });
    if (!ok) return;
    try {
      await api('/api/trash/empty', { method: 'POST' });
      await loadTrash();
      await loadAll();
      renderGrid();
      toast('Coș golit');
    } catch (e) { toast(e.message); }
  };

  $('selCancel').onclick = clearSel;

  // ─── Folder blocat ──────────────────────────────────────────────────────
  $('lockGateOk').onclick = submitLockGate;
  $('lockGateCancel').onclick = () => resolveLockGate(false);
  $('lockPin').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if ($('lockPin2').hidden) submitLockGate(); else $('lockPin2').focus();
  });
  $('lockPin2').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitLockGate(); } });
  $('lockCloseBtn').onclick = () => closeLock(false);

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
  $('albumCommentsToggle').onclick = (e) => { e.stopPropagation(); toggleAlbumFlag('allowComments'); };
  $('albumContribToggle').onclick = (e) => { e.stopPropagation(); toggleAlbumFlag('allowContrib'); };
  $('albumModerate').onclick = () => openModeration();
  if ($('albumSlideshow')) $('albumSlideshow').onclick = () => {
    $('albumMenu').hidden = true;
    openSlideshow((cur.items || []).filter((x) => x.type === 'image').map((x) => x.id));
  };
  $('cmClose').onclick = () => { $('cmModal').hidden = true; };
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
    else if (act === 'edit') openLbEditor();
    else if (act === 'fav') lbFav();
    else if (act === 'slideshow') toggleSlideshow();
    else if (act === 'share') { const it = lbList[lbIndex]; if (it) openShareModal('photo', it.id, it); }
    else if (act === 'archive') lbMutate((id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: true } }), 'Arhivat', true, (id) => api('/api/media/' + id, { method: 'PATCH', body: { archived: false } }));
    else if (act === 'trash') lbMutate((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', true, (id) => api('/api/media/' + id + '/restore', { method: 'POST' }));
    else if (act === 'restore') lbMutate((id) => api('/api/media/' + id + '/restore', { method: 'POST' }), 'Restaurat', true);
    else if (act === 'purge') {
      confirmDanger({
        title: 'Ștergi definitiv?',
        message: 'Acest fișier se șterge definitiv, fără nicio recuperare posibilă. Scrie ȘTERGE ca să confirmi.',
        word: 'ȘTERGE',
        confirmLabel: 'Șterge definitiv',
      }).then((ok) => { if (ok) lbMutate((id) => api('/api/media/' + id, { method: 'DELETE' }), 'Șters definitiv', true); });
    } else if (e.target === lb || e.target === lbStage) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    // Modalele au prioritate, chiar și peste lightbox
    if (e.key === 'Escape') {
      if (!$('lockGate').hidden) { resolveLockGate(false); return; }
      if (!$('helpModal').hidden) { $('helpModal').hidden = true; return; }
      if (!$('shareModal').hidden) { $('shareModal').hidden = true; return; }
      if (!$('pickerModal').hidden) { $('pickerModal').hidden = true; return; }
    }
    if (!lb.hidden) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') { stopSlideshow(); stepLb(-1); }
      else if (e.key === 'ArrowRight') { stopSlideshow(); stepLb(1); }
      else if (e.key === 'i') toggleInfo();
      else if (e.key === 'e' && cur.view !== 'trash') openLbEditor();
      else if (e.key === 'f' && cur.view !== 'trash') lbFav();
      else if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && cur.view !== 'trash' && isAdmin) {
        lbMutate((id) => api('/api/media/' + id + '/trash', { method: 'POST' }), 'Mutat în coș', true, (id) => api('/api/media/' + id + '/restore', { method: 'POST' }));
      }
      return;
    }
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === '?') { $('helpModal').hidden = false; return; }
    if (!typing && (e.key === '+' || e.key === '=')) { setZoom(gridZoom - 1); return; }
    if (!typing && (e.key === '-' || e.key === '_')) { setZoom(gridZoom + 1); return; }
    if (!typing && e.key === 'a' && (e.ctrlKey || e.metaKey) && FLAT.includes(cur.view)) {
      e.preventDefault();
      const all = gridData();
      const allSel = all.length && all.every((x) => selected.has(x.id));
      for (const x of all) { if (allSel) selected.delete(x.id); else selected.add(x.id); }
      lastSelId = all.length ? all[all.length - 1].id : null;
      updateSelBar(); rerender();
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

  // filtre (chips)
  document.querySelectorAll('.chip[data-type]').forEach((b) => {
    b.onclick = () => { filterType = b.dataset.type; renderGrid(); };
  });
  $('chipFav').onclick = () => { filterFav = !filterFav; renderGrid(); };
  document.querySelectorAll('.chip[data-cat]').forEach((b) => {
    b.onclick = () => { filterCat = filterCat === b.dataset.cat ? '' : b.dataset.cat; renderGrid(); };
  });
  $('chipYear').onchange = (e) => { filterYear = e.target.value; renderGrid(); };
  if ($('jumpSel')) $('jumpSel').onchange = (e) => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    const days = [...$('grid').querySelectorAll('.j-day')];
    const t = days.find((el) => (el.dataset.date || '').startsWith(v)) || days.reverse().find((el) => (el.dataset.date || '') < v + '-99');
    if (t) SCROLLER.scrollTo({ top: t.getBoundingClientRect().top + SCROLLER.scrollTop - 70, behavior: 'smooth' });
  };

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
  wireSlideshow();
  wireCollage();
  wireAnimation();
  wireAccount();

  // ─── Stare & backup ────────────────────────────────────────────────────
  async function loadHealth() {
    const box = $('healthBody');
    box.innerHTML = '<p class="muted">Se încarcă…</p>';
    let h;
    try { h = await api('/api/admin/health'); } catch (e) { box.innerHTML = '<p class="muted">' + e.message + '</p>'; return; }
    const row = (k, v) => '<div class="hrow"><span>' + k + '</span><b>' + v + '</b></div>';
    const mb = h.media.map((m) => (m.type === 'video' ? 'Clipuri' : 'Poze') + ': ' + m.n + ' (' + fmtBytes(m.bytes) + ')').join(' · ');
    let html = row('Media', mb || '0');
    html += row('Coș', h.trash.count + ' (' + fmtBytes(h.trash.bytes) + ')');
    html += row('Albume / Persoane / Categorii', h.albums + ' / ' + h.people + ' / ' + h.tags);
    html += row('Index căutare', h.embeddings + ' embeddings');
    if (h.fs) html += row('Volum stocare', fmtBytes(h.fs.total - h.fs.free) + ' din ' + fmtBytes(h.fs.total) + ' folosiți');
    const miss = h.integrity.missing;
    html += '<div class="hrow ' + (miss ? 'bad' : 'ok') + '"><span>Integritate fișiere</span><b>' +
      (miss ? '⚠️ ' + miss + '/' + h.integrity.total + ' lipsesc!' : 'OK (' + h.integrity.total + ')') + '</b></div>';
    html += row('Ultimul backup', h.lastBackup
      ? (new Date(h.lastBackup.at).toLocaleString('ro-RO') + ' (' + fmtBytes(h.lastBackup.size) + ')') : 'niciunul');
    if (h.jobHistory && h.jobHistory.length) {
      html += '<div class="hrow" style="border:0;padding-top:14px"><span>Istoric procesări</span><b></b></div>';
      const PH = { done: '✓', error: '✗', running: '…', interrupted: '⚠' };
      for (const j of h.jobHistory) {
        const when = new Date(j.finishedAt || j.startedAt).toLocaleString('ro-RO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        html += '<div class="hrow job"><span>' + (PH[j.phase] || j.phase) + ' ' + escapeHtml(j.kind) + '</span><b>'
          + (j.detail ? escapeHtml(j.detail) + ' · ' : '') + when + '</b></div>';
      }
    }
    box.innerHTML = html;
  }
  $('healthBtn').onclick = (e) => { e.stopPropagation(); $('acctMenu').hidden = true; $('healthModal').hidden = false; loadHealth(); };
  $('healthClose').onclick = () => { $('healthModal').hidden = true; };
  $('healthBackup').onclick = async () => {
    $('healthBackup').disabled = true;
    try { await api('/api/admin/backup', { method: 'POST' }); toast('Backup făcut'); await loadHealth(); }
    catch (e) { toast(e.message); }
    $('healthBackup').disabled = false;
  };

  // ─── Notificări push ─────────────────────────────────────────────────────
  $('pushBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    try {
      const sub = await getPushSubscription();
      if (sub) { await unsubscribePush(sub); toast('Notificări oprite'); }
      else { await subscribePush(); toast('Notificări activate'); }
      await refreshPushBtn();
    } catch (err) { toast(err.message || 'Nu am putut schimba notificările'); }
  };
  initPush();

  // ─── Găsește duplicate ─────────────────────────────────────────────────
  const dupSel = new Set();
  $('dupBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    dupSel.clear();
    $('dupList').innerHTML = '<p class="muted" style="padding:20px">Se caută…</p>';
    $('dupTrash').hidden = true;
    $('dupInfo').textContent = '';
    $('dupModal').hidden = false;
    let groups = [];
    try { groups = await api('/api/duplicates'); } catch (err) { $('dupList').innerHTML = '<p class="muted">' + err.message + '</p>'; return; }
    if (!groups.length) { $('dupList').innerHTML = '<p class="muted" style="padding:20px">Niciun duplicat găsit. 🎉</p>'; return; }
    $('dupInfo').textContent = groups.length + (groups.length === 1 ? ' grup' : ' grupuri');
    $('dupTrash').hidden = false;
    const box = $('dupList');
    box.textContent = '';
    groups.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'dup-group';
      const tag = document.createElement('div');
      tag.className = 'dup-kind';
      tag.textContent = g.kind === 'exact' ? 'Identice' : 'Asemănătoare';
      row.appendChild(tag);
      const strip = document.createElement('div');
      strip.className = 'dup-strip';
      g.items.forEach((it, i) => {
        const cell = document.createElement('button');
        cell.className = 'dup-cell' + (i === 0 ? ' keep' : '');
        cell.type = 'button';
        cell.innerHTML = '<img loading="lazy" src="/media/' + it.id + '/thumb">'
          + '<span class="dup-badge">' + (i === 0 ? 'păstrată' : fmtBytes(it.size || 0)) + '</span>';
        if (i > 0) { dupSel.add(it.id); cell.classList.add('sel'); }
        cell.onclick = () => {
          if (dupSel.has(it.id)) { dupSel.delete(it.id); cell.classList.remove('sel'); }
          else { dupSel.add(it.id); cell.classList.add('sel'); }
          $('dupTrash').textContent = 'Mută ' + dupSel.size + ' în coș';
        };
        strip.appendChild(cell);
      });
      row.appendChild(strip);
      box.appendChild(row);
    });
    $('dupTrash').textContent = 'Mută ' + dupSel.size + ' în coș';
  };
  $('dupClose').onclick = () => { $('dupModal').hidden = true; };
  $('dupTrash').onclick = async () => {
    if (!dupSel.size) return;
    if (!confirm('Muți ' + dupSel.size + ' duplicate în coș?')) return;
    const ids = [...dupSel];
    for (const id of ids) { try { await api('/api/media/' + id + '/trash', { method: 'POST' }); } catch {} }
    $('dupModal').hidden = true;
    toast(ids.length + ' mutate în coș', { undo: async () => {
      for (const id of ids) { try { await api('/api/media/' + id + '/restore', { method: 'POST' }); } catch {} }
      await loadAll(); rerender();
    } });
    await loadAll(); await loadAlbums(); rerender();
  };

  // ─── Curățare inteligentă spațiu ─────────────────────────────────────────
  const cleanupSel = new Set();
  const CLEANUP_SECTIONS = [
    { key: 'blurry', label: 'Posibil neclare', empty: 'Nicio poză neclară găsită.' },
    { key: 'oldScreenshots', label: 'Capturi de ecran vechi (peste 3 luni)', empty: 'Nicio captură veche.' },
    { key: 'largeVideos', label: 'Video-uri mari (peste 200 MB)', empty: 'Niciun video mare.' },
  ];
  $('cleanupBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    cleanupSel.clear();
    $('cleanupList').innerHTML = '<p class="muted" style="padding:20px">Se analizează…</p>';
    $('cleanupTrash').hidden = true;
    $('cleanupInfo').textContent = '';
    $('cleanupModal').hidden = false;
    let data;
    try { data = await api('/api/cleanup/suggestions'); } catch (err) { $('cleanupList').innerHTML = '<p class="muted">' + err.message + '</p>'; return; }
    const total = CLEANUP_SECTIONS.reduce((s, sec) => s + data[sec.key].length, 0);
    if (!total) { $('cleanupList').innerHTML = '<p class="muted" style="padding:20px">Nimic de curățat. 🎉</p>'; return; }
    $('cleanupInfo').textContent = total + ' sugestii';
    $('cleanupTrash').hidden = false;
    const box = $('cleanupList');
    box.textContent = '';
    for (const sec of CLEANUP_SECTIONS) {
      const items = data[sec.key];
      if (!items.length) continue;
      const row = document.createElement('div');
      row.className = 'dup-group';
      const tag = document.createElement('div');
      tag.className = 'dup-kind';
      tag.textContent = sec.label + ' (' + items.length + ')';
      row.appendChild(tag);
      const strip = document.createElement('div');
      strip.className = 'dup-strip';
      items.forEach((it) => {
        const cell = document.createElement('button');
        cell.className = 'dup-cell';
        cell.type = 'button';
        cell.innerHTML = '<img loading="lazy" src="/media/' + it.id + '/thumb">'
          + '<span class="dup-badge">' + fmtBytes(it.size || 0) + '</span>';
        cell.onclick = () => {
          if (cleanupSel.has(it.id)) { cleanupSel.delete(it.id); cell.classList.remove('sel'); }
          else { cleanupSel.add(it.id); cell.classList.add('sel'); }
          $('cleanupTrash').textContent = 'Mută ' + cleanupSel.size + ' în coș';
        };
        strip.appendChild(cell);
      });
      row.appendChild(strip);
      box.appendChild(row);
    }
    $('cleanupTrash').textContent = 'Mută ' + cleanupSel.size + ' în coș';
  };
  $('cleanupClose').onclick = () => { $('cleanupModal').hidden = true; };
  $('cleanupTrash').onclick = async () => {
    if (!cleanupSel.size) return;
    if (!confirm('Muți ' + cleanupSel.size + ' elemente în coș?')) return;
    const ids = [...cleanupSel];
    for (const id of ids) { try { await api('/api/media/' + id + '/trash', { method: 'POST' }); } catch {} }
    $('cleanupModal').hidden = true;
    toast(ids.length + ' mutate în coș', { undo: async () => {
      for (const id of ids) { try { await api('/api/media/' + id + '/restore', { method: 'POST' }); } catch {} }
      await loadAll(); rerender();
    } });
    await loadAll(); await loadAlbums(); rerender();
  };

  // ─── Indexare căutare inteligentă (CLIP + OCR) ──────────────────────────
  let idxTimer = null;
  const stopIdx = () => { if (idxTimer) { clearInterval(idxTimer); idxTimer = null; } };
  $('indexBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    $('idxProgress').hidden = true;
    $('idxStart').disabled = false;
    $('idxOcr').checked = false;
    $('idxHave').textContent = '';
    $('idxModal').hidden = false;
    try {
      const st = await api('/api/search/stats');
      $('idxHave').textContent = st.embed + '/' + st.total + ' indexate' + (st.ocr ? ' · ' + st.ocr + ' cu OCR' : '');
    } catch {}
  };
  $('idxClose').onclick = () => { stopIdx(); $('idxModal').hidden = true; };

  // ─── Găsește persoane (fețe) ───────────────────────────────────────────
  $('personBack').onclick = () => { location.hash = '#/people'; };
  if ($('thingBack')) $('thingBack').onclick = () => { location.hash = '#/things'; };
  if ($('retagBtn')) $('retagBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    try {
      const d = await api('/api/search/retag', { method: 'POST' });
      toast('Se reclasifică în fundal…');
      const poll = setInterval(async () => {
        let j; try { j = await api('/api/search/index/status/' + d.jobId); } catch { return; }
        if (j.phase === 'done' || j.phase === 'error') {
          clearInterval(poll);
          toast(j.phase === 'done' ? ('Gata: ' + j.embedded + ' etichete') : 'Eroare la reclasificare');
          if (cur.view === 'things' && !cur.thingTag) renderThings();
        }
      }, 2000);
    } catch (e2) { toast(e2.message); }
  };
  $('personRename').onclick = () => renamePerson();
  if ($('personMenuBtn')) {
    $('personMenuBtn').onclick = (e) => { e.stopPropagation(); $('personMenu').hidden = !$('personMenu').hidden; };
    document.addEventListener('click', () => { $('personMenu').hidden = true; });
    $('personCover').onclick = () => { $('personMenu').hidden = true; toast('Apasă ⌗ pe poza dorită'); };
    $('personMerge').onclick = () => openPeoplePick();
    $('personLink').onclick = () => openLinkAccount();
    $('personDismiss').onclick = async () => {
      $('personMenu').hidden = true;
      if (!confirm('Marchezi gruparea asta ca „nu e o persoană"? Pozele rămân în galerie.')) return;
      try { await api('/api/people/' + cur.personId, { method: 'DELETE' }); toast('Eliminată'); location.hash = '#/people'; }
      catch (e) { toast(e.message); }
    };
    $('peoplePickClose').onclick = () => { $('peoplePick').hidden = true; };
    $('linkAccountClose').onclick = () => { $('linkAccountModal').hidden = true; };
    $('linkAccountNone').onclick = async () => {
      try {
        const d = await api('/api/people/' + cur.personId, { method: 'PATCH', body: { linkedUserId: null } });
        curPerson = d.person;
        $('linkAccountModal').hidden = true;
        toast('Dezlegat');
      } catch (e) { toast(e.message); }
    };
  }
  let faceTimer = null;
  const stopFace = () => { if (faceTimer) { clearInterval(faceTimer); faceTimer = null; } };
  $('facesBtn').onclick = async (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    $('faceProgress').hidden = true;
    $('faceStart').disabled = false;
    $('faceHave').textContent = '';
    $('faceModal').hidden = false;
    try {
      const st = await api('/api/faces/stats');
      $('faceHave').textContent = st.done + '/' + st.total + ' poze · ' + st.faces + ' fețe · ' + st.people + ' persoane';
    } catch {}
  };
  $('faceClose').onclick = () => { stopFace(); $('faceModal').hidden = true; };
  $('faceStart').onclick = async () => {
    $('faceStart').disabled = true;
    $('faceProgress').hidden = false;
    $('faceBar').style.width = '3%';
    $('faceStat').textContent = 'Se pornește… (prima dată încarcă modelele)';
    let jobId;
    try {
      const d = await api('/api/faces/index', { method: 'POST', body: {} });
      jobId = d.jobId;
    } catch (e) { $('faceStat').textContent = e.message; $('faceStart').disabled = false; return; }
    stopFace();
    faceTimer = setInterval(async () => {
      let j;
      try { j = await api('/api/faces/index/status/' + jobId); } catch { return; }
      const PH = { starting: 'Se pregătește…', scanning: 'Se scanează…', running: 'Se caută fețe', done: 'Gata', error: 'Eroare' };
      const pct = j.total ? (j.done / j.total) * 100 : (j.phase === 'done' ? 100 : 6);
      $('faceBar').style.width = Math.max(3, pct).toFixed(1) + '%';
      const bits = [PH[j.phase] || j.phase];
      if (j.total) bits.push(j.done + '/' + j.total);
      if (j.faces) bits.push(j.faces + ' fețe');
      if (j.people) bits.push(j.people + ' persoane');
      $('faceStat').textContent = bits.join('  ·  ');
      if (j.phase === 'done' || j.phase === 'error') {
        stopFace();
        $('faceStart').disabled = false;
        toast(j.phase === 'done' ? ('Gata: ' + j.people + ' persoane') : ('Eroare: ' + (j.error || '')));
        if (cur.view === 'people' && !cur.personId) renderPeople();
      }
    }, 2000);
  };
  $('idxStart').onclick = async () => {
    $('idxStart').disabled = true;
    $('idxProgress').hidden = false;
    $('idxBar').style.width = '3%';
    $('idxStat').textContent = 'Se pornește… (prima dată descarcă modelul)';
    let jobId;
    try {
      const d = await api('/api/search/index', { method: 'POST', body: { ocr: $('idxOcr').checked } });
      jobId = d.jobId;
    } catch (e) { $('idxStat').textContent = e.message; $('idxStart').disabled = false; return; }
    stopIdx();
    idxTimer = setInterval(async () => {
      let j;
      try { j = await api('/api/search/index/status/' + jobId); } catch { return; }
      const PH = { starting: 'Se pregătește…', scanning: 'Se scanează…', running: 'Se analizează', done: 'Gata', error: 'Eroare' };
      const pct = j.total ? (j.done / j.total) * 100 : (j.phase === 'done' ? 100 : 6);
      $('idxBar').style.width = Math.max(3, pct).toFixed(1) + '%';
      const bits = [PH[j.phase] || j.phase];
      if (j.total) bits.push(j.done + '/' + j.total);
      if (j.embedded) bits.push(j.embedded + ' imagini');
      if (j.ocred) bits.push(j.ocred + ' OCR');
      $('idxStat').textContent = bits.join('  ·  ');
      if (j.phase === 'done' || j.phase === 'error') {
        stopIdx();
        $('idxStart').disabled = false;
        toast(j.phase === 'done' ? ('Indexare gata: ' + j.embedded + ' imagini') : ('Indexare cu erori: ' + (j.error || '')));
      }
    }, 1500);
  };

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

  // ─── Optimizare spațiu ──────────────────────────────────────────────────
  let optTimer = null;
  const stopOpt = () => { if (optTimer) { clearInterval(optTimer); optTimer = null; } };
  $('optimizeBtn').onclick = (e) => {
    e.stopPropagation();
    $('acctMenu').hidden = true;
    $('optProgress').hidden = true;
    $('optVideo').checked = false;
    $('optStart').disabled = false;
    $('optModal').hidden = false;
  };
  $('optClose').onclick = () => { stopOpt(); $('optModal').hidden = true; };
  $('optStart').onclick = async () => {
    if (!confirm('Recompresie ireversibilă: originalele sunt înlocuite cu versiuni mai mici, practic identice vizual. Continui?')) return;
    $('optStart').disabled = true;
    $('optProgress').hidden = false;
    $('optBar').style.width = '2%';
    $('optStat').textContent = 'Se pornește…';
    let jobId;
    try {
      const d = await api('/api/optimize', { method: 'POST', body: { video: $('optVideo').checked } });
      jobId = d.jobId;
    } catch (e) { $('optStat').textContent = e.message; $('optStart').disabled = false; return; }
    stopOpt();
    optTimer = setInterval(async () => {
      let j;
      try { j = await api('/api/optimize/status/' + jobId); } catch { return; }
      const PH = { starting: 'Se pregătește…', scanning: 'Se scanează…', running: 'Se comprimă', done: 'Gata', error: 'Eroare' };
      const pct = j.total ? (j.done / j.total) * 100 : (j.phase === 'done' ? 100 : 5);
      $('optBar').style.width = Math.max(2, pct).toFixed(1) + '%';
      const bits = [PH[j.phase] || j.phase];
      if (j.total) bits.push(j.done + '/' + j.total);
      if (j.changed) bits.push(j.changed + ' comprimate');
      if (j.savedBytes > 0) bits.push('−' + fmtBytes(j.savedBytes));
      $('optStat').textContent = bits.join('  ·  ');
      if (j.phase === 'done' || j.phase === 'error') {
        stopOpt();
        $('optStart').disabled = false;
        toast(j.phase === 'done' ? ('Optimizat: −' + fmtBytes(j.savedBytes) + ' pe ' + j.changed + ' fișiere') : 'Optimizare cu erori');
        await loadAll(); await loadAlbums();
        if (cur.view === 'album') await loadAlbum(cur.albumId);
        rerender();
      }
    }, 1500);
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
