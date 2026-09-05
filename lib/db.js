'use strict';
// Strat de bază de date: MariaDB (mysql2/promise), cu un shim care imită
// API-ul sincron al better-sqlite3 (db.prepare(sql).get/all/run) dar async.
// Asta a redus la minimum diff-ul la conversia din SQLite -> MySQL:
// fiecare apel devine `await db.prepare(sql).get(...)` în loc de sincron.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'cloud_gallery',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cloud_gallery',
  namedPlaceholders: true,
  waitForConnections: true,
  connectionLimit: 12,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
});
pool.on('connection', (conn) => { conn.query('SET SESSION group_concat_max_len = 1000000'); });

function pickParams(args, named) {
  if (named) return (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) ? args[0] : {};
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function makeStmt(sql) {
  const named = /:\w+/.test(sql) && !/\?/.test(sql);
  return {
    async get(...args) {
      const [rows] = await pool.execute(sql, pickParams(args, named));
      return rows[0];
    },
    async all(...args) {
      const [rows] = await pool.execute(sql, pickParams(args, named));
      return rows;
    },
    async run(...args) {
      const [res] = await pool.execute(sql, pickParams(args, named));
      return { lastInsertRowid: res.insertId, changes: res.affectedRows };
    },
  };
}

const db = {
  prepare: makeStmt,
  async exec(sql) {
    // sql poate conține mai multe instrucțiuni separate prin ';' (schema init)
    const conn = await pool.getConnection();
    try {
      await conn.query(sql);
    } finally {
      conn.release();
    }
  },
  // Nu oferim tranzacții SQL reale (nu sunt necesare pentru operațiile din
  // acest app — inserturi mici, grupate); doar rulăm funcția, care poate fi
  // async și poate face mai multe apeluri db.prepare(...).run(...) în serie.
  transaction(fn) {
    return async (...args) => fn(...args);
  },
  pool,
  DATA_DIR,
};

async function columnExists(table, col) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, col]
  );
  return rows[0].n > 0;
}
async function indexExists(table, idx) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, idx]
  );
  return rows[0].n > 0;
}
async function addCol(table, name, ddl) {
  if (!(await columnExists(table, name))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
async function addIndex(table, name, ddl) {
  if (!(await indexExists(table, name))) {
    try { await db.exec(`ALTER TABLE ${table} ADD ${ddl}`); } catch (e) { if (e.code !== 'ER_DUP_KEYNAME') throw e; }
  }
}

let readyPromise = null;
function ready() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id            VARCHAR(36) PRIMARY KEY,
      type          VARCHAR(10) NOT NULL,
      mime          VARCHAR(120) NOT NULL,
      stored_name   VARCHAR(255) NOT NULL,
      original_name TEXT,
      width         INT,
      height        INT,
      size          BIGINT,
      duration      DOUBLE,
      has_thumb     TINYINT(1) NOT NULL DEFAULT 0,
      taken_at      VARCHAR(40),
      created_at    VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('media', 'idx_media_taken', 'INDEX idx_media_taken (taken_at)');
  await addIndex('media', 'idx_media_created', 'INDEX idx_media_created (created_at)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id               VARCHAR(36) PRIMARY KEY,
      name             VARCHAR(255) NOT NULL,
      created_at       VARCHAR(40) NOT NULL,
      share_token      VARCHAR(64) UNIQUE,
      share_created_at VARCHAR(40)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS album_items (
      album_id VARCHAR(36) NOT NULL,
      media_id VARCHAR(36) NOT NULL,
      added_at VARCHAR(40) NOT NULL,
      PRIMARY KEY (album_id, media_id),
      CONSTRAINT fk_ai_album FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('album_items', 'idx_album_items_media', 'INDEX idx_album_items_media (media_id)');

  // ─── Migrații aditive pe media ─────────────────────────────────────────
  await addCol('media', 'favorite', 'favorite TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'archived', 'archived TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'deleted_at', 'deleted_at VARCHAR(40)');
  await addCol('media', 'caption', 'caption TEXT');
  await addCol('media', 'share_token', 'share_token VARCHAR(64)');
  await addCol('media', 'share_created_at', 'share_created_at VARCHAR(40)');
  await addCol('media', 'sha256', 'sha256 VARCHAR(64)');
  await addCol('media', 'lat', 'lat DOUBLE');
  await addCol('media', 'lon', 'lon DOUBLE');
  await addCol('media', 'place', 'place VARCHAR(255)');
  await addCol('media', 'camera', 'camera VARCHAR(150)');
  await addCol('media', 'lens', 'lens VARCHAR(150)');
  await addCol('media', 'iso', 'iso INT');
  await addCol('media', 'f_number', 'f_number DOUBLE');
  await addCol('media', 'exposure', 'exposure VARCHAR(30)');
  await addCol('media', 'focal', 'focal DOUBLE');
  await addCol('media', 'exif_done', 'exif_done TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'kind_auto', 'kind_auto VARCHAR(30)');
  await addCol('media', 'locked', 'locked TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'ocr_text', 'ocr_text TEXT');
  await addCol('media', 'ocr_done', 'ocr_done TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'faces_done', 'faces_done TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'place_done', 'place_done TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'live_video_id', 'live_video_id VARCHAR(36)');
  await addCol('media', 'is_live_motion', 'is_live_motion TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('media', 'city', 'city VARCHAR(150)');
  await addCol('media', 'country', 'country VARCHAR(150)');
  await addCol('media', 'uploader_id', 'uploader_id VARCHAR(36)');
  await addIndex('media', 'idx_media_uploader', 'INDEX idx_media_uploader (uploader_id)');

  await addIndex('media', 'idx_media_deleted', 'INDEX idx_media_deleted (deleted_at)');
  await addIndex('media', 'idx_media_geo', 'INDEX idx_media_geo (lat, lon)');
  await addIndex('media', 'idx_media_locked', 'INDEX idx_media_locked (locked)');
  await addIndex('media', 'idx_media_favorite', 'INDEX idx_media_favorite (favorite)');
  await addIndex('media', 'idx_media_archived', 'INDEX idx_media_archived (archived)');
  await addIndex('media', 'idx_media_share', 'UNIQUE INDEX idx_media_share (share_token)');
  await addIndex('media', 'idx_media_sha', 'INDEX idx_media_sha (sha256)');
  await addIndex('media', 'idx_media_ocr', 'INDEX idx_media_ocr (ocr_done)');

  await db.exec("CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(100) PRIMARY KEY, value TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
  await db.exec('CREATE TABLE IF NOT EXISTS geocache (cell VARCHAR(60) PRIMARY KEY, place VARCHAR(255), city VARCHAR(150), country VARCHAR(150), at VARCHAR(40)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_embed (
      media_id VARCHAR(36) PRIMARY KEY,
      vec BLOB NOT NULL,
      done_at VARCHAR(40),
      CONSTRAINT fk_embed_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_tags (
      media_id VARCHAR(36) NOT NULL,
      tag VARCHAR(100) NOT NULL,
      score DOUBLE,
      PRIMARY KEY (media_id, tag),
      CONSTRAINT fk_tags_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('media_tags', 'idx_media_tags_tag', 'INDEX idx_media_tags_tag (tag)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS faces (
      id VARCHAR(36) PRIMARY KEY,
      media_id VARCHAR(36) NOT NULL,
      cluster_id VARCHAR(36),
      box TEXT, score DOUBLE, descriptor BLOB, created_at VARCHAR(40),
      CONSTRAINT fk_faces_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('faces', 'idx_faces_media', 'INDEX idx_faces_media (media_id)');
  await addIndex('faces', 'idx_faces_cluster', 'INDEX idx_faces_cluster (cluster_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS face_clusters (
      id VARCHAR(36) PRIMARY KEY, name VARCHAR(150), cover_face_id VARCHAR(36),
      n INT NOT NULL DEFAULT 0, created_at VARCHAR(40)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           VARCHAR(36) PRIMARY KEY,
      username     VARCHAR(60) NOT NULL UNIQUE,
      pass_hash    VARCHAR(255) NOT NULL DEFAULT '',
      display_name VARCHAR(150) NOT NULL,
      has_avatar   TINYINT(1) NOT NULL DEFAULT 0,
      is_admin     TINYINT(1) NOT NULL DEFAULT 0,
      created_at   VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addCol('users', 'google_id', 'google_id VARCHAR(80)');
  await addCol('users', 'email', 'email VARCHAR(255)');
  await addIndex('users', 'idx_users_google', 'UNIQUE INDEX idx_users_google (google_id)');
  await addCol('users', 'totp_secret', 'totp_secret VARCHAR(64)');
  await addCol('users', 'totp_enabled', 'totp_enabled TINYINT(1) NOT NULL DEFAULT 0');
  await addCol('users', 'totp_backup_codes', 'totp_backup_codes TEXT');

  await addCol('face_clusters', 'linked_user_id', 'linked_user_id VARCHAR(36)');

  await addCol('media', 'blur_score', 'blur_score DOUBLE');
  await addCol('media', 'blur_done', 'blur_done TINYINT(1) NOT NULL DEFAULT 0');
  await addIndex('media', 'idx_media_blur', 'INDEX idx_media_blur (blur_done)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         VARCHAR(36) PRIMARY KEY,
      user_id    VARCHAR(36),
      endpoint   VARCHAR(700) NOT NULL,
      p256dh     VARCHAR(200) NOT NULL,
      auth       VARCHAR(100) NOT NULL,
      created_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('push_subscriptions', 'idx_push_user', 'INDEX idx_push_user (user_id)');
  await addIndex('push_subscriptions', 'idx_push_endpoint', 'UNIQUE INDEX idx_push_endpoint (endpoint(255))');

  await addCol('albums', 'owner_id', 'owner_id VARCHAR(36)');
  await addCol('albums', 'owner_name', 'owner_name VARCHAR(150)');
  await addCol('albums', 'cover_id', 'cover_id VARCHAR(36)');
  await addCol('albums', 'allow_comments', 'allow_comments TINYINT(1) NOT NULL DEFAULT 1');
  await addCol('albums', 'allow_contrib', 'allow_contrib TINYINT(1) NOT NULL DEFAULT 0');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS album_comments (
      id         VARCHAR(36) PRIMARY KEY,
      album_id   VARCHAR(36) NOT NULL,
      media_id   VARCHAR(36),
      name       VARCHAR(150) NOT NULL,
      body       TEXT,
      emoji      VARCHAR(16),
      created_at VARCHAR(40) NOT NULL,
      ip_hash    VARCHAR(80),
      CONSTRAINT fk_comments_album FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await addIndex('album_comments', 'idx_comments_album', 'INDEX idx_comments_album (album_id, created_at)');
  await addIndex('album_comments', 'idx_comments_media', 'INDEX idx_comments_media (media_id)');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS job_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      kind VARCHAR(60) NOT NULL,
      phase VARCHAR(20) NOT NULL,
      detail VARCHAR(500),
      started_at VARCHAR(40) NOT NULL,
      finished_at VARCHAR(40)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

module.exports = db;
module.exports.ready = ready;
module.exports.DATA_DIR = DATA_DIR;
