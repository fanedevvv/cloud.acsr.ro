'use strict';
// Backup periodic al bazelor de date (mici) + .env. Pozele stau pe volumul de
// 1 TB; ele NU se copiază aici (nu încape local) — vezi checkIntegrity() care
// prinde din timp dacă volumul dispare.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = db.DATA_DIR;
const BK_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 14;
fs.mkdirSync(BK_DIR, { recursive: true });

async function backupNow() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(BK_DIR, 'media-' + ts + '.db');
  try {
    await db.backup(out);                                   // snapshot consistent (WAL-safe)
  } catch (e) {
    // fallback: copiere simplă
    try { fs.copyFileSync(path.join(DATA_DIR, 'media.db'), out); } catch { return null; }
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
function checkIntegrity(originalDir) {
  const rows = db.prepare("SELECT id, stored_name FROM media WHERE deleted_at IS NULL").all();
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
