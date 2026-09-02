'use strict';
// Import dintr-o arhivă Google Photos Takeout (.zip).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');

const db = require('./db');
const { ingest, classifyName, TMP_DIR } = require('./media');

const jobs = new Map();

function newJob() {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id, phase: 'starting',
    total: 0, done: 0, added: 0, duplicates: 0, skipped: 0, albums: 0,
    errors: [], startedAt: Date.now(), finishedAt: null,
  };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref();
  return job;
}

function rel(p) {
  p = String(p).replace(/\\/g, '/');
  const m = p.match(/(?:^|\/)Google (?:Photos|Fotos|Fotky|Zdjęcia|Bilder|Foto)\/(.+)$/i);
  if (m) return m[1];
  return p.replace(/^Takeout\//i, '');
}

const isLooseFolder = (d) =>
  d === '' || d === '.' ||
  /^(Photos from|Fotos (from|aus|de|van)|Foto di|Zdjęcia z) \d{4}$/i.test(d) ||
  /^(Untitled|Fără titlu|Sans titre|Ohne Titel)/i.test(d);

async function runImport(zipPath, job) {
  const workDir = fs.mkdtempSync(path.join(TMP_DIR, 'takeout-'));
  try {
    job.phase = 'reading';
    const dir = await unzipper.Open.file(zipPath);
    const files = dir.files.filter((f) => f.type === 'File');

    const jsonEntries = new Map();
    const mediaEntries = [];
    for (const f of files) {
      const rp = rel(f.path);
      if (rp.toLowerCase().endsWith('.json')) { jsonEntries.set(rp, f); continue; }
      const base = path.posix.basename(rp);
      if (classifyName(base, '')) {
        mediaEntries.push({ entry: f, relPath: rp, dir: path.posix.dirname(rp), base });
      }
    }
    job.total = mediaEntries.length;

    const meta = new Map();
    for (const [rp, e] of jsonEntries) {
      try { meta.set(rp, JSON.parse((await e.buffer()).toString('utf8'))); } catch (_) { /* ignora */ }
    }

    function sidecar(rp) {
      const noExt = rp.replace(/(\.[^./]+)$/, '');
      const cands = [rp + '.json', rp + '.supplemental-metadata.json', noExt + '.json'];
      const mm = rp.match(/^(.*?)(\(\d+\))(\.[^./]+)$/);
      if (mm) cands.push(mm[1] + mm[3] + mm[2] + '.json');
      for (const c of cands) if (meta.has(c)) return meta.get(c);
      const d = path.posix.dirname(rp);
      const b = path.posix.basename(rp);
      for (const [k, v] of meta) {
        if (path.posix.dirname(k) === d && v && (v.title === b || v.title === b.replace(/\(\d+\)/, ''))) return v;
      }
      return null;
    }

    job.phase = 'importing';
    const albumsByDir = new Map();

    for (const item of mediaEntries) {
      const tmp = path.join(workDir, crypto.randomBytes(6).toString('hex'));
      try {
        await new Promise((res, rej) => {
          item.entry.stream().pipe(fs.createWriteStream(tmp)).on('finish', res).on('error', rej);
        });
        const sc = sidecar(item.relPath) || {};
        let takenAtISO = null;
        const ts = (sc.photoTakenTime && sc.photoTakenTime.timestamp) ||
                   (sc.creationTime && sc.creationTime.timestamp);
        if (ts) { const d = new Date(Number(ts) * 1000); if (!Number.isNaN(d.getTime())) takenAtISO = d.toISOString(); }

        const r = await ingest({
          srcPath: tmp,
          originalName: sc.title || item.base,
          mime: '',
          takenAtISO,
          favorite: sc.favorited === true,
          archived: sc.archived === true,
          caption: sc.description || '',
        });
        if (r.duplicate) job.duplicates++; else job.added++;

        const top = item.dir.split('/')[0] || '';
        if (!isLooseFolder(top) && !isLooseFolder(item.dir)) {
          const key = item.dir;
          if (!albumsByDir.has(key)) {
            let name = key.split('/').pop();
            const am = meta.get(key + '/metadata.json') || meta.get(key + '/album-metadata.json');
            if (am && am.title) name = am.title;
            albumsByDir.set(key, { name, mediaIds: [] });
          }
          albumsByDir.get(key).mediaIds.push(r.id);
        }
      } catch (e) {
        job.skipped++;
        if (job.errors.length < 25) job.errors.push(item.base + ': ' + (e && e.message ? e.message : e));
        fs.rmSync(tmp, { force: true });
      }
      job.done++;
    }

    job.phase = 'albums';
    const findAlbum = db.prepare('SELECT id FROM albums WHERE name = ?');
    const insAlbum = db.prepare('INSERT INTO albums (id, name, created_at) VALUES (?, ?, ?)');
    const insItem = db.prepare('INSERT OR IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)');
    for (const entry of albumsByDir.values()) {
      const nm = String(entry.name || '').trim().slice(0, 120);
      if (!nm || !entry.mediaIds.length) continue;
      let aid;
      const found = findAlbum.get(nm);
      if (found) aid = found.id;
      else { aid = crypto.randomUUID(); insAlbum.run(aid, nm, new Date().toISOString()); }
      const now = new Date().toISOString();
      db.transaction(() => { for (const mid of entry.mediaIds) insItem.run(aid, mid, now); })();
      job.albums++;
    }

    job.phase = 'done';
  } catch (e) {
    job.phase = 'error';
    job.errors.push('fatal: ' + (e && e.message ? e.message : e));
  } finally {
    job.finishedAt = Date.now();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* */ }
    try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* */ }
  }
}

module.exports = { jobs, newJob, runImport };
