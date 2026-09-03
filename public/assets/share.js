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
let slideTimer = null;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtDate = (iso, y) => new Date(iso).toLocaleDateString('ro-RO', y
  ? { day: 'numeric', month: 'long', year: 'numeric' }
  : { day: 'numeric', month: 'long' });

function dateRange(aIso, bIso) {
  if (!aIso) return '';
  const a = new Date(aIso), b = new Date(bIso || aIso);
  if (a.toDateString() === b.toDateString()) return cap(fmtDate(a, true));
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameYear && a.getMonth() === b.getMonth()) return a.getDate() + ' – ' + fmtDate(b, true);
  if (sameYear) return fmtDate(a) + ' – ' + fmtDate(b, true);
  return fmtDate(a, true) + ' – ' + fmtDate(b, true);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
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
  const name = data.name || 'Album partajat';
  document.title = name + ' — Cloud';
  $('albumTitle').textContent = name;

  const dates = items.map((it) => it.takenAt || it.createdAt).sort();
  $('heroDate').textContent = dates.length ? dateRange(dates[0], dates[dates.length - 1]) : '';

  const coverId = data.coverId || (items[0] && items[0].id);
  if (coverId) {
    const hi = $('heroImg');
    hi.src = base + '/media/' + coverId + '/full';
    hi.onerror = () => { hi.style.display = 'none'; };
  }

  buildGrid();
  $('loading').hidden = true;
  $('album').hidden = false;
})();

function buildGrid() {
  const grid = $('grid');
  grid.textContent = '';
  const frag = document.createDocumentFragment();
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = 'sq';
    b.type = 'button';
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
    b.addEventListener('click', () => open(i));
    frag.appendChild(b);
  });
  grid.appendChild(frag);
}

// ─── Lightbox ─────────────────────────────────────────────────────────────
function open(i) {
  lbIndex = i;
  if (lbIndex < 0 || lbIndex >= items.length) return;
  lb.hidden = false;
  document.body.classList.add('no-scroll');
  renderStrip();
  show();
}
function close() {
  stopSlide();
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

function toggleSlide() {
  if (slideTimer) return stopSlide();
  if (lb.hidden) open(0);
  slideTimer = setInterval(() => step(1), 3500);
  const i = lb.querySelector('.lb-slideshow .msi');
  if (i) i.textContent = 'pause';
}
function stopSlide() {
  if (!slideTimer) return;
  clearInterval(slideTimer);
  slideTimer = null;
  const i = lb.querySelector('.lb-slideshow .msi');
  if (i) i.textContent = 'play_arrow';
}

// ─── Zoom / pan ──────────────────────────────────────────────────────────
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
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
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

  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copiat'); }
    catch { toast('Copiază din bara de adrese'); }
  };
  $('slideBtn').onclick = () => { open(0); toggleSlide(); };

  lb.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (act === 'close') close();
    else if (act === 'prev') { stopSlide(); step(-1); }
    else if (act === 'next') { stopSlide(); step(1); }
    else if (act === 'slideshow') toggleSlide();
    else if (e.target === lb || e.target === lbStage) close();
  });
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') { stopSlide(); step(-1); }
    else if (e.key === 'ArrowRight') { stopSlide(); step(1); }
    else if (e.key === ' ') { e.preventDefault(); toggleSlide(); }
  });
}
