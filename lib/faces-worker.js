'use strict';
// Proces separat pentru detecția + gruparea fețelor (face-api.js pe tfjs-wasm —
// CPU-ul mașinii nu are AVX, deci tfjs-node dă SIGILL; wasm merge).
process.env.OMP_NUM_THREADS = '1';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MEDIA_DIR = process.env.MEDIA_DIR || DATA_DIR;
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
const ORIGINAL_DIR = path.join(MEDIA_DIR, 'originals');
const MODEL_DIR = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model');
const WASM_DIR = path.join(__dirname, '..', 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist') + path.sep;
const JOIN_TH = 0.54;

let faceapi = null;
async function load() {
  if (faceapi) return faceapi;
  faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  await faceapi.tf.setWasmPaths(WASM_DIR);
  await faceapi.tf.setBackend('wasm');
  await faceapi.tf.ready();
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  return faceapi;
}

const getDb = () => require('./db');
const send = (o) => { try { process.send(o); } catch {} };
const f2b = (arr) => Buffer.from(Float32Array.from(arr).buffer);
const b2f = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
function dist(a, b) { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

async function tensorFrom(file) {
  const { data, info } = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { t: faceapi.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]), w: info.width, h: info.height };
}

// grupare incrementală: min-distanță față de membrii clusterului, fără 2 fețe din aceeași poză
async function assignCluster(db, mediaId, desc) {
  const clusters = await db.prepare('SELECT id FROM face_clusters').all();
  let best = null, bestD = 1e9;
  for (const c of clusters) {
    const already = await db.prepare('SELECT 1 v FROM faces WHERE cluster_id = ? AND media_id = ?').get(c.id, mediaId);
    if (already) continue;
    const mem = await db.prepare('SELECT descriptor FROM faces WHERE cluster_id = ? LIMIT 12').all(c.id);
    let md = 1e9;
    for (const m of mem) md = Math.min(md, dist(desc, b2f(m.descriptor)));
    if (md < bestD) { bestD = md; best = c.id; }
  }
  if (best && bestD < JOIN_TH) {
    await db.prepare('UPDATE face_clusters SET n = n + 1 WHERE id = ?').run(best);
    return best;
  }
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO face_clusters (id, name, cover_face_id, n, created_at) VALUES (?, NULL, NULL, 1, ?)')
    .run(id, new Date().toISOString());
  return id;
}

async function runIndex(msg) {
  await load();
  const db = getDb();
  send({ id: msg.id, ev: 'progress', phase: 'scanning', total: 0, done: 0, faces: 0, people: 0 });
  const rows = await db.prepare("SELECT id, stored_name FROM media WHERE type = 'image' AND deleted_at IS NULL AND faces_done = 0").all();
  const insFace = db.prepare('INSERT INTO faces (id, media_id, cluster_id, box, score, descriptor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const setCover = db.prepare('UPDATE face_clusters SET cover_face_id = ? WHERE id = ? AND cover_face_id IS NULL');
  let done = 0, faces = 0;
  for (const r of rows) {
    const thumb = path.join(THUMB_DIR, r.id + '.webp');
    const orig = path.join(ORIGINAL_DIR, r.stored_name);
    const file = fs.existsSync(thumb) ? thumb : orig;
    try {
      if (fs.existsSync(file)) {
        const { t, w, h } = await tensorFrom(file);
        const res = await faceapi.detectAllFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.55 }))
          .withFaceLandmarks().withFaceDescriptors();
        t.dispose();
        for (const d of res) {
          const b = d.detection.box;
          const box = JSON.stringify([
            Math.max(0, b.x / w), Math.max(0, b.y / h),
            Math.min(1, b.width / w), Math.min(1, b.height / h),
          ]);
          const fid = crypto.randomUUID();
          const desc = Float32Array.from(d.descriptor);
          const c = await assignCluster(db, r.id, desc);
          await insFace.run(fid, r.id, c, box, d.detection.score, f2b(desc), new Date().toISOString());
          await setCover.run(fid, c);
          faces++;
        }
      }
      await db.prepare('UPDATE media SET faces_done = 1 WHERE id = ?').run(r.id);
    } catch (e) { await db.prepare('UPDATE media SET faces_done = 1 WHERE id = ?').run(r.id); }
    done++;
    if (done % 2 === 0 || done === rows.length) {
      const people = (await db.prepare('SELECT COUNT(*) n FROM face_clusters WHERE n >= 2').get()).n;
      send({ id: msg.id, ev: 'progress', phase: 'running', total: rows.length, done, faces, people });
    }
  }
  const people = (await db.prepare('SELECT COUNT(*) n FROM face_clusters WHERE n >= 2').get()).n;
  send({ id: msg.id, ev: 'done', phase: 'done', total: rows.length, done, faces, people });
}

process.on('message', async (msg) => {
  try {
    if (msg.op === 'ping') { await load(); return send({ id: msg.id, ok: true }); }
    if (msg.op === 'index') return void runIndex(msg);
    send({ id: msg.id, ok: false, error: 'op necunoscut' });
  } catch (e) { send({ id: msg.id, ok: false, error: e && e.message || String(e) }); }
});
process.on('disconnect', () => process.exit(0));
send({ ev: 'ready' });
