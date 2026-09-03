'use strict';
require('./lib/env');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const QRCode = require('qrcode');
const archiver = require('archiver');

const db = require('./lib/db');
const {
  processUpload,
  backfillVideoThumbs,
  DATA_DIR,
  ORIGINAL_DIR,
  THUMB_DIR,
  TMP_DIR,
  UUID_RE,
} = require('./lib/media');
const { backfillHashes } = require('./lib/media');
const takeout = require('./lib/takeout');
const optimize = require('./lib/optimize');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD_HASH = process.env.PASSWORD_HASH || ''; // parola de administrator
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const STORAGE_LIMIT_GB = Number(process.env.STORAGE_LIMIT_GB) || 0;

if (!PASSWORD_HASH || !SESSION_SECRET) {
  console.error('\n  Lipsește PASSWORD_HASH sau SESSION_SECRET.');
  console.error('  Rulează:  npm run set-password -- PAROLA_TA\n');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // în spatele nginx pe localhost

// ─── Securitate: anteturi ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': null, // ca să meargă și pe http local
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));

// ─── Sesiuni (stocate în SQLite, persistă la restart) ────────────────────────
const sessionDb = new Database(path.join(DATA_DIR, 'sessions.db'));
app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  name: 'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ─── Helpers auth / CSRF ─────────────────────────────────────────────────────
// Acces liber: oricine poate vedea și adăuga. Doar ștergerea cere admin.
function requireAuth(req, res, next) { next(); }
function requireAuthPage(req, res, next) { next(); }

function requireAdmin(req, res, next) {
  if (req.session && req.session.authed && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'necesită cont de administrator' });
}

// Double-submit: tokenul din sesiune trebuie trimis în antetul X-CSRF-Token.
// În plus verificăm Origin/Referer pentru cererile care modifică date.
function checkCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.session.csrf || !safeEqual(token, req.session.csrf)) {
    return res.status(403).json({ error: 'token CSRF invalid' });
  }
  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    let ok = false;
    try { ok = new URL(origin).host === host; } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'origine invalidă' });
  }
  next();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getRow(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id);
}

function getAlbum(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
}

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
function getSharedAlbum(token) {
  if (!SHARE_TOKEN_RE.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM albums WHERE share_token = ?').get(token);
}

const jsonBody = express.json({ limit: '256kb' });

const MEDIA_COLS = `
  id, type, mime, original_name AS originalName, width, height, size,
  duration, has_thumb AS hasThumb, taken_at AS takenAt, created_at AS createdAt,
  favorite, archived, caption, deleted_at AS deletedAt, share_token AS shareToken
`;

const mapRow = (r) => ({
  ...r,
  hasThumb: !!r.hasThumb,
  favorite: !!r.favorite,
  archived: !!r.archived,
  shareToken: r.shareToken || null,
});

function getSharedPhoto(token) {
  if (!SHARE_TOKEN_RE.test(String(token || ''))) return null;
  const row = db.prepare('SELECT * FROM media WHERE share_token = ?').get(token);
  return row && !row.deleted_at ? row : null;
}

function mediaInAlbum(albumId) {
  return db.prepare(`
    SELECT ${MEDIA_COLS} FROM media m
    JOIN album_items ai ON ai.media_id = m.id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC, m.created_at DESC
  `).all(albumId).map(mapRow);
}

function albumSummary(a) {
  const agg = db.prepare(`
    SELECT COUNT(*) n,
           MIN(COALESCE(m.taken_at, m.created_at)) firstAt,
           MAX(COALESCE(m.taken_at, m.created_at)) lastAt
    FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
  `).get(a.id);
  const newest = db.prepare(`
    SELECT m.id FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC LIMIT 1
  `).get(a.id);
  // coperta aleasă manual, dacă e încă un membru valid; altfel cea mai recentă
  let coverId = null;
  if (a.cover_id) {
    const ok = db.prepare(`
      SELECT 1 FROM album_items ai JOIN media m ON m.id = ai.media_id
      WHERE ai.album_id = ? AND ai.media_id = ? AND m.deleted_at IS NULL
    `).get(a.id, a.cover_id);
    if (ok) coverId = a.cover_id;
  }
  if (!coverId) coverId = newest ? newest.id : null;
  return {
    id: a.id,
    name: a.name,
    createdAt: a.created_at,
    count: agg.n,
    firstAt: agg.firstAt || null,
    lastAt: agg.lastAt || null,
    coverId,
    shareToken: a.share_token || null,
  };
}

// Golește definitiv coșul: elemente șterse de peste TRASH_DAYS zile.
const TRASH_DAYS = 30;
function purgeTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const rows = db.prepare('SELECT id, stored_name FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  for (const r of rows) {
    fs.rmSync(path.join(ORIGINAL_DIR, r.stored_name), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.webp`), { force: true });
    db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
  }
  if (rows.length) console.log(`coș: șterse definitiv ${rows.length} elemente`);
}

function sendThumb(row, res) {
  const p = path.join(THUMB_DIR, `${row.id}.webp`);
  if (!row.has_thumb || !fs.existsSync(p)) {
    res.set('Cache-Control', 'private, max-age=3600');
    res.type('image/svg+xml');
    // Fundal transparent (culoarea plăcii vine din temă). Pentru video, badge-ul ▶
    // e desenat de client, deci lăsăm SVG-ul gol.
    const glyph = row.type === 'video'
      ? ''
      : `<text x="50%" y="54%" font-size="84" text-anchor="middle" dominant-baseline="middle" fill="#9aa0a6" opacity="0.6">&#128247;</text>`;
    return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">${glyph}</svg>`);
  }
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/webp');
  fs.createReadStream(p).pipe(res);
}

function sendFull(row, res) {
  const full = path.join(ORIGINAL_DIR, row.stored_name);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.type(row.mime || 'application/octet-stream');
  res.sendFile(full, {
    acceptRanges: true,
    dotfiles: 'deny',
    headers: { 'Cache-Control': 'private, max-age=86400' },
  }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
}

// ─── Login / logout ─────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'prea multe încercări, reîncearcă mai târziu' },
});

app.post('/api/login', loginLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const password = String(req.body && req.body.password || '');
  let ok = false;
  try { ok = await bcrypt.compare(password, PASSWORD_HASH); } catch { ok = false; }
  if (!ok) return res.status(401).json({ error: 'parolă greșită' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'eroare server' });
    req.session.authed = true;
    req.session.role = 'admin';
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    req.session.save(() => res.json({ ok: true, role: 'admin' }));
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/csrf', (req, res) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  req.session.save(() => res.json({ token: req.session.csrf, role: req.session.role || 'guest' }));
});

// ─── Listă media ────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const usedBytes = db.prepare('SELECT COALESCE(SUM(size), 0) s FROM media').get().s;
  let totalBytes = STORAGE_LIMIT_GB > 0 ? STORAGE_LIMIT_GB * 1e9 : 0;
  if (!totalBytes) {
    // spațiul volumului unde stau efectiv pozele (poate fi alt disc / NFS)
    try { const st = fs.statfsSync(ORIGINAL_DIR); totalBytes = st.blocks * st.bsize; } catch { totalBytes = 0; }
  }
  const count = db.prepare('SELECT COUNT(*) n FROM media WHERE deleted_at IS NULL').get().n;
  res.json({ usedBytes, totalBytes, count });
});

// Optimizare spațiu (recompresie) — job în fundal
app.post('/api/optimize', requireAdmin, checkCsrf, jsonBody, (req, res) => {
  if (optimize.current() && !optimize.current().finishedAt) {
    return res.status(409).json({ error: 'o optimizare rulează deja' });
  }
  const mode = req.body && req.body.mode === 'aggressive' ? 'aggressive' : 'safe';
  const withVideo = !!(req.body && req.body.video);
  const job = optimize.start({ mode, withVideo });
  res.json({ jobId: job.id });
});

app.get('/api/optimize/status/:id', requireAuth, (req, res) => {
  const job = optimize.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'job necunoscut' });
  res.json(job);
});

app.get('/api/media', requireAuth, (req, res) => {
  const f = String(req.query.filter || 'all');
  let where;
  let order = 'ORDER BY COALESCE(taken_at, created_at) DESC, created_at DESC';
  if (f === 'favorites') where = 'deleted_at IS NULL AND archived = 0 AND favorite = 1';
  else if (f === 'archive') where = 'deleted_at IS NULL AND archived = 1';
  else if (f === 'trash') { where = 'deleted_at IS NOT NULL'; order = 'ORDER BY deleted_at DESC'; }
  else where = 'deleted_at IS NULL AND archived = 0';

  const rows = db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE ${where} ${order}`).all();
  res.json(rows.map(mapRow));
});

// „Amintiri” — poze din aceeași zi calendaristică, din anii trecuți
app.get('/api/memories', requireAuth, (req, res) => {
  const now = new Date();
  const md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const rows = db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE deleted_at IS NULL AND archived = 0
      AND strftime('%m-%d', COALESCE(taken_at, created_at)) = ?
      AND CAST(strftime('%Y', COALESCE(taken_at, created_at)) AS INTEGER) < ?
    ORDER BY COALESCE(taken_at, created_at) DESC
  `).all(md, now.getFullYear()).map(mapRow);
  res.json(rows);
});

// Actualizează favorite / arhivat / descriere
app.patch('/api/media/:id', requireAuth, checkCsrf, jsonBody, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};
  const sets = [];
  const vals = { id: row.id };
  if ('favorite' in b) { sets.push('favorite = @favorite'); vals.favorite = b.favorite ? 1 : 0; }
  if ('archived' in b) { sets.push('archived = @archived'); vals.archived = b.archived ? 1 : 0; }
  if ('caption' in b) { sets.push('caption = @caption'); vals.caption = String(b.caption || '').slice(0, 2000); }
  if (sets.length) db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = @id`).run(vals);
  res.json({ ok: true });
});

// Descărcare în bloc a mai multor elemente, ca arhivă ZIP
app.get('/api/download', requireAuth, (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'nimic de descărcat' });

  const rows = ids
    .map((id) => db.prepare('SELECT * FROM media WHERE id = ?').get(id))
    .filter((r) => r && !r.deleted_at);
  if (!rows.length) return res.status(404).json({ error: 'nu există' });

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="cloud-poze.zip"');

  const archive = archiver('zip', { zlib: { level: 0 } }); // media deja comprimată
  archive.on('warning', (e) => console.warn('zip:', e.message));
  archive.on('error', (e) => { console.error('zip:', e); if (!res.headersSent) res.status(500).end(); else res.end(); });
  archive.pipe(res);

  const used = new Set();
  for (const r of rows) {
    const full = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(full)) continue;
    let name = r.original_name || r.stored_name;
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 2;
      while (used.has(`${base} (${i})${ext}`)) i++;
      name = `${base} (${i})${ext}`;
    }
    used.add(name);
    archive.file(full, { name });
  }
  archive.finalize();
});

// Cod QR pentru un link (SVG). Doar pentru linkurile proprii de partajare.
app.get('/qr', requireAuth, async (req, res) => {
  const data = String(req.query.data || '');
  let ok = false;
  try {
    const u = new URL(data);
    ok = u.host === req.get('host') && (u.pathname.startsWith('/s/') || u.pathname.startsWith('/p/'));
  } catch { ok = false; }
  if (!ok || data.length > 512) return res.status(400).end();
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 240 });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  } catch {
    res.status(500).end();
  }
});

// Mută în coș (soft delete) / restaurează
app.post('/api/media/:id/trash', requireAdmin, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  res.json({ ok: true });
});

app.post('/api/media/:id/restore', requireAdmin, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.post('/api/trash/empty', requireAdmin, checkCsrf, (req, res) => {
  const rows = db.prepare('SELECT id, stored_name FROM media WHERE deleted_at IS NOT NULL').all();
  for (const r of rows) {
    fs.rmSync(path.join(ORIGINAL_DIR, r.stored_name), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.webp`), { force: true });
    db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
  }
  res.json({ ok: true, deleted: rows.length });
});

// ─── Upload ─────────────────────────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 400,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'prea multe încărcări, reîncearcă mai târziu' },
});
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});

app.post('/api/upload', uploadLimiter, checkCsrf, upload.array('files', 50), async (req, res, next) => {
  try {
    const items = [];
    for (const file of req.files || []) {
      try {
        items.push(await processUpload(file));
      } catch (e) {
        try { fs.rmSync(file.path, { force: true }); } catch { /* deja mutat */ }
        items.push({ error: e.message || 'procesare eșuată', name: file.originalname });
      }
    }
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

// ─── Import Google Photos Takeout (.zip) ────────────────────────────────────
const importUpload = multer({ dest: TMP_DIR, limits: { fileSize: 60 * 1024 * 1024 * 1024, files: 1 } });

app.post('/api/import/takeout', requireAdmin, checkCsrf, importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'lipsește fișierul' });
  const job = takeout.newJob();
  takeout.runImport(req.file.path, job).catch((e) => console.error('import:', e));
  res.json({ jobId: job.id });
});

app.get('/api/import/status/:id', requireAdmin, (req, res) => {
  const job = takeout.jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'job necunoscut' });
  res.json(job);
});

// ─── Servire fișiere (doar autentificat) ────────────────────────────────────
app.get('/media/:id/thumb', requireAuth, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).end();
  sendThumb(row, res);
});

app.get('/media/:id/full', requireAuth, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).end();
  sendFull(row, res);
});

// ─── Ștergere ───────────────────────────────────────────────────────────────
app.delete('/api/media/:id', requireAdmin, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });

  fs.rmSync(path.join(ORIGINAL_DIR, row.stored_name), { force: true });
  fs.rmSync(path.join(THUMB_DIR, `${row.id}.webp`), { force: true });
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id); // cascade album_items
  res.json({ ok: true });
});

// ─── Albume ─────────────────────────────────────────────────────────────────
app.get('/api/albums', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all();
  res.json(rows.map(albumSummary));
});

app.post('/api/albums', requireAuth, checkCsrf, jsonBody, (req, res) => {
  const name = String(req.body && req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'nume gol' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, new Date().toISOString());
  res.json(albumSummary(getAlbum(id)));
});

app.get('/api/albums/:id', requireAuth, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  res.json({ album: albumSummary(a), items: mediaInAlbum(a.id) });
});

app.patch('/api/albums/:id', requireAuth, checkCsrf, jsonBody, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};

  if ('name' in b) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'nume gol' });
    db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, a.id);
  }
  if ('coverId' in b) {
    const cid = String(b.coverId || '');
    if (cid && !UUID_RE.test(cid)) return res.status(400).json({ error: 'copertă invalidă' });
    if (cid) {
      const member = db.prepare('SELECT 1 FROM album_items WHERE album_id = ? AND media_id = ?').get(a.id, cid);
      if (!member) return res.status(400).json({ error: 'poza nu e în album' });
    }
    db.prepare('UPDATE albums SET cover_id = ? WHERE id = ?').run(cid || null, a.id);
  }
  res.json(albumSummary(getAlbum(a.id)));
});

app.delete('/api/albums/:id', requireAdmin, checkCsrf, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  db.prepare('DELETE FROM albums WHERE id = ?').run(a.id); // cascade album_items
  res.json({ ok: true });
});

app.post('/api/albums/:id/items', requireAuth, checkCsrf, jsonBody, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.filter((x) => UUID_RE.test(String(x))) : [];
  const ins = db.prepare('INSERT OR IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  const run = db.transaction((list) => {
    let n = 0;
    for (const mid of list) {
      if (db.prepare('SELECT 1 FROM media WHERE id = ?').get(mid)) {
        n += ins.run(a.id, mid, now).changes;
      }
    }
    return n;
  });
  res.json({ added: run(ids) });
});

app.delete('/api/albums/:id/items', requireAuth, checkCsrf, jsonBody, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.filter((x) => UUID_RE.test(String(x))) : [];
  const del = db.prepare('DELETE FROM album_items WHERE album_id = ? AND media_id = ?');
  const run = db.transaction((list) => {
    let n = 0;
    for (const mid of list) n += del.run(a.id, mid).changes;
    return n;
  });
  res.json({ removed: run(ids) });
});

// Creează / rotește linkul de partajare
app.post('/api/albums/:id/share', requireAuth, checkCsrf, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE albums SET share_token = ?, share_created_at = ? WHERE id = ?')
    .run(token, new Date().toISOString(), a.id);
  res.json({ token, path: `/s/${token}` });
});

app.delete('/api/albums/:id/share', requireAuth, checkCsrf, (req, res) => {
  const a = getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE albums SET share_token = NULL, share_created_at = NULL WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// Link de partajare pentru o singură poză / un singur clip
app.post('/api/media/:id/share', requireAuth, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  let token = row.share_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE media SET share_token = ?, share_created_at = ? WHERE id = ?')
      .run(token, new Date().toISOString(), row.id);
  }
  res.json({ token, path: `/p/${token}` });
});

app.delete('/api/media/:id/share', requireAuth, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE media SET share_token = NULL, share_created_at = NULL WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ─── Partajare publică (fără login, doar citire) ────────────────────────────
const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/s/:token', shareLimiter, (req, res) => {
  const a = getSharedAlbum(req.params.token);
  if (!a) return res.status(404).json({ error: 'link invalid' });
  const items = mediaInAlbum(a.id);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.json({ name: a.name, count: items.length, items });
});

function shareMediaGuard(req, res, next) {
  const a = getSharedAlbum(req.params.token);
  if (!a) return res.status(404).end();
  if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).end();
  const inAlbum = db.prepare('SELECT 1 FROM album_items WHERE album_id = ? AND media_id = ?')
    .get(a.id, req.params.id);
  if (!inAlbum) return res.status(404).end();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row || row.deleted_at) return res.status(404).end();
  req.mediaRow = row;
  next();
}

app.get('/s/:token/media/:id/thumb', shareLimiter, shareMediaGuard, (req, res) => sendThumb(req.mediaRow, res));
app.get('/s/:token/media/:id/full', shareLimiter, shareMediaGuard, (req, res) => sendFull(req.mediaRow, res));

const SHARE_HTML_PATH = path.join(__dirname, 'public', 'share.html');
const htmlEsc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

app.get('/s/:token', shareLimiter, (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.type('html');

  let html;
  try { html = fs.readFileSync(SHARE_HTML_PATH, 'utf8'); }
  catch { return res.status(500).end(); }

  const a = getSharedAlbum(req.params.token);
  if (!a) return res.status(404).send(html.replace('<!--OG-->', ''));

  const agg = db.prepare(`
    SELECT COUNT(*) n FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
  `).get(a.id);
  const cover = db.prepare(`
    SELECT m.id FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC LIMIT 1
  `).get(a.id);

  const url = 'https://' + req.get('host') + '/s/' + encodeURIComponent(req.params.token);
  const desc = agg.n + (agg.n === 1 ? ' element' : ' elemente') + ' · album partajat';
  const og = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Cloud">',
    '<meta property="og:title" content="' + htmlEsc(a.name) + '">',
    '<meta property="og:description" content="' + htmlEsc(desc) + '">',
    cover ? '<meta property="og:image" content="' + url + '/media/' + cover.id + '/thumb">' : '',
    '<meta property="og:url" content="' + htmlEsc(url) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].filter(Boolean).join('\n  ');

  res.send(html.replace('<!--OG-->', og));
});

// ─── Partajare publică: o singură poză ─────────────────────────────────────
app.get('/api/p/:token', shareLimiter, (req, res) => {
  const row = getSharedPhoto(req.params.token);
  if (!row) return res.status(404).json({ error: 'link invalid' });
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.json({
    type: row.type,
    mime: row.mime,
    originalName: row.original_name,
    width: row.width,
    height: row.height,
    size: row.size,
    takenAt: row.taken_at,
    createdAt: row.created_at,
    caption: row.caption || '',
  });
});

function sharePhotoGuard(req, res, next) {
  const row = getSharedPhoto(req.params.token);
  if (!row) return res.status(404).end();
  req.mediaRow = row;
  next();
}
app.get('/p/:token/thumb', shareLimiter, sharePhotoGuard, (req, res) => sendThumb(req.mediaRow, res));
app.get('/p/:token/full', shareLimiter, sharePhotoGuard, (req, res) => sendFull(req.mediaRow, res));

app.get('/p/:token', shareLimiter, (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  const code = getSharedPhoto(req.params.token) ? 200 : 404;
  res.status(code).sendFile(path.join(__dirname, 'public', 'photo.html'));
});

// ─── Pagini + statice ───────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuthPage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/manifest.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

// Fallback dacă service worker-ul nu a preluat încă share-ul (PWA neinstalat)
app.post('/share-target', (req, res) => res.redirect('/'));
app.get('/share-target', (req, res) => res.redirect('/'));

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), {
  index: false,
  dotfiles: 'ignore',
  maxAge: '1h',
}));

// ─── 404 + handler erori (fără stack trace către client) ─────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE')) {
    return res.status(413).json({ error: `fișier prea mare (max ${MAX_UPLOAD_MB} MB)` });
  }
  if (err && err.code && String(err.code).startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'upload invalid' });
  }
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'eroare server' });
});

purgeTrash();
setInterval(purgeTrash, 6 * 60 * 60 * 1000).unref();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`cloud.acsr.ro rulează pe http://127.0.0.1:${PORT}`);
  // în fundal: generează postere pentru clipurile fără thumbnail
  Promise.resolve().then(backfillVideoThumbs).catch((e) => console.error('backfill:', e));
  Promise.resolve().then(backfillHashes).catch((e) => console.error('hashes:', e));
});
