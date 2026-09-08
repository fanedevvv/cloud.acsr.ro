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
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const db = require('./db');
const joblog = require('./joblog');
const { ingest, TMP_DIR } = require('./media');

const MAX_FILE_BYTES = 400 * 1024 * 1024; // nu descărcăm clipuri uriașe (OOM pe VPS)

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

const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

// GET-ul paginii, urmând redirect-urile manual ca să strângem cookie-urile
// (necesare pentru cererile de paginare batchexecute).
async function fetchPageJar(url) {
  const jar = {};
  let cur = url, html = null;
  for (let hop = 0; hop < 8; hop++) {
    const r = await fetch(cur, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'ro,en;q=0.8', Cookie: cookieStr(jar) },
      signal: AbortSignal.timeout(REQ_TIMEOUT),
    });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0]; const p = kv.indexOf('=');
      if (p > 0) jar[kv.slice(0, p).trim()] = kv.slice(p + 1);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).href; continue; }
    if (!r.ok) throw new Error('pagina Google Photos a răspuns ' + r.status);
    html = await r.text();
    break;
  }
  if (html == null) throw new Error('prea multe redirect-uri');
  return { html, jar, finalUrl: cur };
}

function albumName(html) {
  const clean = (s) => (s || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s*[-–—|]\s*Google\s+(Photos|Fotos|Foto|Zdjęcia|Bilder)\s*$/i, '')
    .trim();
  let m = html.match(/<title>([^<]+)<\/title>/i);
  let name = m ? clean(m[1]) : '';
  if (!name || /^Google/i.test(name)) {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) name = clean(m[1]).split(' · ')[0].trim();
  }
  return name || 'Album Google Photos';
}

const ITEM_RE = /\["(https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_/\-]+)",([1-9]\d{2,5}),([1-9]\d{2,5})[,\]]/g;
function scanItems(text, seen, out) {
  let x;
  while ((x = ITEM_RE.exec(text)) !== null) {
    const base = x[1].split('=')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ base });
  }
}

// Parcurge un răspuns batchexecute și întoarce { items, token }.
function parseBatch(text) {
  const i = text.indexOf('[["wrb.fr"');
  if (i < 0) return { items: [], token: null };
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) return { items: [], token: null };
  let pl;
  try {
    const arr = JSON.parse(text.slice(i, end));
    const row = arr.find((r) => Array.isArray(r) && r[0] === 'wrb.fr' && r[1] === 'snAcKc' && r[2]);
    if (!row) return { items: [], token: null };
    pl = JSON.parse(row[2]);
  } catch { return { items: [], token: null }; }
  const media = Array.isArray(pl[1]) ? pl[1] : [];
  const items = media.map((it) => { try { return { base: it[1][0].split('=')[0] }; } catch { return null; } }).filter(Boolean);
  return { items, token: (typeof pl[2] === 'string' && pl[2]) ? pl[2] : null };
}

// Ia TOATE elementele albumului: pagina 1 din HTML + restul prin batchexecute
// (paginare identică cu clientul web Google Photos).
async function fetchAlbum(url) {
  const { html, jar, finalUrl } = await fetchPageJar(url.trim());
  const name = albumName(html);
  const seen = new Set();
  const items = [];
  scanItems(html, seen, items);

  const km = finalUrl.match(/\/share\/([^?/]+)/);
  const albumKey = km ? km[1] : null;
  let keyParam = null;
  try { keyParam = new URL(finalUrl).searchParams.get('key'); } catch { /* */ }
  const fsid = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1];
  const bl = (html.match(/"cfb2h":"([^"]+)"/) || [])[1] || 'boq_photosuiserver';
  // token-ul primei pagini: șirul de după "]]," în payload-ul ds:1
  const dsm = html.match(/AF_initDataCallback\(\{key:\s*['"]ds:1['"].*?data:([\s\S]*?)(?:, sideChannel:|\}\);)/);
  let token = dsm ? (dsm[1].match(/\]\],"([A-Za-z0-9_\-]{40,})"/) || [])[1] : null;

  if (albumKey && keyParam && fsid && token) {
    let reqid = 100000;
    for (let page = 0; page < 60 && token; page++) {
      const freq = JSON.stringify([[['snAcKc', JSON.stringify([albumKey, token, null, keyParam]), null, 'generic']]]);
      const u = 'https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=snAcKc'
        + '&source-path=%2Fshare%2F' + albumKey + '&f.sid=' + encodeURIComponent(fsid)
        + '&bl=' + encodeURIComponent(bl) + '&hl=en&soc-app=165&soc-platform=1&soc-device=1&_reqid=' + (reqid += 100) + '&rt=c';
      let text;
      try {
        const r = await fetch(u, {
          method: 'POST',
          headers: {
            'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'x-same-domain': '1', Origin: 'https://photos.google.com', Referer: 'https://photos.google.com/',
            Cookie: cookieStr(jar),
          },
          body: 'f.req=' + encodeURIComponent(freq),
          signal: AbortSignal.timeout(REQ_TIMEOUT),
        });
        text = await r.text();
      } catch { break; }
      const { items: more, token: next } = parseBatch(text);
      if (!more.length) break;
      let added = 0;
      for (const it of more) { if (!seen.has(it.base)) { seen.add(it.base); items.push(it); added++; } }
      if (!next || next === token || added === 0) break;
      token = next;
      await sleep(600);
    }
  }
  return { name, items };
}

const extForCt = (ct) => ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif'
  : (ct.includes('heic') || ct.includes('heif')) ? 'heic' : ct.includes('mp4') ? 'mp4'
  : ct.includes('webm') ? 'webm' : ct.includes('quicktime') ? 'mov' : 'jpg';

// Descarcă un element STREAMING direct pe disc (niciodată tot fișierul în RAM —
// un clip de 4K poate avea 1-2 GB și ar declanșa OOM). Întoarce { path, mime }.
async function grabOne(it, destBase) {
  let resp = null, ct = '';
  try {
    const rv = await fetchWithRetry(it.base + '=dv', { tries: 2 });
    const t = (rv.headers.get('content-type') || '').toLowerCase().split(';')[0];
    if (rv.ok && t.startsWith('video/')) { resp = rv; ct = t; }
    else { try { await rv.body?.cancel(); } catch { /* */ } }
  } catch { /* nu e video / throttled */ }
  if (!resp) {
    const ri = await fetchWithRetry(it.base + '=d');
    if (!ri.ok) throw new Error('HTTP ' + ri.status);
    resp = ri;
    ct = (ri.headers.get('content-type') || 'image/jpeg').toLowerCase().split(';')[0];
  }
  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > MAX_FILE_BYTES) {
    try { await resp.body?.cancel(); } catch { /* */ }
    throw new Error('fișier prea mare (' + Math.round(len / 1048576) + ' MB)');
  }
  const dest = destBase + '.' + extForCt(ct);
  await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  if (size > MAX_FILE_BYTES) { fs.rmSync(dest, { force: true }); throw new Error('fișier prea mare'); }
  if (size < 100) { fs.rmSync(dest, { force: true }); throw new Error('răspuns gol'); }
  return { path: dest, mime: ct || 'application/octet-stream' };
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
    const { name, items } = await fetchAlbum(url.trim());
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
          const g = await grabOne(items[idx], path.join(workDir, 'g' + idx));
          const ext = path.extname(g.path).slice(1) || 'jpg';
          const res = await withTimeout(
            ingest({ srcPath: g.path, originalName: 'gphotos-' + (idx + 1) + '.' + ext, mime: g.mime, uploaderId: uploaderId || null }),
            180000, 'procesarea fișierului');
          try { fs.rmSync(g.path, { force: true }); } catch { /* deja mutat */ }
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

module.exports = { jobs, newJob, runImport, isShareUrl, resumePending, fetchAlbum };
