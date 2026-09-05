'use strict';
// Backup periodic al bazei de date (mysqldump, mică) + .env. Pozele stau pe
// volumul de 1 TB; ele NU se copiază aici (nu încape local) — vezi
// checkIntegrity() care prinde din timp dacă volumul dispare.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');

const DATA_DIR = db.DATA_DIR;
const BK_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 14;
fs.mkdirSync(BK_DIR, { recursive: true });

function mysqldump(out) {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', process.env.DB_HOST || '127.0.0.1',
      '-P', String(process.env.DB_PORT || 3306),
      '-u', process.env.DB_USER || 'cloud_gallery',
      '--single-transaction', '--routines', '--events',
      process.env.DB_NAME || 'cloud_gallery',
    ];
    const child = execFile('mysqldump', args, {
      maxBuffer: 1024 * 1024 * 1024,
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' },
    }, (err, stdout) => {
      if (err) return reject(err);
      try { fs.writeFileSync(out, stdout); resolve(); } catch (e) { reject(e); }
    });
  });
}

async function backupNow() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(BK_DIR, 'media-' + ts + '.sql');
  try {
    await mysqldump(out);
  } catch (e) {
    console.error('backup: mysqldump a eșuat:', e && e.message ? e.message : e);
    return null;
  }
  try { fs.copyFileSync(path.join(__dirname, '..', '.env'), path.join(BK_DIR, 'env-' + ts + '.bak')); } catch {}
  prune();
  return out;
}

function prune() {
  for (const pref of ['media-', 'env-']) {
    const files = fs.readdirSync(BK_DIR).filter((f) => f.startsWith(pref)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      try { fs.rmSync(path.join(BK_DIR, f), { force: true }); } catch {}
    }
  }
}

function lastBackup() {
  const files = fs.readdirSync(BK_DIR).filter((f) => f.startsWith('media-')).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  const st = fs.statSync(path.join(BK_DIR, f));
  return { file: f, at: st.mtime.toISOString(), size: st.size };
}

// Verifică dacă fișierele media chiar există (prinde dispariția volumului NFS).
async function checkIntegrity(originalDir) {
  const rows = await db.prepare("SELECT id, stored_name FROM media WHERE deleted_at IS NULL").all();
  let missing = 0;
  for (const r of rows) {
    if (!fs.existsSync(path.join(originalDir, r.stored_name))) missing++;
  }
  const pct = rows.length ? missing / rows.length : 0;
  if (rows.length > 5 && pct > 0.1) {
    console.error(`\n  ⚠️  ATENȚIE: ${missing}/${rows.length} fișiere media LIPSESC de pe disc.`);
    console.error('  Volumul de stocare (NFS?) pare inaccesibil sau golit.\n');
  }
  return { total: rows.length, missing };
}

module.exports = { backupNow, lastBackup, checkIntegrity, BK_DIR };
