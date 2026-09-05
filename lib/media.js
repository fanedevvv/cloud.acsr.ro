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
const MEDIA_DIR = process.env.MEDIA_DIR || DATA_DIR; // poze/clipuri (pot fi pe alt volum)
const ORIGINAL_DIR = path.join(MEDIA_DIR, 'originals');
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
const TMP_DIR = path.join(MEDIA_DIR, 'tmp');
for (const d of [ORIGINAL_DIR, THUMB_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const RAW_EXT = new Set(['cr2','cr3','nef','nrw','arw','sr2','srf','dng','rw2','orf','raf','pef','x3f','erf','kdc','3fr','mef','mos','mrw','rwl','iiq','raw']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp', ...RAW_EXT]);
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

let HEIFDEC = null, RAWDEC = null;
try { HEIFDEC = execFileSync('sh', ['-c', 'command -v heif-convert'], { encoding: 'utf8' }).trim() || null; } catch {}
try { RAWDEC = execFileSync('sh', ['-c', 'command -v dcraw_emu'], { encoding: 'utf8' }).trim() || null; } catch {}

// Decodează HEIC/HEIF (iPhone) sau RAW într-un fișier pe care sharp îl poate citi.
// Întoarce { path, mime } sau null (rămâne fișierul original).
function decodeExotic(srcPath, ext) {
  ext = String(ext || '').toLowerCase();
  if ((ext === 'heic' || ext === 'heif') && HEIFDEC) {
    const out = srcPath + '.dec.jpg';
    try {
      execFileSync(HEIFDEC, ['-q', '92', srcPath, out], { timeout: 90000, stdio: 'ignore' });
      // heif-convert scrie fie exact 'out', fie 'out-1.jpg' etc. pentru fișiere multi-imagine
      const dir = path.dirname(out), base = path.basename(srcPath) + '.dec';
      const cand = [out].concat(
        fs.readdirSync(dir).filter((n) => n.startsWith(base) && /\.jpe?g$/i.test(n)).sort().map((n) => path.join(dir, n))
      );
      for (const c of cand) {
        if (fs.existsSync(c) && fs.statSync(c).size > 0) return { path: c, mime: 'image/jpeg' };
      }
    } catch { /* nedecodabil */ }
    return null;
  }
  if (RAW_EXT.has(ext) && RAWDEC) {
    const out = srcPath + '.dec.tiff';
    try {
      // -w = balans de alb din aparat, -T = TIFF, -o 1 = sRGB, -Z = nume ieșire
      execFileSync(RAWDEC, ['-w', '-T', '-o', '1', '-Z', out, srcPath], { timeout: 180000, stdio: 'ignore' });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, mime: 'image/tiff' };
      for (const auto of [srcPath + '.tiff', srcPath.replace(/\.[^.]+$/, '') + '.tiff']) {
        if (fs.existsSync(auto) && fs.statSync(auto).size > 0) return { path: auto, mime: 'image/tiff' };
      }
    } catch { /* nedecodabil */ }
    return null;
  }
  return null;
}

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

// [grade, minute, secunde] + referință -> zecimal
function dmsToDec(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  let v = Number(dms[0]) + Number(dms[1]) / 60 + Number(dms[2]) / 3600;
  if (!Number.isFinite(v)) return null;
  if (ref === 'S' || ref === 'W') v = -v;
  return Math.round(v * 1e6) / 1e6;
}

function expToStr(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1 ? String(Math.round(n * 10) / 10) + 's' : '1/' + Math.round(1 / n);
}

/** Extrage aparatul / obiectivul / ISO / GPS dintr-un buffer EXIF (imagini). */
function extractExif(exifBuf) {
  const out = { lat: null, lon: null, camera: null, lens: null, iso: null, fNumber: null, exposure: null, focal: null };
  if (!exifBuf || !exifReader) return out;
  let ex;
  try { ex = exifReader(exifBuf); } catch { return out; }
  const img = ex.Image || ex.image || {};
  const photo = ex.Photo || ex.exif || {};
  const gps = ex.GPSInfo || ex.gps || {};

  const make = (img.Make || '').toString().trim();
  const model = (img.Model || '').toString().trim();
  out.camera = [make, model].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 120) || null;
  if (out.camera && model && out.camera.toLowerCase().startsWith((make + ' ' + make).toLowerCase().slice(0, 1))) { /* noop */ }
  out.lens = (photo.LensModel || photo.lensModel || '').toString().trim().slice(0, 120) || null;

  let iso = photo.ISOSpeedRatings ?? photo.PhotographicSensitivity ?? photo.ISO;
  if (Array.isArray(iso)) iso = iso[0];
  iso = Number(iso);
  out.iso = Number.isFinite(iso) && iso > 0 ? Math.round(iso) : null;

  const fn = Number(photo.FNumber);
  out.fNumber = Number.isFinite(fn) && fn > 0 ? Math.round(fn * 10) / 10 : null;
  out.exposure = expToStr(photo.ExposureTime);
  const fl = Number(photo.FocalLength);
  out.focal = Number.isFinite(fl) && fl > 0 ? Math.round(fl * 10) / 10 : null;

  out.lat = dmsToDec(gps.GPSLatitude, gps.GPSLatitudeRef);
  out.lon = dmsToDec(gps.GPSLongitude, gps.GPSLongitudeRef);
  if (out.lat === 0 && out.lon === 0) { out.lat = null; out.lon = null; }
  return out;
}

// ISO 6709 ("+44.4325+026.1039/") folosit de clipurile Apple -> {lat, lon}
function parseISO6709(s) {
  const m = String(s || '').match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return { lat: null, lon: null };
  const lat = Math.round(Number(m[1]) * 1e6) / 1e6;
  const lon = Math.round(Number(m[2]) * 1e6) / 1e6;
  return { lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null };
}

function ffprobeMeta(file) {
  if (!FFPROBE) return {};
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration:format_tags',
        '-of', 'json', file],
      { encoding: 'utf8', timeout: 30000 }
    );
    const j = JSON.parse(out);
    const tags = j.format?.tags || {};
    const loc = tags['com.apple.quicktime.location.ISO6709'] || tags.location || tags['location-eng'] || '';
    const g = parseISO6709(loc);
    const make = (tags['com.apple.quicktime.make'] || tags.make || '').toString().trim();
    const model = (tags['com.apple.quicktime.model'] || tags.model || '').toString().trim();
    return {
      width: j.streams?.[0]?.width ?? null,
      height: j.streams?.[0]?.height ?? null,
      duration: j.format?.duration ? Number(j.format.duration) : null,
      lat: g.lat, lon: g.lon,
      camera: [make, model].filter(Boolean).join(' ').slice(0, 120) || null,
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

// Categorie automată, doar euristici (fără ML): 'screenshot' | 'selfie' | null
function detectAutoKind({ name, kind, fmt, camera, lens, lat, width, height }) {
  if (kind !== 'image') return null;
  if (/scre[ -]?shot|captur[ăa] de ecran|screenshot/i.test(name || '')) return 'screenshot';
  if (/front camera|selfie/i.test(lens || '')) return 'selfie';
  // PNG fără aparat foto și fără GPS, cu proporții „de ecran" -> probabil captură
  if (!camera && !lat && (fmt === 'png') && width && height) {
    const ar = width / height;
    if (ar < 0.62 || ar > 2.2 || (Math.abs(ar - 16 / 9) < 0.03) || (Math.abs(ar - 9 / 16) < 0.03)) return 'screenshot';
  }
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
    try {
      await sharp(srcPath, { failOn: 'none', limitInputPixels: 2_000_000_000 })
        .rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 }).toFile(path.join(THUMB_DIR, id + '.preview.webp'));
    } catch { /* preview opțional */ }
    return true;
  }
  return ffmpegPoster(srcPath, thumbPath);
}

// Generează preview-uri de 1600px pentru imaginile care n-au (fundal, la pornire).
async function backfillPreviews(limit = 3000) {
  const rows = await db.prepare(
    "SELECT id, stored_name FROM media WHERE type = 'image' AND has_thumb = 1 AND deleted_at IS NULL LIMIT ?"
  ).all(limit);
  let done = 0;
  for (const r of rows) {
    const pv = path.join(THUMB_DIR, r.id + '.preview.webp');
    if (fs.existsSync(pv)) continue;
    const src = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(src)) continue;
    try {
      await sharp(src, { failOn: 'none', limitInputPixels: 2_000_000_000 })
        .rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 }).toFile(pv);
      done++;
    } catch { /* skip */ }
  }
  if (done) console.log(`preview 1600px generat pentru ${done} imagini`);
}

// Live Photo: împerechează o poză cu clipul ei de mișcare (același nume de bază,
// încărcate aproape în același timp). Marchează clipul ca 'is_live_motion'.
function liveBase(name) {
  return String(name || '').replace(/\.[^.]+$/, '').replace(/[ _-]?(hevc|hdr|live|motion)$/i, '').toLowerCase().trim();
}
async function tryPairLive(id, kind, originalName, createdAt) {
  const base = liveBase(originalName);
  if (!base || base.length < 3) return;
  const since = new Date(Date.parse(createdAt) - 180000).toISOString();
  const other = kind === 'image' ? 'video' : 'image';
  const cand = await db.prepare(
    "SELECT id, original_name FROM media WHERE type = ? AND deleted_at IS NULL AND created_at >= ? AND id != ? ORDER BY created_at DESC LIMIT 20"
  ).all(other, since, id);
  const match = cand.find((c) => liveBase(c.original_name) === base);
  if (!match) return;
  const still = kind === 'image' ? id : match.id;
  const motion = kind === 'image' ? match.id : id;
  await db.prepare('UPDATE media SET live_video_id = ? WHERE id = ?').run(motion, still);
  await db.prepare('UPDATE media SET is_live_motion = 1 WHERE id = ?').run(motion);
}

/**
 * Nucleu comun de ingestie: dedup după sha256, mută fișierul în afara
 * webroot-ului, generează thumbnail + metadate, inserează rândul în DB.
 */
async function ingest(opts) {
  const { srcPath, originalName, mime } = opts;
  const kind = classifyName(originalName, mime);
  if (!kind) { fs.rmSync(srcPath, { force: true }); throw new Error('tip de fișier neacceptat'); }

  let src = srcPath;
  let outName = originalName;
  let outMime = mime;

  // HEIC/RAW -> decodează întâi într-un JPEG/TIFF lizibil de sharp
  const e0 = extOf(originalName);
  if (kind === 'image' && (e0 === 'heic' || e0 === 'heif' || RAW_EXT.has(e0))) {
    const dec = decodeExotic(src, e0);
    if (dec) {
      fs.rmSync(src, { force: true });
      src = dec.path;
      outMime = dec.mime;
      outName = String(originalName || 'imagine').replace(/\.[^./]+$/, '') + (dec.mime === 'image/tiff' ? '.tiff' : '.jpg');
    }
  }

  let work = src;
  if (kind === 'image' && OPT_UPLOADS !== 'off') {
    try {
      const opt = await optimizeImage(src);
      if (opt) {
        fs.rmSync(src, { force: true });
        work = opt.outPath;
        outMime = opt.mime;
        outName = String(originalName || 'imagine').replace(/\.[^./]+$/, '') + opt.ext;
      }
    } catch { /* păstrăm originalul */ }
  }

  const hash = await sha256File(work).catch(() => null);
  if (hash) {
    const dup = await db.prepare('SELECT id FROM media WHERE sha256 = ? AND deleted_at IS NULL').get(hash);
    if (dup) { fs.rmSync(work, { force: true }); return { id: dup.id, duplicate: true }; }
  }

  const id = crypto.randomUUID();
  const ext = extOf(outName) || (kind === 'image' ? 'jpg' : 'mp4');
  const storedName = id + '.' + ext;
  const originalPath = path.join(ORIGINAL_DIR, storedName);
  const thumbPath = path.join(THUMB_DIR, id + '.webp');
  const size = fs.statSync(work).size;

  let width = null, height = null, duration = null, exifDate = null, hasThumb = 0;
  let ex = { lat: null, lon: null, camera: null, lens: null, iso: null, fNumber: null, exposure: null, focal: null };
  let fmt = null;

  if (kind === 'image') {
    try {
      const meta = await sharp(work, { failOn: 'none', limitInputPixels: 2_000_000_000 }).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      fmt = meta.format || null;
      exifDate = parseExifDate(meta.exif);
      ex = extractExif(meta.exif);
      await sharp(work, { failOn: 'none', limitInputPixels: 2_000_000_000 })
        .rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 }).toFile(thumbPath);
      hasThumb = 1;
      try {
        await sharp(work, { failOn: 'none', limitInputPixels: 2_000_000_000 })
          .rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 }).toFile(path.join(THUMB_DIR, id + '.preview.webp'));
      } catch { /* preview opțional */ }
    } catch { /* format nedecodabil */ }
    moveInto(work, originalPath);
  } else {
    moveInto(work, originalPath);
    const pm = ffprobeMeta(originalPath);
    width = pm.width ?? null; height = pm.height ?? null; duration = pm.duration ?? null;
    ex.lat = pm.lat ?? null; ex.lon = pm.lon ?? null; ex.camera = pm.camera ?? null;
    if (await ffmpegPoster(originalPath, thumbPath)) hasThumb = 1;
  }

  const kindAuto = detectAutoKind({ name: originalName, kind, fmt, camera: ex.camera, lens: ex.lens, lat: ex.lat, width, height });

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
    lat: ex.lat, lon: ex.lon, camera: ex.camera, lens: ex.lens,
    iso: ex.iso, f_number: ex.fNumber, exposure: ex.exposure, focal: ex.focal,
    exif_done: 1, kind_auto: kindAuto,
  };
  await db.prepare(`
    INSERT INTO media (id, type, mime, stored_name, original_name, width, height, size, duration,
      has_thumb, taken_at, created_at, sha256, favorite, archived, caption,
      lat, lon, camera, lens, iso, f_number, exposure, focal, exif_done, kind_auto)
    VALUES (:id, :type, :mime, :stored_name, :original_name, :width, :height, :size, :duration,
      :has_thumb, :taken_at, :created_at, :sha256, :favorite, :archived, :caption,
      :lat, :lon, :camera, :lens, :iso, :f_number, :exposure, :focal, :exif_done, :kind_auto)
  `).run(row);

  await tryPairLive(id, kind, originalName, createdAt);

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
  const rows = await db.prepare("SELECT id, stored_name FROM media WHERE sha256 IS NULL AND deleted_at IS NULL LIMIT 5000").all();
  for (const r of rows) {
    const p = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(p)) continue;
    try {
      const h = await sha256File(p);
      await db.prepare('UPDATE media SET sha256 = ? WHERE id = ?').run(h, r.id);
    } catch { /* skip */ }
  }
  if (rows.length) console.log('sha256 calculat pentru ' + rows.length + ' elemente');
}

// Extrage EXIF/GPS pentru mediile vechi (încărcate înainte de funcția asta). Fundal.
async function backfillExif() {
  const rows = await db.prepare(
    "SELECT id, stored_name, type, original_name, width, height FROM media WHERE exif_done = 0 AND deleted_at IS NULL LIMIT 4000"
  ).all();
  let done = 0;
  for (const r of rows) {
    const p = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(p)) { await db.prepare('UPDATE media SET exif_done = 1 WHERE id = ?').run(r.id); continue; }
    let ex = { lat: null, lon: null, camera: null, lens: null, iso: null, fNumber: null, exposure: null, focal: null };
    let fmt = null;
    try {
      if (r.type === 'image') {
        const meta = await sharp(p, { failOn: 'none', limitInputPixels: 2_000_000_000 }).metadata();
        fmt = meta.format || null;
        ex = extractExif(meta.exif);
      } else {
        const pm = ffprobeMeta(p);
        ex.lat = pm.lat ?? null; ex.lon = pm.lon ?? null; ex.camera = pm.camera ?? null;
      }
    } catch { /* trecem peste */ }
    const kindAuto = detectAutoKind({ name: r.original_name, kind: r.type, fmt, camera: ex.camera, lens: ex.lens, lat: ex.lat, width: r.width, height: r.height });
    await db.prepare(`
      UPDATE media SET lat=:lat, lon=:lon, camera=:camera, lens=:lens, iso=:iso,
        f_number=:f_number, exposure=:exposure, focal=:focal, kind_auto=:kind_auto, exif_done=1
      WHERE id=:id
    `).run({
      id: r.id, lat: ex.lat, lon: ex.lon, camera: ex.camera, lens: ex.lens, iso: ex.iso,
      f_number: ex.fNumber, exposure: ex.exposure, focal: ex.focal, kind_auto: kindAuto,
    });
    if (ex.lat != null || ex.camera) done++;
  }
  if (rows.length) console.log(`EXIF completat pentru ${rows.length} elemente (${done} cu date)`);
}

// Reface posterul + metadatele pentru clipurile care nu au thumbnail
// (ex. încărcate înainte de instalarea ffmpeg). Rulează în fundal la pornire.
async function backfillVideoThumbs() {
  if (!FFMPEG) return;
  const rows = await db.prepare(
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
      await db.prepare(`
        UPDATE media SET has_thumb = ?,
          width = COALESCE(width, ?), height = COALESCE(height, ?), duration = COALESCE(duration, ?)
        WHERE id = ?
      `).run(ok ? 1 : 0, pm.width ?? null, pm.height ?? null, pm.duration ?? null, r.id);
      if (ok) done++;
    } catch { /* trecem peste */ }
  }
  if (done) console.log(`postere video generate: ${done}/${rows.length}`);
}

// Scor de claritate (varianța Laplacianului pe o versiune mică, în tonuri
// de gri) — euristică standard, ieftin de calculat. Scor mic = poză neclară.
const LAPLACIAN = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };
async function computeBlurScore(srcPath) {
  const { data, info } = await sharp(srcPath, { failOn: 'none', limitInputPixels: 2_000_000_000 })
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .convolve(LAPLACIAN)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < data.length; i++) { const d = data[i] - mean; variance += d * d; }
  return variance / n;
}

// Completează blur_score pentru imagini (fundal, la pornire).
async function backfillBlur(limit = 3000) {
  const rows = await db.prepare(
    "SELECT id, stored_name FROM media WHERE type = 'image' AND blur_done = 0 AND deleted_at IS NULL LIMIT ?"
  ).all(limit);
  let done = 0;
  for (const r of rows) {
    const p = path.join(ORIGINAL_DIR, r.stored_name);
    if (!fs.existsSync(p)) { await db.prepare('UPDATE media SET blur_done = 1 WHERE id = ?').run(r.id); continue; }
    try {
      const score = await computeBlurScore(p);
      await db.prepare('UPDATE media SET blur_score = ?, blur_done = 1 WHERE id = ?').run(score, r.id);
      done++;
    } catch { await db.prepare('UPDATE media SET blur_done = 1 WHERE id = ?').run(r.id); }
  }
  if (rows.length) console.log(`claritate calculată pentru ${done}/${rows.length} imagini`);
}

module.exports = {
  processUpload,
  ingest,
  optimizeImage,
  computeBlurScore,
  backfillBlur,
  remakeThumb,
  sha256File,
  classifyName,
  backfillVideoThumbs,
  backfillHashes,
  backfillExif,
  backfillPreviews,
  extractExif,
  DATA_DIR,
  ORIGINAL_DIR,
  THUMB_DIR,
  TMP_DIR,
  UUID_RE,
  ffmpegAvailable: !!FFMPEG,
};
