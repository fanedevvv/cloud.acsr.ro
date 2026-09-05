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
const MySQLStore = require('express-mysql-session')(session);
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
const { backfillHashes, backfillExif, backfillPreviews, backfillBlur } = require('./lib/media');
const takeout = require('./lib/takeout');
const optimize = require('./lib/optimize');
const push = require('./lib/push');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD_HASH = process.env.PASSWORD_HASH || ''; // parola de administrator
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const STORAGE_LIMIT_GB = Number(process.env.STORAGE_LIMIT_GB) || 0;
const COMMENT_WEBHOOK = process.env.COMMENT_WEBHOOK || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

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
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
      'media-src': ["'self'", 'blob:'],
      'upgrade-insecure-requests': null, // ca să meargă și pe http local
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));

// ─── Sesiuni (stocate în MariaDB, persistă la restart) ───────────────────────
const sessionStore = new MySQLStore({}, db.pool);
app.use(session({
  store: sessionStore,
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

async function getRow(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id);
}

async function getAlbum(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
}

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
async function getSharedAlbum(token) {
  if (!SHARE_TOKEN_RE.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM albums WHERE share_token = ?').get(token);
}

const jsonBody = express.json({ limit: '256kb' });

const MEDIA_COLS = `
  id, type, mime, original_name AS originalName, width, height, size,
  duration, has_thumb AS hasThumb, taken_at AS takenAt, created_at AS createdAt,
  favorite, archived, caption, deleted_at AS deletedAt, share_token AS shareToken,
  lat, lon, place, camera, lens, iso, f_number AS fNumber, exposure, focal,
  kind_auto AS kindAuto, live_video_id AS liveVideoId
`;

const mapRow = (r) => ({
  ...r,
  hasThumb: !!r.hasThumb,
  favorite: !!r.favorite,
  archived: !!r.archived,
  shareToken: r.shareToken || null,
  hasGeo: r.lat != null && r.lon != null,
  liveVideoId: r.liveVideoId || null,
});

async function getSharedPhoto(token) {
  if (!SHARE_TOKEN_RE.test(String(token || ''))) return null;
  const row = await db.prepare('SELECT * FROM media WHERE share_token = ?').get(token);
  return row && !row.deleted_at && !row.locked ? row : null;
}

async function mediaInAlbum(albumId) {
  const rows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media m
    JOIN album_items ai ON ai.media_id = m.id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC, m.created_at DESC
  `).all(albumId);
  return rows.map(mapRow);
}

async function albumSummary(a) {
  const agg = await db.prepare(`
    SELECT COUNT(*) n,
           MIN(COALESCE(m.taken_at, m.created_at)) firstAt,
           MAX(COALESCE(m.taken_at, m.created_at)) lastAt
    FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
  `).get(a.id);
  const newest = await db.prepare(`
    SELECT m.id FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
    ORDER BY COALESCE(m.taken_at, m.created_at) DESC LIMIT 1
  `).get(a.id);
  // coperta aleasă manual, dacă e încă un membru valid; altfel cea mai recentă
  let coverId = null;
  if (a.cover_id) {
    const ok = await db.prepare(`
      SELECT 1 FROM album_items ai JOIN media m ON m.id = ai.media_id
      WHERE ai.album_id = ? AND ai.media_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
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
    allowComments: a.allow_comments == null ? true : !!a.allow_comments,
    allowContrib: !!a.allow_contrib,
    owner: {
      id: a.owner_id || null,
      name: a.owner_name || 'Vizitator',
      avatar: a.owner_id ? '/api/users/' + a.owner_id + '/avatar' : null,
    },
  };
}

// Golește definitiv coșul: elemente șterse de peste TRASH_DAYS zile.
const TRASH_DAYS = 30;
async function purgeTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
  const rows = await db.prepare('SELECT id, stored_name FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  for (const r of rows) {
    fs.rmSync(path.join(ORIGINAL_DIR, r.stored_name), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.webp`), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.preview.webp`), { force: true });
    await db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
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

// ─── Conturi ──────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
const AVATAR_DIR = path.join(THUMB_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe conturi de la acest IP' } });
const avatarUpload = multer({ dest: TMP_DIR, limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return (await db.prepare('SELECT id, username, display_name, has_avatar, is_admin, totp_enabled FROM users WHERE id = ?').get(req.session.userId)) || null;
}
function pubUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, hasAvatar: !!u.has_avatar, isAdmin: !!u.is_admin, totpEnabled: !!u.totp_enabled, avatar: '/api/users/' + u.id + '/avatar' };
}
function requireAccount(req, res, next) {
  if (req.session && (req.session.userId || req.session.role === 'admin')) return next();
  return res.status(401).json({ error: 'creează-ți un cont sau conectează-te' });
}

app.post('/api/register', registerLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const displayName = String(b.displayName || username).trim().replace(/\s+/g, ' ').slice(0, 40) || username;
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'utilizator: 3–24 caractere (litere, cifre, . _ -)' });
  if (password.length < 6) return res.status(400).json({ error: 'parola: minim 6 caractere' });
  if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'utilizatorul există deja' });
  const first = (await db.prepare('SELECT COUNT(*) n FROM users').get()).n === 0;
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, username, pass_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, await bcrypt.hash(password, 10), displayName, first ? 1 : 0, new Date().toISOString());
  req.session.regenerate(async (err) => {
    if (err) return res.status(500).json({ error: 'eroare server' });
    req.session.authed = true;
    req.session.userId = id;
    req.session.displayName = displayName;
    req.session.role = first ? 'admin' : 'user';
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    req.session.save(() => res.json({ ok: true, user: pubUser(u) }));
  });
});

// ─── Autentificare cu Google (OAuth2, fără librărie) ──────────────────────
const GOOGLE_ON = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
app.get('/api/auth/config', (req, res) => res.json({ google: GOOGLE_ON }));

function googleRedirectUri(req) {
  return GOOGLE_REDIRECT_URI || ('https://' + req.get('host') + '/auth/google/callback');
}

app.get('/auth/google', (req, res) => {
  if (!GOOGLE_ON) return res.redirect('/login?e=google-off');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(() => {
    const p = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: googleRedirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
  });
});

app.get('/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ON) return res.redirect('/login?e=google-off');
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/login?e=google-cancel');
  if (!state || state !== req.session.oauthState) return res.redirect('/login?e=state');
  delete req.session.oauthState;
  try {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(12000),
    });
    const tok = await tokRes.json();
    if (!tokRes.ok || !tok.id_token) throw new Error('token');
    // id_token vine direct de la endpointul Google (server-la-server) -> decodăm payload-ul
    const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.aud !== GOOGLE_CLIENT_ID) throw new Error('aud');
    const gid = String(payload.sub);
    const email = String(payload.email || '');
    const name = String(payload.name || email.split('@')[0] || 'Utilizator').slice(0, 40);

    let u = (await db.prepare('SELECT * FROM users WHERE google_id = ?').get(gid))
      || (email && (await db.prepare('SELECT * FROM users WHERE email = ? AND google_id IS NULL').get(email)));
    if (u) {
      if (!u.google_id) await db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(gid, u.id);
      // sincronizează numele afișat cu contul Google la fiecare conectare
      if (name && name !== u.display_name) {
        await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, u.id);
        await db.prepare('UPDATE albums SET owner_name = ? WHERE owner_id = ?').run(name, u.id);
        u.display_name = name;
      }
    } else {
      const first = (await db.prepare('SELECT COUNT(*) n FROM users').get()).n === 0;
      let uname = (email.split('@')[0] || 'user').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20) || 'user';
      if (uname.length < 3) uname = 'user' + uname;
      let base = uname, i = 1;
      while (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) uname = base + (++i);
      const id = crypto.randomUUID();
      await db.prepare('INSERT INTO users (id, username, pass_hash, display_name, is_admin, google_id, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, uname, '', name, first ? 1 : 0, gid, email || null, new Date().toISOString());
      u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    // preia poza de profil din contul Google la fiecare conectare (o suprascrie mereu)
    if (payload.picture) {
      try {
        const pr = await fetch(payload.picture, { signal: AbortSignal.timeout(8000) });
        if (pr.ok) {
          const buf = Buffer.from(await pr.arrayBuffer());
          await require('sharp')(buf, { failOn: 'none' }).resize(200, 200, { fit: 'cover' }).webp({ quality: 82 })
            .toFile(path.join(AVATAR_DIR, u.id + '.webp'));
          if (!u.has_avatar) await db.prepare('UPDATE users SET has_avatar = 1 WHERE id = ?').run(u.id);
        }
      } catch { /* fără poză */ }
    }

    req.session.regenerate((err2) => {
      if (err2) return res.redirect('/login?e=session');
      req.session.authed = true;
      req.session.userId = u.id;
      req.session.displayName = u.display_name;
      req.session.role = u.is_admin ? 'admin' : 'user';
      req.session.csrf = crypto.randomBytes(32).toString('hex');
      req.session.save(() => res.redirect('/'));
    });
  } catch (e) {
    console.error('google oauth:', e.message);
    res.redirect('/login?e=google-fail');
  }
});

app.post('/api/login', loginLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');

  // Cont de utilizator
  if (username) {
    const u = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    let ok = false;
    try { ok = u && u.pass_hash && await bcrypt.compare(password, u.pass_hash); } catch { ok = false; }
    if (!ok) return res.status(401).json({ error: 'utilizator sau parolă greșită' });
    if (u.totp_enabled) {
      req.session.pending2fa = u.id;
      return req.session.save(() => res.json({ ok: true, need2fa: true }));
    }
    return req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'eroare server' });
      req.session.authed = true;
      req.session.userId = u.id;
      req.session.displayName = u.display_name;
      req.session.role = u.is_admin ? 'admin' : 'user';
      req.session.csrf = crypto.randomBytes(32).toString('hex');
      req.session.save(() => res.json({ ok: true, role: req.session.role, user: pubUser(u) }));
    });
  }

  // Parola veche de administrator (fără utilizator)
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

app.get('/api/me', async (req, res) => res.json({ user: pubUser(await currentUser(req)), role: req.session && req.session.role || 'guest' }));

// ─── Autentificare în doi pași (TOTP) ──────────────────────────────────────
const totp = require('./lib/totp');
const twofaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe încercări, reîncearcă mai târziu' } });

app.post('/api/login/2fa', twofaLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const uid = req.session && req.session.pending2fa;
  if (!uid) return res.status(400).json({ error: 'nicio autentificare în curs' });
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!u || !u.totp_enabled) return res.status(400).json({ error: 'nicio autentificare în curs' });
  const code = String((req.body && req.body.code) || '').trim();
  let ok = totp.verifyTotp(u.totp_secret, code);
  if (!ok) {
    // acceptă și un cod de rezervă (o singură dată)
    let codes = [];
    try { codes = JSON.parse(u.totp_backup_codes || '[]'); } catch { codes = []; }
    const norm = code.replace(/\s+/g, '').toLowerCase();
    const idx = codes.findIndex((h) => h === crypto.createHash('sha256').update(norm).digest('hex'));
    if (idx !== -1) {
      ok = true;
      codes.splice(idx, 1);
      await db.prepare('UPDATE users SET totp_backup_codes = ? WHERE id = ?').run(JSON.stringify(codes), u.id);
    }
  }
  if (!ok) return res.status(401).json({ error: 'cod greșit' });
  delete req.session.pending2fa;
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'eroare server' });
    req.session.authed = true;
    req.session.userId = u.id;
    req.session.displayName = u.display_name;
    req.session.role = u.is_admin ? 'admin' : 'user';
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    req.session.save(() => res.json({ ok: true, role: req.session.role, user: pubUser(u) }));
  });
});

app.post('/api/account/2fa/setup', requireAccount, checkCsrf, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(400).json({ error: 'niciun cont' });
  const secret = totp.randomBase32Secret();
  req.session.pendingTotpSecret = secret;
  const url = totp.otpauthURL({ secret, label: u.username, issuer: 'Cloud' });
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  req.session.save(() => res.json({ secret, qr }));
});

app.post('/api/account/2fa/confirm', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  const u = await currentUser(req);
  const secret = req.session && req.session.pendingTotpSecret;
  if (!u || !secret) return res.status(400).json({ error: 'pornește mai întâi configurarea' });
  const code = String((req.body && req.body.code) || '');
  if (!totp.verifyTotp(secret, code)) return res.status(401).json({ error: 'cod greșit' });
  const backup = totp.genBackupCodes();
  const hashed = backup.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
  await db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?')
    .run(secret, JSON.stringify(hashed), u.id);
  delete req.session.pendingTotpSecret;
  req.session.save(() => res.json({ ok: true, backupCodes: backup }));
});

app.post('/api/account/2fa/disable', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  const cu = await currentUser(req);
  if (!cu) return res.status(400).json({ error: 'niciun cont' });
  const u = await db.prepare('SELECT id, pass_hash FROM users WHERE id = ?').get(cu.id);
  const password = String((req.body && req.body.password) || '');
  let ok = false;
  try { ok = u.pass_hash && await bcrypt.compare(password, u.pass_hash); } catch { ok = false; }
  if (!ok) return res.status(401).json({ error: 'parolă greșită' });
  await db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?').run(u.id);
  res.json({ ok: true });
});

app.patch('/api/account', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.status(400).json({ error: 'niciun cont' });
  const name = String((req.body && req.body.displayName) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'nume gol' });
  await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, u.id);
  await db.prepare('UPDATE albums SET owner_name = ? WHERE owner_id = ?').run(name, u.id);
  req.session.displayName = name;
  res.json({ ok: true, user: pubUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

app.post('/api/account/avatar', requireAccount, checkCsrf, avatarUpload.single('avatar'), async (req, res) => {
  const u = await currentUser(req);
  if (!u || !req.file) { if (req.file) try { fs.rmSync(req.file.path, { force: true }); } catch {} return res.status(400).json({ error: 'lipsește imaginea' }); }
  try {
    await require('sharp')(req.file.path, { failOn: 'none' }).rotate()
      .resize(200, 200, { fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(AVATAR_DIR, u.id + '.webp'));
    await db.prepare('UPDATE users SET has_avatar = 1 WHERE id = ?').run(u.id);
    res.json({ ok: true, avatar: '/api/users/' + u.id + '/avatar?t=' + Date.now() });
  } catch (e) { res.status(400).json({ error: 'imagine invalidă' }); }
  finally { try { fs.rmSync(req.file.path, { force: true }); } catch {} }
});

app.get('/api/users/:id/avatar', async (req, res) => {
  const u = await db.prepare('SELECT id, display_name, has_avatar FROM users WHERE id = ?').get(String(req.params.id));
  const p = u && u.has_avatar ? path.join(AVATAR_DIR, u.id + '.webp') : null;
  if (p && fs.existsSync(p)) {
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/webp');
    return fs.createReadStream(p).pipe(res);
  }
  // inițiale ca SVG
  const nm = (u && u.display_name || '?').trim();
  const ini = nm.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const hue = [...nm].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="hsl(' + hue + ',45%,55%)"/><text x="100" y="100" dy="0.35em" font-family="Roboto,sans-serif" font-size="88" fill="#fff" text-anchor="middle">' + ini + '</text></svg>');
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/csrf', async (req, res) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  const u = await currentUser(req);
  req.session.save(() => res.json({ token: req.session.csrf, role: req.session.role || 'guest', user: pubUser(u) }));
});

// ─── Notificări push (browser) ─────────────────────────────────────────────
app.get('/api/push/config', (req, res) => res.json({ enabled: push.enabled, publicKey: push.publicKey }));

app.post('/api/push/subscribe', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  const u = await currentUser(req);
  try {
    await push.subscribe(u ? u.id : null, req.body && req.body.subscription);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message || 'abonament invalid' }); }
});

app.post('/api/push/unsubscribe', checkCsrf, jsonBody, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) await push.unsubscribe(String(endpoint));
  res.json({ ok: true });
});

// ─── Folder blocat (PIN) ───────────────────────────────────────────────────
const getSetting = async (k) => { const r = await db.prepare('SELECT value FROM settings WHERE `key` = ?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)').run(k, v);
const lockConfigured = async () => !!(await getSetting('lock_pin_hash'));
function requireLockOpen(req, res, next) {
  if (req.session && req.session.lockOpen) return next();
  return res.status(403).json({ error: 'folder blocat' });
}
const PIN_RE = /^[0-9]{4,12}$/;
const lockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe încercări' } });

app.get('/api/lock/status', async (req, res) => {
  res.json({ configured: await lockConfigured(), open: !!(req.session && req.session.lockOpen) });
});

app.post('/api/lock/setup', checkCsrf, express.json({ limit: '4kb' }), async (req, res) => {
  const pin = String(req.body && req.body.pin || '');
  const current = String(req.body && req.body.current || '');
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'PIN-ul trebuie să aibă 4–12 cifre' });
  if (await lockConfigured()) {
    const ok = await bcrypt.compare(current, await getSetting('lock_pin_hash')).catch(() => false);
    if (!ok) return res.status(403).json({ error: 'PIN-ul curent e greșit' });
  }
  await setSetting('lock_pin_hash', await bcrypt.hash(pin, 10));
  req.session.lockOpen = true;
  req.session.save(() => res.json({ ok: true }));
});

app.post('/api/lock/unlock', lockLimiter, checkCsrf, express.json({ limit: '4kb' }), async (req, res) => {
  if (!(await lockConfigured())) return res.status(400).json({ error: 'niciun PIN setat' });
  const pin = String(req.body && req.body.pin || '');
  const ok = await bcrypt.compare(pin, await getSetting('lock_pin_hash')).catch(() => false);
  if (!ok) return res.status(401).json({ error: 'PIN greșit' });
  req.session.lockOpen = true;
  req.session.save(() => res.json({ ok: true }));
});

app.post('/api/lock/close', checkCsrf, (req, res) => {
  if (req.session) req.session.lockOpen = false;
  res.json({ ok: true });
});

// Mută în / scoate din folderul blocat (necesită folderul deschis)
app.post('/api/media/:id/lock', requireLockOpen, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE media SET locked = 1 WHERE id = ?').run(row.id);
  await db.prepare('DELETE FROM album_items WHERE media_id = ?').run(row.id);
  res.json({ ok: true });
});
app.delete('/api/media/:id/lock', requireLockOpen, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE media SET locked = 0 WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ─── Listă media ────────────────────────────────────────────────────────────
const backup = require('./lib/backup');
const joblog = require('./lib/joblog');

// Panou stare/backup (admin)
app.get('/api/admin/health', requireAdmin, async (req, res) => {
  const by = await db.prepare(`
    SELECT type, COUNT(*) n, COALESCE(SUM(size),0) bytes
    FROM media WHERE deleted_at IS NULL GROUP BY type
  `).all();
  const trashed = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM media WHERE deleted_at IS NOT NULL').get();
  let integrity = { total: 0, missing: 0 };
  try { integrity = await backup.checkIntegrity(ORIGINAL_DIR); } catch {}
  let fsInfo = null;
  try { const st = fs.statfsSync(ORIGINAL_DIR); fsInfo = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch {}
  res.json({
    media: by,
    trash: { count: trashed.n, bytes: trashed.b },
    albums: (await db.prepare('SELECT COUNT(*) n FROM albums').get()).n,
    people: (await db.prepare('SELECT COUNT(*) n FROM face_clusters WHERE n >= 2').get()).n,
    embeddings: (await db.prepare('SELECT COUNT(*) n FROM media_embed').get()).n,
    tags: (await db.prepare('SELECT COUNT(DISTINCT tag) n FROM media_tags').get()).n,
    comments: (await db.prepare('SELECT COUNT(*) n FROM album_comments').get()).n,
    integrity, fs: fsInfo,
    lastBackup: backup.lastBackup(),
    jobHistory: await joblog.recent(15),
  });
});

app.post('/api/admin/backup', requireAdmin, checkCsrf, async (req, res) => {
  const f = await backup.backupNow();
  res.json({ ok: !!f, file: f ? path.basename(f) : null, lastBackup: backup.lastBackup() });
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const usedBytes = (await db.prepare('SELECT COALESCE(SUM(size), 0) s FROM media').get()).s;
  let totalBytes = STORAGE_LIMIT_GB > 0 ? STORAGE_LIMIT_GB * 1e9 : 0;
  if (!totalBytes) {
    // spațiul volumului unde stau efectiv pozele (poate fi alt disc / NFS)
    try { const st = fs.statfsSync(ORIGINAL_DIR); totalBytes = st.blocks * st.bsize; } catch { totalBytes = 0; }
  }
  const count = (await db.prepare('SELECT COUNT(*) n FROM media WHERE deleted_at IS NULL AND locked = 0 AND is_live_motion = 0').get()).n;
  res.json({ usedBytes, totalBytes, count });
});

// Optimizare spațiu (recompresie) — job în fundal
app.post('/api/optimize', requireAdmin, checkCsrf, jsonBody, async (req, res) => {
  if (optimize.current() && !optimize.current().finishedAt) {
    return res.status(409).json({ error: 'o optimizare rulează deja' });
  }
  const mode = req.body && req.body.mode === 'aggressive' ? 'aggressive' : 'safe';
  const withVideo = !!(req.body && req.body.video);
  const job = await optimize.start({ mode, withVideo });
  res.json({ jobId: job.id });
});

app.get('/api/optimize/status/:id', requireAuth, (req, res) => {
  const job = optimize.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'job necunoscut' });
  res.json(job);
});

// ─── Căutare inteligentă (CLIP + OCR) ─────────────────────────────────────
const search = require('./lib/search');

app.get('/api/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  let ids = [];
  try { ids = await search.search(q, { limit: 150 }); } catch (e) { return res.status(500).json({ error: 'căutare eșuată' }); }
  const get = db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE id = ? AND deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0`);
  const rows = (await Promise.all(ids.map((id) => get.get(id)))).filter(Boolean).map(mapRow);
  res.json(rows);
});

app.get('/api/search/stats', requireAuth, async (req, res) => {
  try { res.json(await search.stats()); } catch { res.json({ embed: 0, ocr: 0, total: 0 }); }
});

app.post('/api/search/index', requireAdmin, checkCsrf, jsonBody, (req, res) => {
  const cur = search.current();
  if (cur && !cur.finishedAt && cur.phase !== 'error') return res.status(409).json({ error: 'indexarea rulează deja' });
  const j = search.newJob();
  search.runIndex(j, { ocr: !!(req.body && req.body.ocr) }).catch((e) => console.error('index:', e));
  res.json({ jobId: j.id });
});

app.get('/api/search/index/status/:id', requireAuth, (req, res) => {
  const j = search.getJob(String(req.params.id));
  if (!j) return res.status(404).json({ error: 'job necunoscut' });
  res.json(j);
});

// ─── „Lucruri" (categorii CLIP zero-shot) ────────────────────────────────
app.get('/api/things', requireAuth, async (req, res) => {
  try { res.json(await search.things()); } catch { res.json([]); }
});

app.get('/api/things/:tag', requireAuth, async (req, res) => {
  let ids = [];
  try { ids = await search.thingItems(req.params.tag); } catch { ids = []; }
  const get = db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE id = ?`);
  const rows = (await Promise.all(ids.map((id) => get.get(id)))).filter(Boolean).map(mapRow);
  res.json({ tag: String(req.params.tag), items: rows });
});

app.post('/api/search/retag', requireAdmin, checkCsrf, (req, res) => {
  const cur = search.current();
  if (cur && !cur.finishedAt && cur.phase !== 'error') return res.status(409).json({ error: 'un job rulează deja' });
  const j = search.newJob();
  search.runRetag(j).catch((e) => console.error('retag:', e));
  res.json({ jobId: j.id });
});

// ─── Duplicate ───────────────────────────────────────────────────────────
app.get('/api/duplicates', requireAuth, async (req, res) => {
  const seen = new Set();
  const groups = [];
  // exacte: acelasi sha256
  const exactRows = await db.prepare(`
    SELECT sha256, GROUP_CONCAT(id) ids FROM media
    WHERE sha256 IS NOT NULL AND deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0
    GROUP BY sha256 HAVING COUNT(*) > 1
  `).all();
  for (const r of exactRows) {
    const ids = r.ids.split(',');
    ids.forEach((i) => seen.add(i));
    groups.push({ kind: 'exact', ids });
  }
  // aproape-identice: cosinus embeddings
  if (req.query.near !== '0') {
    try {
      for (const g of await search.nearDuplicates()) {
        const ids = g.filter((i) => !seen.has(i));
        if (ids.length > 1) { ids.forEach((i) => seen.add(i)); groups.push({ kind: 'similar', ids }); }
      }
    } catch { /* fără embeddings */ }
  }
  const get = db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE id = ?`);
  const out = [];
  for (const g of groups) {
    const items = (await Promise.all(g.ids.map((id) => get.get(id)))).filter(Boolean).map(mapRow)
      .sort((a, b) => (b.size || 0) - (a.size || 0));
    out.push({ kind: g.kind, items });
  }
  res.json(out.filter((g) => g.items.length > 1));
});

// ─── Curățare inteligentă spațiu ────────────────────────────────────────────
const BLUR_CUTOFF = 40; // varianța Laplacianului sub asta = probabil neclară
const LARGE_VIDEO_BYTES = 200 * 1024 * 1024;
const OLD_SCREENSHOT_DAYS = 90;

app.get('/api/cleanup/suggestions', requireAuth, async (req, res) => {
  const live = 'deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0';
  const blurryRows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE ${live} AND type = 'image' AND blur_done = 1 AND blur_score IS NOT NULL AND blur_score < ?
    ORDER BY blur_score ASC LIMIT 200
  `).all(BLUR_CUTOFF);

  const cutoffDate = new Date(Date.now() - OLD_SCREENSHOT_DAYS * 86400000).toISOString();
  const oldScreenshotRows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE ${live} AND kind_auto = 'screenshot' AND COALESCE(taken_at, created_at) < ?
    ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 200
  `).all(cutoffDate);

  const largeVideoRows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE ${live} AND type = 'video' AND size > ?
    ORDER BY size DESC LIMIT 200
  `).all(LARGE_VIDEO_BYTES);

  res.json({
    blurry: blurryRows.map(mapRow),
    oldScreenshots: oldScreenshotRows.map(mapRow),
    largeVideos: largeVideoRows.map(mapRow),
  });
});

// ─── Persoane (grupare fețe) ─────────────────────────────────────────────
const faces = require('./lib/faces');

app.get('/api/people', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT c.id, c.name, c.n,
           (SELECT f.media_id FROM faces f WHERE f.id = c.cover_face_id) AS coverMediaId,
           c.cover_face_id AS coverFaceId
    FROM face_clusters c
    WHERE c.n >= 2
    ORDER BY (c.name IS NULL), c.n DESC
  `).all();
  res.json(rows);
});

app.get('/api/people/:cid', requireAuth, async (req, res) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid)) return res.status(404).json({ error: 'nu există' });
  const cl = await db.prepare('SELECT id, name, n, cover_face_id AS coverFaceId, linked_user_id AS linkedUserId FROM face_clusters WHERE id = ?').get(cid);
  if (!cl) return res.status(404).json({ error: 'nu există' });
  const rawRows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE id IN (SELECT DISTINCT media_id FROM faces WHERE cluster_id = ?)
      AND deleted_at IS NULL AND locked = 0 AND is_live_motion = 0
    ORDER BY COALESCE(taken_at, created_at) DESC
  `).all(cid);
  const rows = rawRows.map(mapRow);
  const faceOf = db.prepare('SELECT id FROM faces WHERE cluster_id = ? AND media_id = ? LIMIT 1');
  for (const r of rows) { const f = await faceOf.get(cid, r.id); r.faceId = f ? f.id : null; }
  res.json({ person: cl, items: rows });
});

app.patch('/api/people/:cid', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  const cid = String(req.params.cid);
  const cl = await db.prepare('SELECT id FROM face_clusters WHERE id = ?').get(cid);
  if (!cl) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};
  if ('name' in b) {
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    await db.prepare('UPDATE face_clusters SET name = ? WHERE id = ?').run(name || null, cid);
  }
  if ('coverFaceId' in b) {
    const fid = String(b.coverFaceId || '');
    const ok = UUID_RE.test(fid) && await db.prepare('SELECT 1 FROM faces WHERE id = ? AND cluster_id = ?').get(fid, cid);
    if (!ok) return res.status(400).json({ error: 'fața nu e a persoanei' });
    await db.prepare('UPDATE face_clusters SET cover_face_id = ? WHERE id = ?').run(fid, cid);
  }
  if ('linkedUserId' in b) {
    const uid = String(b.linkedUserId || '');
    if (!uid) {
      await db.prepare('UPDATE face_clusters SET linked_user_id = NULL WHERE id = ?').run(cid);
    } else {
      const u = await db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
      if (!u) return res.status(400).json({ error: 'cont inexistent' });
      await db.prepare('UPDATE face_clusters SET linked_user_id = ? WHERE id = ?').run(uid, cid);
    }
  }
  const out = await db.prepare('SELECT id, name, n, cover_face_id AS coverFaceId, linked_user_id AS linkedUserId FROM face_clusters WHERE id = ?').get(cid);
  res.json({ ok: true, person: out, name: out.name });
});

// Utilizatori cu care se poate lega o persoană recunoscută (pentru sugestii de partajare)
app.get('/api/users/list', requireAuth, async (req, res) => {
  const rows = await db.prepare('SELECT id, username, display_name FROM users ORDER BY display_name').all();
  res.json(rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })));
});

// Unește persoana `cid` în persoana `into`
app.post('/api/people/:cid/merge', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  const from = String(req.params.cid);
  const into = String((req.body && req.body.into) || '');
  if (from === into) return res.status(400).json({ error: 'aceeași persoană' });
  const a = await db.prepare('SELECT * FROM face_clusters WHERE id = ?').get(into);
  const b = await db.prepare('SELECT * FROM face_clusters WHERE id = ?').get(from);
  if (!a || !b) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE faces SET cluster_id = ? WHERE cluster_id = ?').run(into, from);
  const n = (await db.prepare('SELECT COUNT(*) c FROM faces WHERE cluster_id = ?').get(into)).c;
  const name = a.name || b.name || null;
  const cover = a.cover_face_id || b.cover_face_id || null;
  await db.prepare('UPDATE face_clusters SET n = ?, name = ?, cover_face_id = ? WHERE id = ?').run(n, name, cover, into);
  await db.prepare('DELETE FROM face_clusters WHERE id = ?').run(from);
  res.json({ ok: true, into });
});

// Scoate toate fețele unei poze din persoana `cid` („nu e ea în poza asta")
app.post('/api/people/:cid/remove', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  const cid = String(req.params.cid);
  const mediaId = String((req.body && req.body.mediaId) || '');
  if (!UUID_RE.test(mediaId)) return res.status(400).json({ error: 'poză invalidă' });
  const cl = await db.prepare('SELECT id FROM face_clusters WHERE id = ?').get(cid);
  if (!cl) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE faces SET cluster_id = NULL WHERE cluster_id = ? AND media_id = ?').run(cid, mediaId);
  const n = (await db.prepare('SELECT COUNT(*) c FROM faces WHERE cluster_id = ?').get(cid)).c;
  if (n <= 0) await db.prepare('DELETE FROM face_clusters WHERE id = ?').run(cid);
  else await db.prepare('UPDATE face_clusters SET n = ? WHERE id = ?').run(n, cid);
  res.json({ ok: true });
});

app.delete('/api/people/:cid', requireAuth, checkCsrf, async (req, res) => {
  // „nu e o persoană" — ascunde clusterul (îl golim de fețe, rămâne inert)
  const cid = String(req.params.cid);
  await db.prepare('UPDATE faces SET cluster_id = NULL WHERE cluster_id = ?').run(cid);
  await db.prepare('DELETE FROM face_clusters WHERE id = ?').run(cid);
  res.json({ ok: true });
});

app.get('/api/faces/:fid/crop', requireAuth, async (req, res) => {
  const fid = String(req.params.fid);
  if (!UUID_RE.test(fid)) return res.status(404).end();
  const f = await db.prepare('SELECT box, media_id FROM faces WHERE id = ?').get(fid);
  if (!f) return res.status(404).end();
  const m = await db.prepare('SELECT stored_name, locked FROM media WHERE id = ?').get(f.media_id);
  if (!m || (m.locked && !(req.session && req.session.lockOpen))) return res.status(404).end();
  const src = path.join(ORIGINAL_DIR, m.stored_name);
  if (!fs.existsSync(src)) return res.status(404).end();
  try {
    const meta = await require('sharp')(src).metadata();
    const [fx, fy, fw, fh] = JSON.parse(f.box);
    const W = meta.width, H = meta.height;
    // margine 25% în jurul feței
    let left = Math.round((fx - fw * 0.25) * W);
    let top = Math.round((fy - fh * 0.25) * H);
    let width = Math.round(fw * 1.5 * W);
    let height = Math.round(fh * 1.5 * H);
    left = Math.max(0, Math.min(left, W - 2));
    top = Math.max(0, Math.min(top, H - 2));
    width = Math.max(2, Math.min(width, W - left));
    height = Math.max(2, Math.min(height, H - top));
    const buf = await require('sharp')(src).extract({ left, top, width, height })
      .resize(200, 200, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch { res.status(404).end(); }
});

app.get('/api/faces/stats', requireAuth, async (req, res) => {
  const total = (await db.prepare("SELECT COUNT(*) n FROM media WHERE type='image' AND deleted_at IS NULL").get()).n;
  const done = (await db.prepare("SELECT COUNT(*) n FROM media WHERE type='image' AND deleted_at IS NULL AND faces_done = 1").get()).n;
  const nfaces = (await db.prepare('SELECT COUNT(*) n FROM faces').get()).n;
  const people = (await db.prepare('SELECT COUNT(*) n FROM face_clusters WHERE n >= 2').get()).n;
  res.json({ total, done, faces: nfaces, people });
});

app.post('/api/faces/index', requireAdmin, checkCsrf, (req, res) => {
  const cur = faces.current();
  if (cur && !cur.finishedAt && cur.phase !== 'error') return res.status(409).json({ error: 'indexarea rulează deja' });
  const j = faces.newJob();
  faces.runIndex(j).catch((e) => console.error('faces:', e));
  res.json({ jobId: j.id });
});

app.get('/api/faces/index/status/:id', requireAuth, (req, res) => {
  const j = faces.getJob(String(req.params.id));
  if (!j) return res.status(404).json({ error: 'job necunoscut' });
  res.json(j);
});

app.get('/api/media', requireAuth, async (req, res) => {
  const f = String(req.query.filter || 'all');
  let where;
  let order = 'ORDER BY COALESCE(taken_at, created_at) DESC, created_at DESC';
  const live = 'deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0';
  if (f === 'locked') {
    if (!(req.session && req.session.lockOpen)) return res.status(403).json({ error: 'folder blocat' });
    where = 'deleted_at IS NULL AND locked = 1';
  }
  else if (f === 'favorites') where = 'deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0 AND favorite = 1';
  else if (f === 'archive') where = 'deleted_at IS NULL AND archived = 1 AND locked = 0 AND is_live_motion = 0';
  else if (f === 'trash') { where = 'deleted_at IS NOT NULL AND locked = 0 AND is_live_motion = 0'; order = 'ORDER BY deleted_at DESC'; }
  else if (f === 'videos') where = live + " AND type = 'video'";
  else if (f === 'screenshots') where = live + " AND kind_auto = 'screenshot'";
  else if (f === 'selfies') where = live + " AND kind_auto = 'selfie'";
  else if (f === 'geo') where = live + ' AND lat IS NOT NULL';
  else where = live;

  const rows = await db.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE ${where} ${order}`).all();
  res.json(rows.map(mapRow));
});

// „Locuri" — toate mediile geotag-uite, pentru vizualizarea pe hartă
const geo = require('./lib/geo');
app.get('/api/places', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, type, lat, lon, place, city, country, taken_at AS takenAt, created_at AS createdAt
    FROM media
    WHERE deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0 AND lat IS NOT NULL AND lon IS NOT NULL
    ORDER BY COALESCE(taken_at, created_at) DESC
  `).all();
  res.json(rows);
});

app.get('/api/places/summary', requireAuth, async (req, res) => {
  try { res.json(await geo.placesSummary()); } catch { res.json([]); }
});

const geoSearchLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe căutări, așteaptă puțin' } });
app.get('/api/geo/search', requireAuth, geoSearchLimiter, async (req, res) => {
  try { res.json(await geo.search(String(req.query.q || ''))); } catch { res.json([]); }
});

// „Categorii" — câte elemente în fiecare secțiune automată
app.get('/api/categories', requireAuth, async (req, res) => {
  const live = 'deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0';
  const one = async (w) => (await db.prepare(`SELECT COUNT(*) n FROM media WHERE ${live} AND ${w}`).get()).n;
  res.json({
    videos: await one("type = 'video'"),
    screenshots: await one("kind_auto = 'screenshot'"),
    selfies: await one("kind_auto = 'selfie'"),
    geo: await one('lat IS NOT NULL'),
  });
});

// „Amintiri” — poze din aceeași zi calendaristică, din anii trecuți
app.get('/api/memories', requireAuth, async (req, res) => {
  const now = new Date();
  const md = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const rawRows = await db.prepare(`
    SELECT ${MEDIA_COLS} FROM media
    WHERE deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0
      AND DATE_FORMAT(COALESCE(taken_at, created_at), '%m-%d') = ?
      AND CAST(DATE_FORMAT(COALESCE(taken_at, created_at), '%Y') AS SIGNED) < ?
    ORDER BY COALESCE(taken_at, created_at) DESC
  `).all(md, now.getFullYear());
  res.json(rawRows.map(mapRow));
});

// „Sugestii de film" — zile din trecutul apropiat cu multe poze, bune pt. slideshow
app.get('/api/events/suggestions', requireAuth, async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const days = await db.prepare(`
    SELECT DATE_FORMAT(COALESCE(taken_at, created_at), '%Y-%m-%d') AS day, COUNT(*) n
    FROM media
    WHERE deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0 AND type = 'image'
      AND COALESCE(taken_at, created_at) >= ? AND COALESCE(taken_at, created_at) < ?
    GROUP BY day HAVING COUNT(*) >= 4
    ORDER BY day DESC LIMIT 5
  `).all(since, today);
  const out = [];
  for (const d of days) {
    const rawRows = await db.prepare(`
      SELECT ${MEDIA_COLS} FROM media
      WHERE deleted_at IS NULL AND archived = 0 AND locked = 0 AND is_live_motion = 0 AND type = 'image'
        AND DATE_FORMAT(COALESCE(taken_at, created_at), '%Y-%m-%d') = ?
      ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 40
    `).all(d.day);
    out.push({ date: d.day, count: d.n, items: rawRows.map(mapRow) });
  }
  res.json(out);
});

// Context: în ce albume e poza, dacă e partajată, ce persoane apar
app.get('/api/media/:id/context', requireAuth, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  const albums = await db.prepare(`
    SELECT a.id, a.name FROM album_items ai JOIN albums a ON a.id = ai.album_id
    WHERE ai.media_id = ? ORDER BY a.name
  `).all(row.id);
  let people = [];
  try {
    people = await db.prepare(`
      SELECT c.id AS cid, c.name, f.id AS faceId
      FROM faces f JOIN face_clusters c ON c.id = f.cluster_id
      WHERE f.media_id = ? AND c.n >= 2
    `).all(row.id);
  } catch { people = []; }
  let tags = [];
  try { tags = (await db.prepare('SELECT tag FROM media_tags WHERE media_id = ? ORDER BY score DESC').all(row.id)).map((t) => t.tag); } catch {}
  res.json({ albums, shared: !!row.share_token, people, tags, place: row.place || null });
});

// Actualizează favorite / arhivat / descriere
app.patch('/api/media/:id', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};
  const sets = [];
  const vals = { id: row.id };
  if ('favorite' in b) { sets.push('favorite = :favorite'); vals.favorite = b.favorite ? 1 : 0; }
  if ('archived' in b) { sets.push('archived = :archived'); vals.archived = b.archived ? 1 : 0; }
  if ('caption' in b) { sets.push('caption = :caption'); vals.caption = String(b.caption || '').slice(0, 2000); }
  if ('lat' in b && 'lon' in b) {
    const lat = Number(b.lat), lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ error: 'coordonate invalide' });
    }
    sets.push('lat = :lat', 'lon = :lon', 'place_done = 0');
    vals.lat = lat; vals.lon = lon;
  }
  if (sets.length) await db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = :id`).run(vals);
  if ('lat' in b && 'lon' in b) {
    const g = await geo.reverse(vals.lat, vals.lon).catch(() => null);
    if (g) await db.prepare('UPDATE media SET place = ?, city = ?, country = ?, place_done = 1 WHERE id = ?')
      .run(g.place || null, g.city || null, g.country || null, row.id);
  }
  res.json({ ok: true });
});

// Descărcare în bloc a mai multor elemente, ca arhivă ZIP
app.get('/api/download', requireAuth, async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'nimic de descărcat' });

  const getStmt = db.prepare('SELECT * FROM media WHERE id = ?');
  const rows = (await Promise.all(ids.map((id) => getStmt.get(id))))
    .filter((r) => r && !r.deleted_at && (!r.locked || (req.session && req.session.lockOpen)));
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
app.post('/api/media/:id/trash', requireAdmin, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  res.json({ ok: true });
});

app.post('/api/media/:id/restore', requireAdmin, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.post('/api/trash/empty', requireAdmin, checkCsrf, async (req, res) => {
  const rows = await db.prepare('SELECT id, stored_name FROM media WHERE deleted_at IS NOT NULL').all();
  for (const r of rows) {
    fs.rmSync(path.join(ORIGINAL_DIR, r.stored_name), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.webp`), { force: true });
    fs.rmSync(path.join(THUMB_DIR, `${r.id}.preview.webp`), { force: true });
    await db.prepare('DELETE FROM media WHERE id = ?').run(r.id);
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

app.post('/api/upload', requireAccount, uploadLimiter, checkCsrf, upload.array('files', 50), async (req, res, next) => {
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

app.post('/api/import/takeout', requireAdmin, checkCsrf, importUpload.single('file'), async (req, res) => {
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
async function mediaServeGuard(req, res, next) {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).end();
  if (row.locked && !(req.session && req.session.lockOpen)) return res.status(404).end();
  req.mediaRow = row;
  next();
}
app.get('/media/:id/thumb', requireAuth, mediaServeGuard, (req, res) => sendThumb(req.mediaRow, res));
app.get('/media/:id/full', requireAuth, mediaServeGuard, (req, res) => sendFull(req.mediaRow, res));
app.get('/media/:id/preview', requireAuth, mediaServeGuard, (req, res) => {
  const p = path.join(THUMB_DIR, req.mediaRow.id + '.preview.webp');
  if (fs.existsSync(p)) {
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/webp');
    return fs.createReadStream(p).pipe(res);
  }
  return sendFull(req.mediaRow, res);
});

// ─── Editare video (ffmpeg) + cadru -> poză ──────────────────────────────
const vedit = require('./lib/vedit');

app.get('/media/:id/frame', requireAuth, mediaServeGuard, async (req, res) => {
  const row = req.mediaRow;
  if (row.type !== 'video') return res.status(400).end();
  try {
    const buf = await vedit.frameBuffer(path.join(ORIGINAL_DIR, row.stored_name), req.query.t);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(buf);
  } catch { res.status(500).end(); }
});

app.post('/api/media/:id/frame', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row || row.type !== 'video') return res.status(404).json({ error: 'nu există' });
  if (row.locked && !(req.session && req.session.lockOpen)) return res.status(404).json({ error: 'nu există' });
  try {
    const r = await vedit.saveFrame(path.join(ORIGINAL_DIR, row.stored_name), row.original_name, req.body && req.body.t);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message || 'eroare' }); }
});

app.post('/api/media/:id/video-edit', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  if (!vedit.available) return res.status(501).json({ error: 'ffmpeg indisponibil' });
  const row = await getRow(req.params.id);
  if (!row || row.type !== 'video') return res.status(404).json({ error: 'nu există' });
  if (row.locked && !(req.session && req.session.lockOpen)) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};
  const j = vedit.newJob('Editare video');
  vedit.runVideoEdit(j, path.join(ORIGINAL_DIR, row.stored_name), row.original_name, {
    start: b.start, end: b.end, mute: b.mute, rotate: b.rotate,
  }).catch((e) => console.error('vedit:', e));
  res.json({ jobId: j.id });
});

app.get('/api/video-edit/status/:id', requireAuth, (req, res) => {
  const j = vedit.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job necunoscut' });
  res.json(j);
});

// ─── Slideshow -> mp4 ────────────────────────────────────────────────────
app.post('/api/slideshow', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  if (!vedit.available) return res.status(501).json({ error: 'ffmpeg indisponibil' });
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
    .filter((x) => UUID_RE.test(String(x))).slice(0, 80);
  const getStmt = db.prepare('SELECT id, type, stored_name, locked FROM media WHERE id = ? AND deleted_at IS NULL');
  const rows = (await Promise.all(ids.map((id) => getStmt.get(id))))
    .filter((r) => r && r.type === 'image' && (!r.locked || (req.session && req.session.lockOpen)));
  if (rows.length < 2) return res.status(400).json({ error: 'alege cel puțin 2 poze' });
  const files = rows.map((r) => {
    const pv = path.join(THUMB_DIR, r.id + '.preview.webp');
    return fs.existsSync(pv) ? pv : path.join(ORIGINAL_DIR, r.stored_name);
  });
  const j = vedit.newJob('Slideshow');
  vedit.runSlideshow(j, files, { seconds: req.body.seconds, kenburns: req.body.kenburns })
    .catch((e) => console.error('slideshow:', e));
  res.json({ jobId: j.id });
});

app.get('/api/slideshow/status/:id', requireAuth, (req, res) => {
  const j = vedit.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job necunoscut' });
  res.json({ id: j.id, phase: j.phase, error: j.error, ready: j.phase === 'done' });
});

app.get('/api/slideshow/:id/download', requireAuth, (req, res) => {
  const j = vedit.getJob(req.params.id);
  if (!j || j.phase !== 'done' || !j.file || !fs.existsSync(j.file)) return res.status(404).end();
  res.download(j.file, 'slideshow.mp4');
});

// ─── Animație -> WebP animat (util „Animation" gen Google Photos) ─────────
app.post('/api/animation', requireAccount, checkCsrf, jsonBody, async (req, res) => {
  if (!vedit.available) return res.status(501).json({ error: 'ffmpeg indisponibil' });
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
    .filter((x) => UUID_RE.test(String(x))).slice(0, 12);
  const getStmt = db.prepare('SELECT id, type, stored_name, locked FROM media WHERE id = ? AND deleted_at IS NULL');
  const rows = (await Promise.all(ids.map((id) => getStmt.get(id))))
    .filter((r) => r && r.type === 'image' && (!r.locked || (req.session && req.session.lockOpen)));
  if (rows.length < 2) return res.status(400).json({ error: 'alege cel puțin 2 poze' });
  const files = rows.map((r) => path.join(ORIGINAL_DIR, r.stored_name));
  const j = vedit.newJob('Animație');
  vedit.runAnimation(j, files, {}).catch((e) => console.error('animation:', e));
  res.json({ jobId: j.id });
});

app.get('/api/animation/status/:id', requireAuth, (req, res) => {
  const j = vedit.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job necunoscut' });
  res.json({ id: j.id, phase: j.phase, error: j.error, mediaId: j.mediaId || null });
});

// ─── Ștergere ───────────────────────────────────────────────────────────────
app.delete('/api/media/:id', requireAdmin, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });

  fs.rmSync(path.join(ORIGINAL_DIR, row.stored_name), { force: true });
  fs.rmSync(path.join(THUMB_DIR, `${row.id}.webp`), { force: true });
  fs.rmSync(path.join(THUMB_DIR, `${row.id}.preview.webp`), { force: true });
  await db.prepare('DELETE FROM media WHERE id = ?').run(row.id); // cascade album_items
  res.json({ ok: true });
});

// ─── Albume ─────────────────────────────────────────────────────────────────
app.get('/api/albums', requireAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all();
  res.json(await Promise.all(rows.map(albumSummary)));
});

app.post('/api/albums', requireAuth, checkCsrf, jsonBody, async (req, res) => {
  const name = String(req.body && req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'nume gol' });
  const u = await currentUser(req);
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO albums (id, name, created_at, owner_id, owner_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, new Date().toISOString(), u ? u.id : null, u ? u.display_name : (req.session.role === 'admin' ? 'Administrator' : 'Vizitator'));
  res.json(await albumSummary(await getAlbum(id)));
});

// Poate edita/șterge albumul: proprietarul, un admin, sau oricine conectat pentru
// albumele fără proprietar (create înainte de sistemul de conturi).
async function requireAlbumOwner(req, res, next) {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const isAdmin = req.session && req.session.role === 'admin';
  const isOwner = a.owner_id && req.session && req.session.userId === a.owner_id;
  const legacy = !a.owner_id && req.session && req.session.authed;
  if (isAdmin || isOwner || legacy) { req.album = a; return next(); }
  return res.status(403).json({ error: 'doar cel care a creat albumul îl poate modifica' });
}

app.get('/api/albums/:id', requireAuth, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  res.json({ album: await albumSummary(a), items: await mediaInAlbum(a.id) });
});

app.patch('/api/albums/:id', requireAlbumOwner, checkCsrf, jsonBody, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const b = req.body || {};

  if ('name' in b) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'nume gol' });
    await db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, a.id);
  }
  if ('coverId' in b) {
    const cid = String(b.coverId || '');
    if (cid && !UUID_RE.test(cid)) return res.status(400).json({ error: 'copertă invalidă' });
    if (cid) {
      const member = await db.prepare('SELECT 1 FROM album_items WHERE album_id = ? AND media_id = ?').get(a.id, cid);
      if (!member) return res.status(400).json({ error: 'poza nu e în album' });
    }
    await db.prepare('UPDATE albums SET cover_id = ? WHERE id = ?').run(cid || null, a.id);
  }
  if ('allowComments' in b) await db.prepare('UPDATE albums SET allow_comments = ? WHERE id = ?').run(b.allowComments ? 1 : 0, a.id);
  if ('allowContrib' in b) await db.prepare('UPDATE albums SET allow_contrib = ? WHERE id = ?').run(b.allowContrib ? 1 : 0, a.id);
  res.json(await albumSummary(await getAlbum(a.id)));
});

app.delete('/api/albums/:id', requireAlbumOwner, checkCsrf, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  await db.prepare('DELETE FROM albums WHERE id = ?').run(a.id); // cascade album_items
  res.json({ ok: true });
});

app.post('/api/albums/:id/items', requireAlbumOwner, checkCsrf, jsonBody, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.filter((x) => UUID_RE.test(String(x))) : [];
  const ins = db.prepare('INSERT IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  let n = 0;
  for (const mid of ids) {
    if (await db.prepare('SELECT 1 FROM media WHERE id = ? AND locked = 0 AND is_live_motion = 0').get(mid)) {
      n += (await ins.run(a.id, mid, now)).changes;
    }
  }
  res.json({ added: n });
});

app.delete('/api/albums/:id/items', requireAlbumOwner, checkCsrf, jsonBody, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const ids = Array.isArray(req.body && req.body.ids)
    ? req.body.ids.filter((x) => UUID_RE.test(String(x))) : [];
  const del = db.prepare('DELETE FROM album_items WHERE album_id = ? AND media_id = ?');
  let n = 0;
  for (const mid of ids) n += (await del.run(a.id, mid)).changes;
  res.json({ removed: n });
});

// Creează / rotește linkul de partajare
app.post('/api/albums/:id/share', requireAlbumOwner, checkCsrf, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const token = crypto.randomBytes(24).toString('base64url');
  await db.prepare('UPDATE albums SET share_token = ?, share_created_at = ? WHERE id = ?')
    .run(token, new Date().toISOString(), a.id);
  res.json({ token, path: `/s/${token}` });
});

app.delete('/api/albums/:id/share', requireAlbumOwner, checkCsrf, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE albums SET share_token = NULL, share_created_at = NULL WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// Persoane recunoscute în album ale căror conturi pot fi notificate direct
app.get('/api/albums/:id/share-suggestions', requireAlbumOwner, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const rows = await db.prepare(`
    SELECT DISTINCT u.id, u.display_name AS displayName, u.has_avatar AS hasAvatar
    FROM face_clusters c
    JOIN faces f ON f.cluster_id = c.id
    JOIN album_items ai ON ai.media_id = f.media_id
    JOIN users u ON u.id = c.linked_user_id
    WHERE ai.album_id = ? AND u.id != ?
  `).all(a.id, a.owner_id || '');
  res.json(rows.map((u) => ({ id: u.id, displayName: u.displayName, avatar: '/api/users/' + u.id + '/avatar' })));
});

app.post('/api/albums/:id/share/notify', requireAlbumOwner, checkCsrf, jsonBody, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a || !a.share_token) return res.status(400).json({ error: 'albumul nu e partajat' });
  const userId = String((req.body && req.body.userId) || '');
  const suggested = await db.prepare(`
    SELECT 1 FROM face_clusters c JOIN faces f ON f.cluster_id = c.id JOIN album_items ai ON ai.media_id = f.media_id
    WHERE ai.album_id = ? AND c.linked_user_id = ?
  `).get(a.id, userId);
  if (!suggested) return res.status(400).json({ error: 'persoana nu apare în album' });
  const from = await currentUser(req);
  await push.sendToUser(userId, {
    title: (from ? from.display_name + ' ți-a' : 'Ți-au') + ' partajat albumul „' + a.name + '"',
    body: 'Apari în pozele din acest album.',
    url: '/s/' + a.share_token,
  });
  res.json({ ok: true });
});

// Moderare comentarii (partea proprietarului)
app.get('/api/shares/activity', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT c.id, c.album_id AS albumId, a.name AS albumName, c.name, c.body, c.emoji, c.created_at AS createdAt
    FROM album_comments c JOIN albums a ON a.id = c.album_id
    WHERE a.share_token IS NOT NULL
    ORDER BY c.created_at DESC LIMIT 60
  `).all();
  res.json(rows.map((c) => ({ id: c.id, albumId: c.albumId, albumName: c.albumName, name: c.name, body: c.body || '', emoji: c.emoji || null, createdAt: c.createdAt })));
});

app.get('/api/albums/:id/comments', requireAuth, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const rows = await db.prepare('SELECT * FROM album_comments WHERE album_id = ? ORDER BY created_at DESC').all(a.id);
  res.json(rows.map((c) => ({ id: c.id, mediaId: c.media_id || null, name: c.name, body: c.body || '', emoji: c.emoji || null, createdAt: c.created_at })));
});

app.delete('/api/albums/:id/comments/:cid', requireAlbumOwner, checkCsrf, async (req, res) => {
  const a = await getAlbum(req.params.id);
  if (!a) return res.status(404).json({ error: 'nu există' });
  const n = (await db.prepare('DELETE FROM album_comments WHERE id = ? AND album_id = ?').run(String(req.params.cid), a.id)).changes;
  res.json({ ok: true, deleted: n });
});

// Link de partajare pentru o singură poză / un singur clip
app.post('/api/media/:id/share', requireAuth, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  let token = row.share_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    await db.prepare('UPDATE media SET share_token = ?, share_created_at = ? WHERE id = ?')
      .run(token, new Date().toISOString(), row.id);
  }
  res.json({ token, path: `/p/${token}` });
});

app.delete('/api/media/:id/share', requireAuth, checkCsrf, async (req, res) => {
  const row = await getRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'nu există' });
  await db.prepare('UPDATE media SET share_token = NULL, share_created_at = NULL WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ─── Partajare publică (fără login, doar citire) ────────────────────────────
const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/api/s/:token', shareLimiter, async (req, res) => {
  const a = await getSharedAlbum(req.params.token);
  if (!a) return res.status(404).json({ error: 'link invalid' });
  const items = await mediaInAlbum(a.id);
  let coverId = null;
  if (a.cover_id && items.some((it) => it.id === a.cover_id)) coverId = a.cover_id;
  else if (items[0]) coverId = items[0].id;
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.json({
    name: a.name, count: items.length, coverId, items,
    allowComments: a.allow_comments == null ? true : !!a.allow_comments,
    allowContrib: !!a.allow_contrib,
  });
});

// ─── Social pe albumul partajat: comentarii + reacții + contribuții ────────
const EMOJI_OK = new Set(['❤️', '😂', '😮', '😢', '👏', '🔥', '👍', '🎉']);
const commentLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe mesaje' } });
const contribLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'prea multe încărcări' } });
const ipHash = (req) => crypto.createHash('sha256').update(String(req.ip || '') + SESSION_SECRET).digest('hex').slice(0, 16);
const mapComment = (c) => ({ id: c.id, mediaId: c.media_id || null, name: c.name, body: c.body || '', emoji: c.emoji || null, createdAt: c.created_at });

function shareOriginOk(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

app.get('/api/s/:token/comments', shareLimiter, async (req, res) => {
  const a = await getSharedAlbum(req.params.token);
  if (!a) return res.status(404).json({ error: 'link invalid' });
  const rows = await db.prepare('SELECT * FROM album_comments WHERE album_id = ? ORDER BY created_at ASC').all(a.id);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.json({ allowComments: a.allow_comments == null ? true : !!a.allow_comments, comments: rows.map(mapComment) });
});

app.post('/api/s/:token/comments', commentLimiter, express.json({ limit: '8kb' }), async (req, res) => {
  const a = await getSharedAlbum(req.params.token);
  if (!a) return res.status(404).json({ error: 'link invalid' });
  if (!(a.allow_comments == null ? true : a.allow_comments)) return res.status(403).json({ error: 'comentariile sunt oprite' });
  if (!shareOriginOk(req)) return res.status(403).json({ error: 'origine invalidă' });
  const b = req.body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const body = String(b.body || '').trim().slice(0, 1000);
  const emoji = b.emoji && EMOJI_OK.has(String(b.emoji)) ? String(b.emoji) : null;
  let mediaId = b.mediaId ? String(b.mediaId) : null;
  if (!name) return res.status(400).json({ error: 'pune un nume' });
  if (!body && !emoji) return res.status(400).json({ error: 'mesaj gol' });
  if (mediaId) {
    if (!UUID_RE.test(mediaId)) return res.status(400).json({ error: 'poză invalidă' });
    const inAlbum = await db.prepare('SELECT 1 FROM album_items ai JOIN media m ON m.id = ai.media_id WHERE ai.album_id = ? AND ai.media_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0').get(a.id, mediaId);
    if (!inAlbum) return res.status(400).json({ error: 'poza nu e în album' });
  }
  const row = { id: crypto.randomUUID(), album_id: a.id, media_id: mediaId, name, body: body || null, emoji, created_at: new Date().toISOString(), ip_hash: ipHash(req) };
  await db.prepare('INSERT INTO album_comments (id, album_id, media_id, name, body, emoji, created_at, ip_hash) VALUES (:id,:album_id,:media_id,:name,:body,:emoji,:created_at,:ip_hash)').run(row);
  const shareUrl = 'https://' + req.get('host') + '/s/' + encodeURIComponent(req.params.token);
  if (COMMENT_WEBHOOK) {
    const txt = '💬 ' + name + ' pe „' + a.name + '": ' + (body || emoji || '');
    fetch(COMMENT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: txt, text: txt, album: a.name, name, body: body || null, emoji, url: shareUrl, at: row.created_at }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
  }
  if (a.owner_id) {
    push.sendToUser(a.owner_id, {
      title: name + ' a comentat pe „' + a.name + '"',
      body: body || emoji || '',
      url: shareUrl,
    }).catch(() => {});
  }
  res.json(mapComment(row));
});

const contribUpload = multer({ dest: TMP_DIR, limits: { fileSize: Math.min(MAX_UPLOAD_MB, 512) * 1024 * 1024, files: 20 } });
app.post('/api/s/:token/contrib', contribLimiter, contribUpload.array('files', 20), async (req, res, next) => {
  const a = await getSharedAlbum(req.params.token);
  if (!a) { for (const f of req.files || []) { try { fs.rmSync(f.path, { force: true }); } catch {} } return res.status(404).json({ error: 'link invalid' }); }
  if (!a.allow_contrib) { for (const f of req.files || []) { try { fs.rmSync(f.path, { force: true }); } catch {} } return res.status(403).json({ error: 'adăugarea e oprită' }); }
  if (!shareOriginOk(req)) return res.status(403).json({ error: 'origine invalidă' });
  try {
    const ins = db.prepare('INSERT IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    let added = 0; const items = [];
    for (const file of req.files || []) {
      try {
        const r = await processUpload(file);
        await ins.run(a.id, r.id, now);
        added++; items.push({ id: r.id });
      } catch (e) {
        try { fs.rmSync(file.path, { force: true }); } catch {}
        items.push({ error: e.message || 'procesare eșuată', name: file.originalname });
      }
    }
    res.json({ added, items });
  } catch (e) { next(e); }
});

async function shareMediaGuard(req, res, next) {
  const a = await getSharedAlbum(req.params.token);
  if (!a) return res.status(404).end();
  if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).end();
  const inAlbum = await db.prepare('SELECT 1 FROM album_items WHERE album_id = ? AND media_id = ?')
    .get(a.id, req.params.id);
  if (!inAlbum) return res.status(404).end();
  const row = await db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row || row.deleted_at) return res.status(404).end();
  req.mediaRow = row;
  next();
}

app.get('/s/:token/media/:id/thumb', shareLimiter, shareMediaGuard, (req, res) => sendThumb(req.mediaRow, res));
app.get('/s/:token/media/:id/full', shareLimiter, shareMediaGuard, (req, res) => sendFull(req.mediaRow, res));
app.get('/s/:token/media/:id/preview', shareLimiter, shareMediaGuard, (req, res) => {
  const p = path.join(THUMB_DIR, req.mediaRow.id + '.preview.webp');
  if (fs.existsSync(p)) { res.set('Cache-Control', 'public, max-age=86400'); res.type('image/webp'); return fs.createReadStream(p).pipe(res); }
  return sendFull(req.mediaRow, res);
});

const SHARE_HTML_PATH = path.join(__dirname, 'public', 'share.html');
const htmlEsc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

app.get('/s/:token', shareLimiter, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.type('html');

  let html;
  try { html = fs.readFileSync(SHARE_HTML_PATH, 'utf8'); }
  catch { return res.status(500).end(); }

  const a = await getSharedAlbum(req.params.token);
  if (!a) return res.status(404).send(html.replace('<!--OG-->', ''));

  const agg = await db.prepare(`
    SELECT COUNT(*) n FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
  `).get(a.id);
  const cover = await db.prepare(`
    SELECT m.id FROM album_items ai JOIN media m ON m.id = ai.media_id
    WHERE ai.album_id = ? AND m.deleted_at IS NULL AND m.locked = 0 AND m.is_live_motion = 0
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
app.get('/api/p/:token', shareLimiter, async (req, res) => {
  const row = await getSharedPhoto(req.params.token);
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

async function sharePhotoGuard(req, res, next) {
  const row = await getSharedPhoto(req.params.token);
  if (!row) return res.status(404).end();
  req.mediaRow = row;
  next();
}
app.get('/p/:token/thumb', shareLimiter, sharePhotoGuard, (req, res) => sendThumb(req.mediaRow, res));
app.get('/p/:token/full', shareLimiter, sharePhotoGuard, (req, res) => sendFull(req.mediaRow, res));

app.get('/p/:token', shareLimiter, async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  const code = (await getSharedPhoto(req.params.token)) ? 200 : 404;
  res.status(code).sendFile(path.join(__dirname, 'public', 'photo.html'));
});

// ─── Pagini + statice ───────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
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

db.ready().then(async () => {
  await joblog.sweep();
  await purgeTrash();
  setInterval(() => { purgeTrash().catch((e) => console.error('purge:', e)); }, 6 * 60 * 60 * 1000).unref();

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`cloud.acsr.ro rulează pe http://127.0.0.1:${PORT}`);
    // în fundal: generează postere pentru clipurile fără thumbnail
    Promise.resolve().then(backfillVideoThumbs).catch((e) => console.error('backfill:', e));
    Promise.resolve().then(backfillHashes).catch((e) => console.error('hashes:', e));
    Promise.resolve().then(backfillExif).catch((e) => console.error('exif:', e));
    setTimeout(() => { geo.backfillPlaces().catch((e) => console.error('geo:', e)); }, 15000);
    setTimeout(() => { backfillPreviews().catch((e) => console.error('preview:', e)); }, 25000);
    setTimeout(() => { backfillBlur().catch((e) => console.error('blur:', e)); }, 30000);
    setTimeout(() => {
      backup.checkIntegrity(ORIGINAL_DIR).catch(() => {});
      backup.backupNow().then((f) => f && console.log('backup:', path.basename(f))).catch(() => {});
    }, 20000);
    setInterval(() => { backup.backupNow().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();
    setInterval(() => { geo.backfillPlaces().catch(() => {}); }, 30 * 60 * 1000).unref();
    setInterval(() => { backfillPreviews().catch(() => {}); }, 15 * 60 * 1000).unref();
    setInterval(() => { backfillBlur().catch(() => {}); }, 15 * 60 * 1000).unref();
    setTimeout(() => { try { search.warm(); } catch {} }, 8000); // pre-încarcă modelul CLIP
  });
}).catch((e) => {
  console.error('\n  Nu m-am putut conecta la MariaDB:', e && e.message ? e.message : e);
  process.exit(1);
});
