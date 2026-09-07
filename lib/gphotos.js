'use strict';
// Import dintr-un link public Google Photos (photos.app.goo.gl / .../share/...).
// Descarcă toate pozele și clipurile din albumul partajat, la calitate maximă,
// și le pune într-un album cu același nume.
//
// Rezistent la throttling-ul Google ȘI la reporniri ale serverului:
//  - o singură descărcare odată, pauze, timeout scurt, reîncercări cu backoff
//  - albumul se creează de la început și se completează pe parcurs
//  - starea se ține în `settings.gphotos_active`; la pornire, serverul reia
//    automat un import neterminat (sar peste ce e deja în album)
//  - mai multe treceri: fiecare trecere sare peste elementele deja importate,
//    deci re-rularea e ieftină și continuă de unde a rămas
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const joblog = require('./joblog');
const { ingest, TMP_DIR } = require('./media');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const REQ_TIMEOUT = 35000;
const ITEM_DELAY = 700;      // pauză între elemente (menajează RAM-ul și Google)
const MAX_PASSES = 8;
const MAX_ITEMS = 3000;

const jobs = new Map();
function newJob() {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, phase: 'starting', total: 0, done: 0, added: 0, duplicates: 0,
    errors: [], albumId: null, albumName: null, startedAt: Date.now(), finishedAt: null, _log: null,
  };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), 3 * 60 * 60 * 1000).unref();
  return job;
}

function isShareUrl(u) {
  return /^https?:\/\/(photos\.app\.goo\.gl\/|photos\.google\.com\/share\/|goo\.gl\/photos\/)/i.test(String(u || '').trim());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getSetting = async (k) => { const r = await db.prepare('SELECT value FROM settings WHERE `key` = ?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(k, v);

async function fetchWithRetry(url, { tries = 4 } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    if (t) await sleep([0, 2000, 5000, 12000][t] || 20000);
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ro,en;q=0.8' }, signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error('HTTP ' + r.status); continue; }
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('cerere eșuată');
}

async function fetchPage(url) {
  const r = await fetchWithRetry(url, { tries: 3 });
  if (!r.ok) throw new Error('pagina Google Photos a răspuns ' + r.status);
  return r.text();
}

function parseAlbum(html) {
  const clean = (s) => (s || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s*[-–—|]\s*Google\s+(Photos|Fotos|Foto|Zdjęcia|Bilder)\s*$/i, '')
    .trim();
  let name = '';
  let m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) name = clean(m[1]);
  if (!name || /^Google/i.test(name)) {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) name = clean(m[1]).split(' · ')[0].trim();
  }
  const items = [];
  const seen = new Set();
  const re = /\["(https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_/\-]+)",([1-9]\d{2,5}),([1-9]\d{2,5})[,\]]/g;
  let x;
  while ((x = re.exec(html)) !== null) {
    const base = x[1].split('=')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    items.push({ base });
  }
  return { name: name || 'Album Google Photos', items };
}

async function grabOne(it) {
  try {
    const rv = await fetchWithRetry(it.base + '=dv', { tries: 2 });
    const ct = (rv.headers.get('content-type') || '').toLowerCase();
    if (rv.ok && ct.startsWith('video/')) {
      return { buf: Buffer.from(await rv.arrayBuffer()), ext: ct.includes('webm') ? 'webm' : 'mp4', mime: ct.split(';')[0] };
    }
  } catch { /* nu e video / throttled — încercăm poza */ }
  const ri = await fetchWithRetry(it.base + '=d');
  if (!ri.ok) throw new Error('HTTP ' + ri.status);
  const ct = (ri.headers.get('content-type') || 'image/jpeg').toLowerCase().split(';')[0];
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif'
    : (ct.includes('heic') || ct.includes('heif')) ? 'heic' : 'jpg';
  return { buf: Buffer.from(await ri.arrayBuffer()), ext, mime: ct };
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error((label || 'operație') + ' prea lentă')), ms); }),
  ]).finally(() => clearTimeout(t));
}

// indicii (0-based) deja prezenți în album, după numele gphotos-<n>.<ext>
async function importedIndices(albumId) {
  const rows = await db.prepare(`
    SELECT m.original_name nm FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ?`).all(albumId);
  const done = new Set();
  for (const r of rows) {
    const mm = String(r.nm || '').match(/^gphotos-(\d+)\./);
    if (mm) done.add(Number(mm[1]) - 1);
  }
  return done;
}

async function runImport(url, job, uploaderId) {
  const workDir = fs.mkdtempSync(path.join(TMP_DIR, 'gphotos-'));
  try {
    job.phase = 'fetch';
    const html = await fetchPage(url.trim());
    const { name, items } = parseAlbum(html);
    job.albumName = name;
    job.total = items.length;
    if (!items.length) throw new Error('nu am găsit poze la acel link (verifică dacă e public)');

    const nm = String(name).trim().slice(0, 120) || 'Album Google Photos';
    let ownerName = 'Cont';
    if (uploaderId) {
      const ou = await db.prepare('SELECT display_name FROM users WHERE id = ?').get(uploaderId);
      if (ou && ou.display_name) ownerName = ou.display_name;
    }
    let aid;
    const found = await db.prepare('SELECT id FROM albums WHERE name = ?').get(nm);
    if (found) aid = found.id;
    else {
      aid = crypto.randomUUID();
      await db.prepare('INSERT INTO albums (id, name, created_at, owner_id, owner_name) VALUES (?, ?, ?, ?, ?)')
        .run(aid, nm, new Date().toISOString(), uploaderId || null, ownerName);
    }
    job.albumId = aid;
    await setSetting('gphotos_active', JSON.stringify({ url, albumId: aid, uploaderId: uploaderId || null, total: items.length, at: Date.now() }));
    const addItem = db.prepare('INSERT IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)');

    job.phase = 'download';
    let prevCount = -1;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const done = await importedIndices(aid);
      job.done = done.size;
      if (done.size >= items.length) break;

      for (let idx = 0; idx < items.length && idx < MAX_ITEMS; idx++) {
        if (done.has(idx)) continue;
        try {
          const g = await grabOne(items[idx]);
          const tmp = path.join(workDir, 'g' + idx + '.' + g.ext);
          fs.writeFileSync(tmp, g.buf);
          const res = await withTimeout(
            ingest({ srcPath: tmp, originalName: 'gphotos-' + (idx + 1) + '.' + g.ext, mime: g.mime, uploaderId: uploaderId || null }),
            120000, 'procesarea fișierului');
          try { fs.rmSync(tmp, { force: true }); } catch { /* deja mutat */ }
          if (res && res.id) {
            await addItem.run(aid, res.id, new Date().toISOString());
            done.add(idx);
            if (res.duplicate) job.duplicates++; else job.added++;
          }
        } catch (e) {
          job.errors.push('#' + (idx + 1) + ': ' + (e && e.message ? e.message : e));
        }
        job.done = done.size;
        if (idx % 12 === 11 && global.gc) { try { global.gc(); } catch { /* */ } }
        await sleep(ITEM_DELAY);
      }

      const count = (await db.prepare('SELECT COUNT(*) c FROM album_items WHERE album_id = ?').get(aid)).c;
      job.done = count;
      if (count >= items.length) break;
      if (count === prevCount) break;         // nu mai progresează — ne oprim
      prevCount = count;
      await sleep(30000);                      // pauză între treceri (Google se „răcorește")
    }

    const finalCount = (await db.prepare('SELECT COUNT(*) c FROM album_items WHERE album_id = ?').get(aid)).c;
    await setSetting('gphotos_active', '');
    if (!finalCount) throw new Error('nu s-a putut descărca niciun fișier (Google poate limita temporar — reîncearcă)');

    job.phase = 'done';
    job.done = finalCount;
    if (job._log) await joblog.finish(job._log, 'done', finalCount + '/' + items.length + ' în albumul „' + nm + '"');
  } catch (e) {
    job.phase = 'error';
    job.errors.push('fatal: ' + (e && e.message ? e.message : e));
    if (job._log) await joblog.finish(job._log, 'error', job.errors[job.errors.length - 1]);
  } finally {
    job.finishedAt = Date.now();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// La pornirea serverului: reia un import neterminat (dacă e cazul).
async function resumePending() {
  let raw;
  try { raw = await getSetting('gphotos_active'); } catch { return null; }
  if (!raw) return null;
  let a;
  try { a = JSON.parse(raw); } catch { await setSetting('gphotos_active', ''); return null; }
  if (!a || !a.url || !a.albumId) { await setSetting('gphotos_active', ''); return null; }
  const alb = await db.prepare('SELECT id FROM albums WHERE id = ?').get(a.albumId);
  if (!alb) { await setSetting('gphotos_active', ''); return null; }
  const count = (await db.prepare('SELECT COUNT(*) c FROM album_items WHERE album_id = ?').get(a.albumId)).c;
  if (a.total && count >= a.total) { await setSetting('gphotos_active', ''); return null; }
  const job = newJob();
  job._log = await joblog.start('Import link Google Photos (reluat)');
  runImport(a.url, job, a.uploaderId || null).catch((e) => console.error('gphotos resume:', e));
  return job;
}

module.exports = { jobs, newJob, runImport, isShareUrl, resumePending };
