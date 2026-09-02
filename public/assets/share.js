'use strict';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = '/s/' + encodeURIComponent(token);

let items = [];
let lbIndex = -1;

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

function sizeStr(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

const GAP = 3;
const targetRowH = () => (window.innerWidth < 700 ? 116 : 184);
const aspect = (it) => (it.width && it.height ? it.width / it.height : it.type === 'video' ? 16 / 9 : 1);

function justify(list, width, th) {
  const rows = [];
  let row = [];
  let arSum = 0;
  for (const it of list) {
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

(async function init() {
  wire();
  let data;
  try {
    const r = await fetch('/api' + base);
    if (!r.ok) throw new Error('invalid');
    data = await r.json();
  } catch {
    $('notfound').hidden = false;
    return;
  }
  document.title = data.name + ' — Cloud';
  $('albumTitle').textContent = data.name;
  $('count').textContent = data.count + (data.count === 1 ? ' element' : ' elemente');
  items = data.items;
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
  const width = grid.clientWidth || 800;
  const th = targetRowH();

  const groups = new Map();
  for (const it of items) {
    const k = (it.takenAt || it.createdAt).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  for (const [, list] of groups) {
    const day = document.createElement('section');
    day.className = 'j-day';
    const h = document.createElement('h2');
    h.textContent = dayLabel(list[0].takenAt || list[0].createdAt);
    day.appendChild(h);
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

const lb = $('lightbox');
const lbStage = $('lbStage');
const lbDl = $('lbDownload');
const lbCaption = $('lbCaption');

function open(id) {
  lbIndex = items.findIndex((x) => x.id === id);
  if (lbIndex < 0) return;
  lb.hidden = false;
  document.body.classList.add('no-scroll');
  show();
}
function close() {
  lb.hidden = true;
  lbStage.textContent = '';
  document.body.classList.remove('no-scroll');
}
function show() {
  const it = items[lbIndex];
  lbStage.textContent = '';
  if (!it) return;
  if (it.type === 'video') {
    const v = document.createElement('video');
    v.src = base + '/media/' + it.id + '/full';
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    lbStage.appendChild(v);
  } else {
    const im = document.createElement('img');
    im.src = base + '/media/' + it.id + '/full';
    lbStage.appendChild(im);
  }
  lbDl.href = base + '/media/' + it.id + '/full';
  lbDl.setAttribute('download', it.originalName || it.id);
  lbCaption.textContent = [it.originalName, dayLabel(it.takenAt || it.createdAt), sizeStr(it.size)]
    .filter(Boolean).join('   ·   ');
}
function step(d) {
  if (!items.length) return;
  lbIndex = (lbIndex + d + items.length) % items.length;
  show();
}

function wire() {
  lb.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'close' || e.target === lb || e.target === lbStage) close();
    else if (act === 'prev') step(-1);
    else if (act === 'next') step(1);
  });
  document.addEventListener('keydown', (e) => {
    if (lb.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });
}
