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
  const rows = db.prepare(`
    SELECT id, type, mime, original_name AS originalName, width, height, size,
           duration, has_thumb AS hasThumb, taken_at AS takenAt, created_at AS createdAt
    FROM media
    ORDER BY COALESCE(taken_at, created_at) DESC, created_at DESC
  `).all();
  res.json(rows.map((r) => ({ ...r, hasThumb: !!r.hasThumb })));
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
});

app.get('/media/:id/full', requireAuth, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).end();

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
});

// ─── Ștergere ───────────────────────────────────────────────────────────────
app.delete('/api/media/:id', requireAuth, checkCsrf, (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });

  fs.rmSync(path.join(ORIGINAL_DIR, row.stored_name), { force: true });
  fs.rmSync(path.join(THUMB_DIR, `${row.id}.webp`), { force: true });
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  res.json({ ok: true });
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`cloud.acsr.ro rulează pe http://127.0.0.1:${PORT}`);
});
