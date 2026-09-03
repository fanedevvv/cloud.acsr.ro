'use strict';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = '/s/' + encodeURIComponent(token);

const lb = $('lightbox');
const lbStage = $('lbStage');
const lbDl = $('lbDownload');
const lbStrip = $('lbStrip');

let items = [];
let lbIndex = -1;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function fmtDate(iso, withYear) {
  return new Date(iso).toLocaleDateString('ro-RO', withYear
    ? { day: 'numeric', month: 'long', year: 'numeric' }
    : { day: 'numeric', month: 'long' });
}
function dateRange(aIso, bIso) {
  if (!aIso) return '';
  const a = new Date(aIso), b = new Date(bIso || aIso);
  if (a.toDateString() === b.toDateString()) return cap(fmtDate(a, true));
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameYear && a.getMonth() === b.getMonth()) return a.getDate() + '–' + fmtDate(b, true);
  if (sameYear) return fmtDate(a) + ' – ' + fmtDate(b, true);
  return fmtDate(a, true) + ' – ' + fmtDate(b, true);
}

const GAP = 3;
const targetRowH = () => (window.innerWidth < 700 ? 116 : 205);
const aspect = (it) => (it.width && it.height ? it.width / it.height : it.type === 'video' ? 16 / 9 : 1);

function justify(list, width, th) {
  const W = Math.floor(width);
  const rows = [];
  let row = [], arSum = 0;
  for (const it of list) {
    const ar = Math.max(0.4, Math.min(3.4, aspect(it)));
    row.push({ it, ar });
    arSum += ar;
    if (arSum * th + GAP * (row.length - 1) >= W) {
      const h = (W - GAP * (row.length - 1)) / arSum;
      const cells = row.map((r) => ({ it: r.it, w: Math.round(r.ar * h), h: Math.round(h) }));
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

(async function init() {
  wire();
  let data;
  try {
    const r = await fetch('/api' + base);
    if (!r.ok) throw new Error('invalid');
    data = await r.json();
  } catch {
    $('loading').hidden = true;
    $('notfound').hidden = false;
    return;
  }
  items = data.items || [];
  document.title = (data.name || 'Album partajat') + ' — Cloud';
  $('albumTitle').textContent = data.name || 'Album partajat';

  const n = items.length;
  const dates = items.map((it) => it.takenAt || it.createdAt).sort();
  const range = dates.length ? dateRange(dates[0], dates[dates.length - 1]) : '';
  const sub = $('albumSub');
  sub.textContent = '';
  const g = document.createElement('span');
  g.className = 'msi';
  g.textContent = 'group';
  sub.appendChild(g);
  sub.appendChild(document.createTextNode(
    ' Album partajat  ·  ' + n + (n === 1 ? ' element' : ' elemente') + (range ? '  ·  ' + range : '')
  ));

  $('loading').hidden = true;
  $('album').hidden = false;
  $('foot').hidden = false;
  render();
  window.addEventListener('resize', debounce(render, 150));
})();

function debounce(fn, ms) {
  let t;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

function render() {
  const grid = $('grid');
  grid.textContent = '';
  const cs = getComputedStyle(grid);
  const width = (grid.clientWidth || 900) - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  const th = targetRowH();

  const groups = new Map();
  for (const it of items) {
    const k = (it.takenAt || it.createdAt).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const multiDay = groups.size > 1;

  for (const [, list] of groups) {
    const day = document.createElement('section');
    day.className = 'j-day';
    if (multiDay) {
      const head = document.createElement('div');
      head.className = 'j-dayhead';
      const lbl = document.createElement('span');
      lbl.className = 'daylabel';
      const d0 = new Date(list[0].takenAt || list[0].createdAt);
      lbl.textContent = cap(fmtDate(d0, d0.getFullYear() !== new Date().getFullYear()));
      head.appendChild(lbl);
      day.appendChild(head);
    }
    for (const r of justify(list, width, th)) {
      const rowEl = document.createElement('div');
      rowEl.className = 'j-row';
      for (const cell of r) rowEl.appendChild(tile(cell));
      day.appendChild(rowEl);
    }
    grid.appendChild(day);
  }
}

function tile(cell) {
  const it = cell.it;
  const b = document.createElement('button');
  b.className = 'j-tile';
  b.type = 'button';
  b.style.width = cell.w + 'px';
  b.style.height = cell.h + 'px';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = base + '/media/' + it.id + '/thumb';
  b.appendChild(img);
  if (it.type === 'video') {
    const s = document.createElement('span');
    s.className = 'play-badge';
    s.textContent = '▶';
    b.appendChild(s);
  }
  b.addEventListener('click', () => open(it.id));
  return b;
}


function open(id) {
  lbIndex = items.findIndex((x) => x.id === id);
  if (lbIndex < 0) return;
  lb.hidden = false;
  document.body.classList.add('no-scroll');
  renderStrip();
  show();
}
function close() {
  resetZoom();
  lb.hidden = true;
  lbStage.textContent = '';
  document.body.classList.remove('no-scroll');
}
function show() {
  resetZoom();
  const it = items[lbIndex];
  lbStage.textContent = '';
  if (!it) return;
  if (it.type === 'video') {
    const v = document.createElement('video');
    v.src = base + '/media/' + it.id + '/full';
    v.controls = true; v.autoplay = true; v.playsInline = true;
    lbStage.appendChild(v);
  } else {
    const im = document.createElement('img');
    im.src = base + '/media/' + it.id + '/full';
    lbStage.appendChild(im);
  }
  lbDl.href = base + '/media/' + it.id + '/full';
  lbDl.setAttribute('download', it.originalName || it.id);
  $('lbCount').textContent = (lbIndex + 1) + ' / ' + items.length;
  lbStrip.querySelectorAll('.strip-thumb').forEach((el, i) => {
    el.classList.toggle('cur', i === lbIndex);
    if (i === lbIndex) el.scrollIntoView({ inline: 'center', block: 'nearest' });
  });
}
function renderStrip() {
  lbStrip.textContent = '';
  items.forEach((it, i) => {
    const t = document.createElement('button');
    t.className = 'strip-thumb' + (i === lbIndex ? ' cur' : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = base + '/media/' + it.id + '/thumb';
    t.appendChild(img);
    t.onclick = () => { lbIndex = i; show(); };
    lbStrip.appendChild(t);
  });
}
function step(d) {
  if (!items.length) return;
  lbIndex = (lbIndex + d + items.length) % items.length;
  show();
}

// ─── Zoom / pan (ca în Google Photos) ─────────────────────────────────────
let zoom = { s: 1, x: 0, y: 0 };
const zoomImg = () => lbStage.querySelector('img');
function applyZoom() {
  const im = zoomImg();
  if (!im) return;
  im.style.transform = 'translate(' + zoom.x + 'px,' + zoom.y + 'px) scale(' + zoom.s + ')';
  lbStage.classList.toggle('zoomed', zoom.s > 1.01);
}
function resetZoom() {
  zoom = { s: 1, x: 0, y: 0 };
  lbStage.classList.remove('zoomed', 'grabbing');
  const im = zoomImg();
  if (im) im.style.transform = '';
}
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
function initZoom() {
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

function wire() {
  initZoom();
  lb.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (act === 'close') close();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
    else if (e.target === lb || e.target === lbStage) close();
  });
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });
}
