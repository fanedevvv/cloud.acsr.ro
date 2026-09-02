'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'media.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,            -- 'image' | 'video'
    mime          TEXT NOT NULL,
    stored_name   TEXT NOT NULL,            -- nume fișier pe disc (id + extensie)
    original_name TEXT,
    width         INTEGER,
    height        INTEGER,
    size          INTEGER,
    duration      REAL,
    has_thumb     INTEGER NOT NULL DEFAULT 0,
    taken_at      TEXT,                     -- ISO, din EXIF dacă există
    created_at    TEXT NOT NULL             -- ISO, momentul încărcării
  );
  CREATE INDEX IF NOT EXISTS idx_media_taken   ON media (taken_at);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media (created_at);

  CREATE TABLE IF NOT EXISTS albums (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    share_token      TEXT UNIQUE,             -- NULL = nepartajat
    share_created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS album_items (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (album_id, media_id)
  );
  CREATE INDEX IF NOT EXISTS idx_album_items_media ON album_items (media_id);
`);

// ─── Migrații aditive (rulare sigură pe DB existent) ────────────────────────
const mediaCols = new Set(db.prepare('PRAGMA table_info(media)').all().map((c) => c.name));
function addCol(name, ddl) {
  if (!mediaCols.has(name)) db.exec(`ALTER TABLE media ADD COLUMN ${ddl}`);
}
addCol('favorite', 'favorite INTEGER NOT NULL DEFAULT 0');
addCol('archived', 'archived INTEGER NOT NULL DEFAULT 0');
addCol('deleted_at', 'deleted_at TEXT');
addCol('caption', 'caption TEXT');
addCol('share_token', 'share_token TEXT');
addCol('share_created_at', 'share_created_at TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_media_deleted  ON media (deleted_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_media_favorite ON media (favorite)');
db.exec('CREATE INDEX IF NOT EXISTS idx_media_archived ON media (archived)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_media_share ON media (share_token) WHERE share_token IS NOT NULL');

const albumCols = new Set(db.prepare('PRAGMA table_info(albums)').all().map((c) => c.name));
if (!albumCols.has('cover_id')) db.exec('ALTER TABLE albums ADD COLUMN cover_id TEXT');

module.exports = db;
module.exports.DATA_DIR = DATA_DIR;
