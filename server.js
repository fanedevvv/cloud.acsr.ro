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

const db = require('./lib/db');
const {
  processUpload,
  DATA_DIR,
  ORIGINAL_DIR,
  THUMB_DIR,
  TMP_DIR,
  UUID_RE,
} = require('./lib/media');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD_HASH = process.env.PASSWORD_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;

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
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'neautentificat' });
}

function requireAuthPage(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
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
  favorite, archived, caption, deleted_at AS deletedAt
`;

const mapRow = (r) => ({
  ...r,
  hasThumb: !!r.hasThumb,
  favorite: !!r.favorite,
  archived: !!r.archived,
});

function mediaInAlbum(albumId) {
  return db.prepare(`
    SELECT ${MEDIA_COLS} FROM media m
    JOIN album_items ai ON ai.media_id = m.id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC, m.created_at DESC
  `).all(albumId).map(mapRow);
}

function albumSummary(a) {
  const count = db.prepare(`
    SELECT COUNT(*) n FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
  `).get(a.id).n;
  const cover = db.prepare(`
    SELECT m.id FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC LIMIT 1
  `).get(a.id);
  return {
    id: a.id,
    name: a.name,
    createdAt: a.created_at,
    count,
    coverId: cover ? cover.id : null,
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
    return res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
      `<rect width="100%" height="100%" fill="#e8eaed"/>` +
      `<text x="50%" y="53%" font-size="90" text-anchor="middle" dominant-baseline="middle" fill="#9aa0a6">` +
      (row.type === 'video' ? '&#9654;' : '&#128247;') +
      `</text></svg>`
    );
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
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    req.session.save(() => res.json({ ok: true }));
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/csrf', requireAuth, (req, res) => {
  res.json({ token: req.session.csrf });
});

// ─── Listă media ────────────────────────────────────────────────────────────
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

// Mută în coș (soft delete) / restaurează
app.post('/api/media/:id/trash', requireAuth, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  res.json({ ok: true });
});

app.post('/api/media/:id/restore', requireAuth, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.post('/api/trash/empty', requireAuth, checkCsrf, (req, res) => {
  const rows = db.prepare('SELECT id, stored_name FROM media WHERE deleted_at IS NOT NULL').all();
  for (const r of rows) {
    fs.rmSync(path.join(ORIGINAL_DIR, r.stored_name), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.webp`), { force: true });
    db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
  }
  res.json({ ok: true, deleted: rows.length });
});

// ─── Upload ─────────────────────────────────────────────────────────────────
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 50 },
});

app.post('/api/upload', requireAuth, checkCsrf, upload.array('files', 50), async (req, res, next) => {
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
app.delete('/api/media/:id', requireAuth, checkCsrf, (req, res) => {
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
  const name = String(req.body && req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'nume gol' });
  db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, a.id);
  res.json({ ok: true });
});

app.delete('/api/albums/:id', requireAuth, checkCsrf, (req, res) => {
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

app.get('/s/:token', shareLimiter, (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  if (!getSharedAlbum(req.params.token)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'share.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
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
});
