'use strict';
// Editare video (tăiere / mut / rotire) + cadru -> poză, prin ffmpeg.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const media = require('./media');
const joblog = require('./joblog');

let FFMPEG = null;
try { FFMPEG = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim() || null; } catch {}

const jobs = new Map();
const newJob = (kind) => {
  const id = crypto.randomBytes(6).toString('hex');
  const j = { id, phase: 'starting', startedAt: new Date().toISOString(), _log: joblog.start(kind || 'Video') };
  jobs.set(id, j);
  return j;
};
const getJob = (id) => jobs.get(String(id)) || null;

function runFfmpeg(args, timeout = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg indisponibil'));
    execFile(FFMPEG, args, { timeout, maxBuffer: 1 << 24 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function runVideoEdit(job, srcPath, originalName, opts) {
  try {
    const out = path.join(media.TMP_DIR, job.id + '.mp4');
    const start = Math.max(0, Number(opts.start) || 0);
    const end = Number(opts.end);
    const dur = end > start ? end - start : null;
    const rot = Number(opts.rotate) || 0;
    const mute = !!opts.mute;

    const args = ['-y'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', srcPath);
    if (dur) args.push('-t', String(dur));
    const vf = [];
    if (rot === 90) vf.push('transpose=1');
    else if (rot === -90 || rot === 270) vf.push('transpose=2');
    else if (rot === 180) vf.push('transpose=1,transpose=1');
    if (vf.length) args.push('-vf', vf.join(','));
    if (mute) args.push('-an'); else args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);

    job.phase = 'processing';
    await runFfmpeg(args);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('rezultat gol');

    const nm = String(originalName || 'clip').replace(/\.[^.]+$/, '') + '-editat.mp4';
    const r = await media.ingest({ srcPath: out, originalName: nm, mime: 'video/mp4' });
    job.phase = 'done';
    job.mediaId = r.id;
    job.finishedAt = new Date().toISOString();
    joblog.finish(await job._log, 'done', 'clip editat');
  } catch (e) {
    job.phase = 'error';
    job.error = (e && e.message) || String(e);
    joblog.finish(await job._log, 'error', job.error);
  }
}

async function frameBuffer(srcPath, t) {
  const tmp = path.join(media.TMP_DIR, 'frm-' + crypto.randomBytes(5).toString('hex') + '.jpg');
  await runFfmpeg(['-y', '-ss', String(Math.max(0, Number(t) || 0)), '-i', srcPath, '-frames:v', '1', '-q:v', '3', tmp], 60000);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}

async function saveFrame(srcPath, originalName, t) {
  const tmp = path.join(media.TMP_DIR, 'frm-' + crypto.randomBytes(5).toString('hex') + '.jpg');
  await runFfmpeg(['-y', '-ss', String(Math.max(0, Number(t) || 0)), '-i', srcPath, '-frames:v', '1', '-q:v', '2', tmp], 60000);
  const nm = String(originalName || 'clip').replace(/\.[^.]+$/, '') + '-cadru.jpg';
  return media.ingest({ srcPath: tmp, originalName: nm, mime: 'image/jpeg' });
}

// ─── Slideshow -> mp4 ────────────────────────────────────────────────────
async function runSlideshow(job, images, opts) {
  try {
    const secs = Math.max(1.5, Math.min(8, Number(opts.seconds) || 3));
    const fade = opts.kenburns !== false;   // acum: tranziție fade vs tăiere directă
    const W = 1280, H = 720, FPS = 24;       // 720p — CPU-ul mașinii e slab
    const out = path.join(media.TMP_DIR, 'slideshow-' + job.id + '.mp4');
    const args = ['-y'];
    for (const im of images) args.push('-loop', '1', '-t', String(secs), '-i', im);
    const parts = [];
    for (let i = 0; i < images.length; i++) {
      let f = `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
      if (fade) f += `,fade=t=in:st=0:d=0.35,fade=t=out:st=${(secs - 0.35).toFixed(2)}:d=0.35`;
      parts.push(f + `[v${i}]`);
    }
    parts.push(images.map((_, i) => `[v${i}]`).join('') + `concat=n=${images.length}:v=1:a=0[v]`);
    args.push('-filter_complex', parts.join(';'), '-map', '[v]',
      '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
    job.phase = 'processing';
    await runFfmpeg(args, 20 * 60 * 1000);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('rezultat gol');
    job.phase = 'done'; job.file = out; job.finishedAt = new Date().toISOString();
    joblog.finish(await job._log, 'done', images.length + ' poze');
    setTimeout(() => { try { fs.rmSync(out, { force: true }); } catch {} }, 60 * 60 * 1000);
  } catch (e) {
    job.phase = 'error';
    job.error = (e && e.message) || String(e);
    joblog.finish(await job._log, 'error', job.error);
  }
}

module.exports = { newJob, getJob, runVideoEdit, runSlideshow, frameBuffer, saveFrame, available: !!FFMPEG };
