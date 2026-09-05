'use strict';
// Migrare unică: copiază datele din data/media.db (SQLite) în MariaDB.
// Rulare:  node tools/migrate-to-mysql.js
require('../lib/env');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('../lib/db');

const SRC = path.join(__dirname, '..', 'data', 'media.db');

const TABLES = [
  { name: 'users', cols: ['id', 'username', 'pass_hash', 'display_name', 'has_avatar', 'is_admin', 'created_at', 'google_id', 'email'] },
  { name: 'media', cols: null },   // toate coloanele, potrivite 1:1
  { name: 'albums', cols: ['id', 'name', 'created_at', 'share_token', 'share_created_at', 'owner_id', 'owner_name', 'cover_id', 'allow_comments', 'allow_contrib'] },
  { name: 'album_items', cols: ['album_id', 'media_id', 'added_at'] },
  { name: 'album_comments', cols: ['id', 'album_id', 'media_id', 'name', 'body', 'emoji', 'created_at', 'ip_hash'] },
  { name: 'media_embed', cols: ['media_id', 'vec', 'done_at'] },
  { name: 'media_tags', cols: ['media_id', 'tag', 'score'] },
  { name: 'faces', cols: ['id', 'media_id', 'cluster_id', 'box', 'score', 'descriptor', 'created_at'] },
  { name: 'face_clusters', cols: ['id', 'name', 'cover_face_id', 'n', 'created_at'] },
  { name: 'settings', cols: ['key', 'value'] },
  { name: 'geocache', cols: ['cell', 'place', 'city', 'country', 'at'] },
  { name: 'job_log', cols: ['kind', 'phase', 'detail', 'started_at', 'finished_at'] },
];

async function main() {
  await db.ready();
  const sqlite = new Database(SRC, { readonly: true });

  for (const t of TABLES) {
    let cols = t.cols;
    if (!cols) {
      cols = sqlite.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name);
    }
    let rows;
    try { rows = sqlite.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${t.name}`).all(); }
    catch (e) { console.log(`— ${t.name}: sursă lipsă (${e.message}), sar peste`); continue; }
    if (!rows.length) { console.log(`— ${t.name}: 0 rânduri`); continue; }

    const placeholders = '(' + cols.map(() => '?').join(',') + ')';
    const colList = cols.map((c) => '`' + c + '`').join(',');
    const sql = `INSERT INTO ${t.name} (${colList}) VALUES ${placeholders}`;
    let n = 0;
    for (const r of rows) {
      const vals = cols.map((c) => {
        let v = r[c];
        if (v === undefined) v = null;
        return v;
      });
      try {
        await db.pool.execute(sql, vals);
        n++;
      } catch (e) {
        console.error(`  ! ${t.name} rând eșuat:`, e.message);
      }
    }
    console.log(`✓ ${t.name}: ${n}/${rows.length} rânduri migrate`);
  }

  sqlite.close();
  console.log('\nMigrare terminată.');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
