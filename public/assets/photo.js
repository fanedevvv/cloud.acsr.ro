'use strict';

const $ = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = '/p/' + encodeURIComponent(token);

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function fmtDate(iso) {
  if (!iso) return '';
  return cap(new Date(iso).toLocaleDateString('ro-RO', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }));
}
function sizeStr(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

(async function init() {
  let d;
  try {
    const r = await fetch('/api' + base);
    if (!r.ok) throw new Error('invalid');
    d = await r.json();
  } catch {
    $('nf').hidden = false;
    document.querySelector('.pub-photo').hidden = true;
    return;
  }

  const stage = $('stage');
  stage.textContent = '';
  if (d.type === 'video') {
    const v = document.createElement('video');
    v.src = base + '/full';
    v.controls = true;
    v.playsInline = true;
    stage.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = base + '/full';
    img.alt = d.originalName || '';
    stage.appendChild(img);
  }

  const dl = $('dl');
  dl.href = base + '/full';
  dl.setAttribute('download', d.originalName || 'descarcare');
  dl.hidden = false;

  document.title = (d.originalName || 'Poză partajată') + ' — Cloud';
  const bits = [];
  if (d.caption) bits.push(d.caption);
  const meta = [fmtDate(d.takenAt || d.createdAt)];
  if (d.width && d.height) meta.push(d.width + ' × ' + d.height);
  if (d.size) meta.push(sizeStr(d.size));
  bits.push(meta.filter(Boolean).join('  ·  '));
  $('cap').textContent = bits.filter(Boolean).join('\n');
})();
