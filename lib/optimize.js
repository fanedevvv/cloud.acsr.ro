'use strict';
// Recompresie în fundal a mediilor existente pentru a ocupa mai puțin spațiu.
const fs = require('fs');
const joblog = require('./joblog');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const db = require('./db');
const {
  ORIGINAL_DIR, THUMB_DIR, optimizeImage, sha256File, remakeThumb, ffmpegAvailable,
} = require('./media');

let job = null;

function start(opts) {
  job = {
    id: crypto.randomBytes(8).toString('hex'),
    phase: 'starting', total: 0, done: 0, changed: 0, skipped: 0,
    savedBytes: 0, withVideo: !!opts.withVideo,
    errors: [], startedAt: Date.now(), finishedAt: null, _log: joblog.start('Optimizare spațiu'),
  };
  run(job).catch((e) => {
    job.phase = 'error';
    job.errors.push('fatal: ' + (e && e.message ? e.message : e));
    job.finishedAt = Date.now();
    joblog.finish(job._log, 'error', job.errors[job.errors.length-1]);
  });
  return job;
}
const current = () => job;
const get = (id) => (job && job.id === id ? job : null);

function h265(src, dest) {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-y', '-i', src,
      '-c:v', 'libx265', '-crf', '26', '-preset', 'medium', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', dest,
    ], { timeout: 30 * 60 * 1000 }, (err) => resolve(!err && fs.existsSync(dest) && fs.statSync(dest).size > 0));
  });
}

async function run(j) {
  j.phase = 'scanning';
  const rows = db.prepare(
    "SELECT id, type, stored_name, size FROM media WHERE deleted_at IS NULL ORDER BY size DESC"
  ).all();
  j.total = rows.length;
  j.phase = 'running';

  for (const r of rows) {
    try {
      const src = path.join(ORIGINAL_DIR, r.stored_name);
      if (!fs.existsSync(src)) { j.skipped++; j.done++; continue; }

      if (r.type === 'image') {
        const opt = await optimizeImage(src);
        if (opt && opt.savedBytes > 0) {
          const newStored = r.id + opt.ext;
          const newPath = path.join(ORIGINAL_DIR, newStored);
          fs.renameSync(opt.outPath, newPath);
          if (newStored !== r.stored_name) fs.rmSync(src, { force: true });
          const hash = await sha256File(newPath).catch(() => null);
          const size = fs.statSync(newPath).size;
          await remakeThumb(r.id, newPath, 'image').catch(() => {});
          db.prepare('UPDATE media SET stored_name=?, mime=?, size=?, sha256=? WHERE id=?')
            .run(newStored, opt.mime, size, hash, r.id);
          j.savedBytes += (r.size || 0) - size;
          j.changed++;
        } else {
          j.skipped++;
          if (opt && opt.outPath) fs.rmSync(opt.outPath, { force: true });
        }
      } else if (r.type === 'video' && j.withVideo && ffmpegAvailable) {
        const dest = path.join(ORIGINAL_DIR, r.id + '.opt.mp4');
        const ok = await h265(src, dest);
        if (ok && fs.statSync(dest).size < (r.size || Infinity) * 0.9) {
          const finalStored = r.id + '.mp4';
          const finalPath = path.join(ORIGINAL_DIR, finalStored);
          fs.rmSync(src, { force: true });
          fs.renameSync(dest, finalPath);
          const size = fs.statSync(finalPath).size;
          const hash = await sha256File(finalPath).catch(() => null);
          await remakeThumb(r.id, finalPath, 'video').catch(() => {});
          db.prepare('UPDATE media SET stored_name=?, mime=?, size=?, sha256=? WHERE id=?')
            .run(finalStored, 'video/mp4', size, hash, r.id);
          j.savedBytes += (r.size || 0) - size;
          j.changed++;
        } else {
          fs.rmSync(dest, { force: true });
          j.skipped++;
        }
      } else {
        j.skipped++;
      }
    } catch (e) {
      j.skipped++;
      if (j.errors.length < 25) j.errors.push(r.id.slice(0, 8) + ': ' + (e && e.message ? e.message : e));
    }
    j.done++;
  }

  j.phase = 'done';
  j.finishedAt = Date.now();
  joblog.finish(j._log, 'done', j.changed + ' fișiere, -' + Math.round(j.savedBytes/1e6) + ' MB');
}

module.exports = { start, current, get };
