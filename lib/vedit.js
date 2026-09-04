'use strict';
// Editare video (tăiere / mut / rotire) + cadru -> poză, prin ffmpeg.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const media = require('./media');

let FFMPEG = null;
try { FFMPEG = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim() || null; } catch {}

const jobs = new Map();
const newJob = () => {
  const id = crypto.randomBytes(6).toString('hex');
  const j = { id, phase: 'starting', startedAt: new Date().toISOString() };
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
  } catch (e) {
    job.phase = 'error';
    job.error = (e && e.message) || String(e);
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

module.exports = { newJob, getJob, runVideoEdit, frameBuffer, saveFrame, available: !!FFMPEG };
