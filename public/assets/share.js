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

// ─── Social ───────────────────────────────────────────────────────────────
const REACTS = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
let comments = [];
let allowComments = true;
let allowContrib = false;
let myName = '';
let myReacts = {};
try { myName = localStorage.getItem('shareName') || ''; } catch {}
try { myReacts = JSON.parse(localStorage.getItem('shareReacts') || '{}'); } catch {}
const saveReacts = () => { try { localStorage.setItem('shareReacts', JSON.stringify(myReacts)); } catch {} };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const relTime = (iso) => {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'acum';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  if (s < 86400) return Math.floor(s / 3600) + ' h';
  return new Date(iso).toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
};
function askName() {
  if (myName) return myName;
  const n = (prompt('Cum te cheamă?') || '').trim().slice(0, 40);
  if (n) { myName = n; try { localStorage.setItem('shareName', n); } catch {} }
  return myName;
}

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

  allowComments = data.allowComments !== false;
  allowContrib = !!data.allowContrib;
  if (myName) { $('cName').value = myName; const l = $('lbcName'); if (l) l.value = myName; }
  $('contribWrap').hidden = !allowContrib;
  $('social').hidden = !(allowComments || allowContrib);
  $('composer').hidden = !allowComments;
  await loadComments();
})();

async function loadComments() {
  if (!allowComments) { renderAlbumSocial(); return; }
  try {
    const r = await fetch('/api' + base + '/comments');
    const d = await r.json();
    comments = d.comments || [];
  } catch { comments = []; }
  renderAlbumSocial();
}

const forTarget = (mediaId) => comments.filter((c) => (c.mediaId || null) === (mediaId || null));
const rKey = (mediaId) => mediaId || '__album__';

function renderReacts(box, mediaId) {
  box.textContent = '';
  const mine = myReacts[rKey(mediaId)];
  for (const e of REACTS) {
    const n = forTarget(mediaId).filter((c) => c.emoji === e).length;
    const b = document.createElement('button');
    b.className = 'sh-react' + (mine === e ? ' on' : '');
    b.type = 'button';
    b.innerHTML = '<span class="e">' + e + '</span>' + (n ? '<span class="n">' + n + '</span>' : '');
    b.onclick = () => react(e, mediaId, box);
    box.appendChild(b);
  }
}
async function react(emoji, mediaId, box) {
  if (myReacts[rKey(mediaId)] === emoji) { toast('Ai reacționat deja'); return; }
  const name = askName();
  if (!name) return;
  try {
    const c = await postComment({ emoji, mediaId, name });
    comments.push(c);
    myReacts[rKey(mediaId)] = emoji;
    saveReacts();
    renderReacts(box, mediaId);
  } catch (e) { toast(e.message || 'eroare'); }
}

async function postComment(payload) {
  const r = await fetch('/api' + base + '/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

function renderCommentList(el, mediaId) {
  const list = forTarget(mediaId).filter((c) => c.body);
  el.textContent = '';
  if (!list.length) {
    el.innerHTML = '<div class="sh-muted">Niciun comentariu încă.</div>';
    return;
  }
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'sh-cmt';
    d.innerHTML = '<div class="sh-cmt-h"><b>' + esc(c.name) + '</b><span>' + relTime(c.createdAt) + '</span></div>'
      + '<p>' + esc(c.body).replace(/\n/g, '<br>') + '</p>';
    el.appendChild(d);
  }
}

function renderAlbumSocial() {
  if (allowComments) {
    renderReacts($('albumReacts'), null);
    renderCommentList($('albumCommentList'), null);
  }
}

async function sendComposer(nameEl, bodyEl, mediaId, after) {
  const name = (nameEl.value || myName || '').trim().slice(0, 40);
  const body = (bodyEl.value || '').trim();
  if (!name) { toast('Pune un nume'); nameEl.focus(); return; }
  if (!body) { bodyEl.focus(); return; }
  myName = name;
  try { localStorage.setItem('shareName', name); } catch {}
  try {
    const c = await postComment({ name, body, mediaId: mediaId || undefined });
    comments.push(c);
    bodyEl.value = '';
    if (after) after();
  } catch (e) { toast(e.message || 'eroare'); }
}

function renderLbSocial() {
  const it = items[lbIndex];
  if (!it || !allowComments) { $('lbSocial').style.display = allowComments ? '' : 'none'; return; }
  renderReacts($('lbReacts'), it.id);
  $('lbCmtCount').textContent = forTarget(it.id).filter((c) => c.body).length;
  if (!$('lbSheet').hidden) renderCommentList($('lbSheetList'), it.id);
}

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
  $('lbSheet').hidden = true;
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
  renderLbSocial();
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

  // ─── Social: compunere album ──────────────────────────────────────────
  $('cSend').onclick = () => sendComposer($('cName'), $('cBody'), null, () => renderCommentList($('albumCommentList'), null));
  $('cBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('cSend').click(); }
  });

  // Lightbox: foaie de comentarii per poză
  $('lbCmtToggle').onclick = () => {
    const sh = $('lbSheet');
    sh.hidden = !sh.hidden;
    if (!sh.hidden) {
      const it = items[lbIndex];
      renderCommentList($('lbSheetList'), it && it.id);
      if (myName) $('lbcName').value = myName;
    }
  };
  $('lbSheetClose').onclick = () => { $('lbSheet').hidden = true; };
  $('lbcSend').onclick = () => {
    const it = items[lbIndex];
    if (!it) return;
    sendComposer($('lbcName'), $('lbcBody'), it.id, () => { renderCommentList($('lbSheetList'), it.id); renderLbSocial(); });
  };

  // Contribuții: vizitatorii adaugă poze în album
  const cf = $('contribFile');
  $('contribBtn').onclick = () => cf.click();
  cf.addEventListener('change', async () => {
    if (!cf.files.length) return;
    const files = [...cf.files];
    cf.value = '';
    const prog = $('contribProg');
    prog.hidden = false; prog.textContent = 'Se încarcă 0/' + files.length + '…';
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    try {
      const r = await fetch('/api' + base + '/contrib', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      prog.textContent = (d.added || 0) + ' adăugate. Se reîmprospătează…';
      const rr = await fetch('/api' + base);
      const dd = await rr.json();
      items = dd.items || [];
      buildGrid();
      const dates = items.map((it) => it.takenAt || it.createdAt).sort();
      $('heroDate').textContent = dates.length ? dateRange(dates[0], dates[dates.length - 1]) : '';
      prog.textContent = 'Gata — ' + (d.added || 0) + ' poze adăugate.';
      toast('Mulțumim! ' + (d.added || 0) + ' poze adăugate');
    } catch (e) { prog.textContent = ''; prog.hidden = true; toast(e.message || 'eroare la încărcare'); }
  });

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
