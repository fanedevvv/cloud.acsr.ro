'use strict';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = '/s/' + encodeURIComponent(token);

let items = [];
let lbIndex = -1;

const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString('ro-RO', { year: 'numeric', month: 'long', day: 'numeric' });

function sizeStr(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
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
})();

function render() {
  const grid = $('grid');
  grid.textContent = '';
  const groups = new Map();
  for (const it of items) {
    const k = (it.takenAt || it.createdAt).slice(0, 10);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const [, list] of groups) {
    const sec = document.createElement('section');
    sec.className = 'group';
    const h = document.createElement('h2');
    h.textContent = fmtDay(list[0].takenAt || list[0].createdAt);
    sec.appendChild(h);
    const g = document.createElement('div');
    g.className = 'grid';
    for (const it of list) g.appendChild(tile(it));
    sec.appendChild(g);
    grid.appendChild(sec);
  }
}

function tile(it) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.type = 'button';
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
  lbCaption.textContent = [it.originalName, fmtDay(it.takenAt || it.createdAt), sizeStr(it.size)]
    .filter(Boolean).join('  ·  ');
}
function step(d) {
  if (!items.length) return;
  lbIndex = (lbIndex + d + items.length) % items.length;
  show();
}

function wire() {
  lb.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'close' || e.target === lb) close();
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
