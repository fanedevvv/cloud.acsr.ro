'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const sharp = require('sharp');

let exifReader = null;
try { exifReader = require('exif-reader'); } catch { /* opțional */ }

const db = require('./db');
const DATA_DIR = db.DATA_DIR;
const ORIGINAL_DIR = path.join(DATA_DIR, 'originals');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
for (const d of [ORIGINAL_DIR, THUMB_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', '3gp', 'ogv']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'image/tiff', 'image/bmp']);
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'video/3gpp', 'video/ogg']);

// Detectează ffmpeg/ffprobe o singură dată la pornire (opțional — pentru poster de video).
let FFMPEG = null;
let FFPROBE = null;
try {
  FFMPEG = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim() || null;
  FFPROBE = execFileSync('sh', ['-c', 'command -v ffprobe'], { encoding: 'utf8' }).trim() || null;
} catch { /* nu e instalat */ }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPT_UPLOADS = (process.env.OPTIMIZE_UPLOADS || 'webp').toLowerCase();

function extOf(name) {
  return path.extname(name || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function classify(file) {
  const ext = extOf(file.originalname);
  const mime = String(file.mimetype || '').toLowerCase();
  if (IMAGE_MIME.has(mime) || IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_MIME.has(mime) || VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function moveInto(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
}

function parseExifDate(exifBuf) {
  if (!exifBuf || !exifReader) return null;
  try {
    const ex = exifReader(exifBuf);
    const d =
      ex?.Photo?.DateTimeOriginal ||
      ex?.exif?.DateTimeOriginal ||
      ex?.Image?.DateTime ||
      ex?.image?.DateTime;
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(String(d).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function ffprobeMeta(file) {
  if (!FFPROBE) return {};
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json', file],
      { encoding: 'utf8', timeout: 30000 }
    );
    const j = JSON.parse(out);
    return {
      width: j.streams?.[0]?.width ?? null,
      height: j.streams?.[0]?.height ?? null,
      duration: j.format?.duration ? Number(j.format.duration) : null,
    };
  } catch {
    return {};
  }
}

function ffmpegPoster(src, dest) {
  return new Promise((resolve) => {
    if (!FFMPEG) return resolve(false);
    execFile(
      FFMPEG,
      ['-y', '-ss', '1', '-i', src, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", dest],
      { timeout: 60000 },
      (err) => {
        if (err) return resolve(false);
        try {
          resolve(fs.existsSync(dest) && fs.statSync(dest).size > 0);
        } catch {
          resolve(false);
        }
      }
    );
  });
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function classifyName(name, mime) {
  const ext = extOf(name);
  const m = String(mime || '').toLowerCase();
  if (IMAGE_MIME.has(m) || IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_MIME.has(m) || VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/**
 * Recompresie „vizual identică": WebP q80. Întoarce null dacă nu merită
 * (format deja eficient, animat, nedecodabil, sub 10% economie).
 */
async function optimizeImage(srcPath) {
  let meta;
  try { meta = await sharp(srcPath, { failOn: 'none', limitInputPixels: 2_000_000_000 }).metadata(); }
  catch { return null; }
  if (!meta || !meta.format) return null;
  if ((meta.pages || 1) > 1) return null;
  if (meta.format === 'webp' || meta.format === 'avif') return null;
  const orig = fs.statSync(srcPath).size;
  const outPath = srcPath + '.opt.webp';
  try {
    await sharp(srcPath, { failOn: 'none', limitInputPixels: 2_000_000_000 })
      .rotate().withMetadata().webp({ quality: 80, effort: 4 }).toFile(outPath);
  } catch { fs.rmSync(outPath, { force: true }); return null; }
  const newSize = fs.statSync(outPath).size;
  if (newSize >= orig * 0.90) { fs.rmSync(outPath, { force: true }); return null; }
  return { outPath, ext: '.webp', mime: 'image/webp', savedBytes: orig - newSize };
}

async function remakeThumb(id, srcPath, kind) {
  const thumbPath = path.join(THUMB_DIR, id + '.webp');
  if (kind === 'image') {
    await sharp(srcPath, { failOn: 'none', limitInputPixels: 2_000_000_000 })
      .rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 }).toFile(thumbPath);
    return true;
  }
  return ffmpegPoster(srcPath, thumbPath);
}

/**
 * Nucleu comun de ingestie: dedup după sha256, mută fișierul în afara
 * webroot-ului, generează thumbnail + metadate, inserează rândul în DB.
 */
async function ingest(opts) {
  const { srcPath, originalName, mime } = opts;
  const kind = classifyName(originalName, mime);
  if (!kind) { fs.rmSync(srcPath, { force: true }); throw new Error('tip de fișier neacceptat'); }

  let work = srcPath;
  let outName = originalName;
  let outMime = mime;
  if (kind === 'image' && OPT_UPLOADS !== 'off') {
    try {
      const opt = await optimizeImage(srcPath);
      if (opt) {
        fs.rmSync(srcPath, { force: true });
        work = opt.outPath;
        outMime = opt.mime;
        outName = String(originalName || 'imagine').replace(/\.[^./]+$/, '') + opt.ext;
      }
    } catch { /* păstrăm originalul */ }
  }

  const hash = await sha256File(work).catch(() => null);
  if (hash) {
    const dup = db.prepare('SELECT id FROM media WHERE sha256 = ? AND deleted_at IS NULL').get(hash);
    if (dup) { fs.rmSync(work, { force: true }); return { id: dup.id, duplicate: true }; }
  }

  const id = crypto.randomUUID();
  const ext = extOf(outName) || (kind === 'image' ? 'jpg' : 'mp4');
  const storedName = id + '.' + ext;
  const originalPath = path.join(ORIGINAL_DIR, storedName);
  const thumbPath = path.join(THUMB_DIR, id + '.webp');
  const size = fs.statSync(work).size;

  let width = null, height = null, duration = null, exifDate = null, hasThumb = 0;

  if (kind === 'image') {
    try {
      const meta = await sharp(work, { failOn: 'none', limitInputPixels: 2_000_000_000 }).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      exifDate = parseExifDate(meta.exif);
      await sharp(work, { failOn: 'none', limitInputPixels: 2_000_000_000 })
        .rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 }).toFile(thumbPath);
      hasThumb = 1;
    } catch { /* format nedecodabil */ }
    moveInto(work, originalPath);
  } else {
    moveInto(work, originalPath);
    const pm = ffprobeMeta(originalPath);
    width = pm.width ?? null; height = pm.height ?? null; duration = pm.duration ?? null;
    if (await ffmpegPoster(originalPath, thumbPath)) hasThumb = 1;
  }

  const createdAt = new Date().toISOString();
  const takenAt = opts.takenAtISO || exifDate || null;
  const row = {
    id, type: kind,
    mime: outMime || (kind === 'image' ? 'image/jpeg' : 'video/mp4'),
    stored_name: storedName, original_name: outName || null,
    width, height, size, duration, has_thumb: hasThumb,
    taken_at: takenAt, created_at: createdAt, sha256: hash || null,
    favorite: opts.favorite ? 1 : 0,
    archived: opts.archived ? 1 : 0,
    caption: opts.caption ? String(opts.caption).slice(0, 2000) : null,
  };
  db.prepare(`
    INSERT INTO media (id, type, mime, stored_name, original_name, width, height, size, duration,
      has_thumb, taken_at, created_at, sha256, favorite, archived, caption)
    VALUES (@id, @type, @mime, @stored_name, @original_name, @width, @height, @size, @duration,
      @has_thumb, @taken_at, @created_at, @sha256, @favorite, @archived, @caption)
  `).run(row);

  return {
    id, type: kind, mime: row.mime, originalName: row.original_name,
    width, height, size, duration, hasThumb: !!hasThumb, takenAt, createdAt, duplicate: false,
  };
}

async function processUpload(file) {
  return ingest({ srcPath: file.path, originalName: file.originalname, mime: file.mimetype });
}

// Calculează sha256 pentru mediile fără hash (pentru dedup la import). Fundal.
async function backfillHashes() {
  const rows = db.prepare("SELECT id, stored_name FROM media WHERE sha256 IS NULL AND deleted_at IS NULL LIMIT 5000").all();
  for (const r of rows) {
    const p = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(p)) continue;
    try {
      const h = await sha256File(p);
      db.prepare('UPDATE media SET sha256 = ? WHERE id = ?').run(h, r.id);
    } catch { /* skip */ }
  }
  if (rows.length) console.log('sha256 calculat pentru ' + rows.length + ' elemente');
}

// Reface posterul + metadatele pentru clipurile care nu au thumbnail
// (ex. încărcate înainte de instalarea ffmpeg). Rulează în fundal la pornire.
async function backfillVideoThumbs() {
  if (!FFMPEG) return;
  const rows = db.prepare(
    "SELECT id, stored_name FROM media WHERE type = 'video' AND has_thumb = 0 AND deleted_at IS NULL"
  ).all();
  let done = 0;
  for (const r of rows) {
    const src = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(src)) continue;
    const thumb = path.join(THUMB_DIR, `${r.id}.webp`);
    try {
      const ok = await ffmpegPoster(src, thumb);
      const pm = ffprobeMeta(src);
      db.prepare(`
        UPDATE media SET has_thumb = ?,
          width = COALESCE(width, ?), height = COALESCE(height, ?), duration = COALESCE(duration, ?)
        WHERE id = ?
      `).run(ok ? 1 : 0, pm.width ?? null, pm.height ?? null, pm.duration ?? null, r.id);
      if (ok) done++;
    } catch { /* trecem peste */ }
  }
  if (done) console.log(`postere video generate: ${done}/${rows.length}`);
}

module.exports = {
  processUpload,
  ingest,
  optimizeImage,
  remakeThumb,
  sha256File,
  classifyName,
  backfillVideoThumbs,
  backfillHashes,
  DATA_DIR,
  ORIGINAL_DIR,
  THUMB_DIR,
  TMP_DIR,
  UUID_RE,
  ffmpegAvailable: !!FFMPEG,
};
