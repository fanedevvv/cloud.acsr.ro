'use strict';
// Proces separat pentru ML (CLIP + OCR). Izolează onnxruntime/sharp de serverul
// principal — rularea în același proces coruperupea heap-ul ("double free").
// Comunică prin IPC: mesaje { id, op, ... } -> răspuns { id, ok, ... }.
process.env.OMP_NUM_THREADS = '1';

const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join(__dirname, '..', 'data');
const MODELS_DIR = path.join(DATA_DIR, 'models');
fs.mkdirSync(MODELS_DIR, { recursive: true });

let T = null, clip = null, tess = null;

async function loadT() {
  if (T) return T;
  T = await import('@xenova/transformers');
  T.env.cacheDir = MODELS_DIR;
  T.env.allowRemoteModels = true;
  if (T.env.backends?.onnx?.wasm) T.env.backends.onnx.wasm.numThreads = 1;
  return T;
}
async function getClip() {
  if (clip) return clip;
  const t = await loadT();
  const id = 'Xenova/clip-vit-base-patch32';
  const processor = await t.AutoProcessor.from_pretrained(id);
  const vision = await t.CLIPVisionModelWithProjection.from_pretrained(id, { quantized: true });
  const tokenizer = await t.AutoTokenizer.from_pretrained(id);
  const text = await t.CLIPTextModelWithProjection.from_pretrained(id, { quantized: true });
  clip = { processor, vision, tokenizer, text, RawImage: t.RawImage };
  return clip;
}
function norm(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; s = Math.sqrt(s) || 1; const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / s; return o; }
async function embedImage(file) {
  const c = await getClip();
  const im = await c.RawImage.read(file);
  const inp = await c.processor(im);
  const { image_embeds } = await c.vision(inp);
  return norm(image_embeds.data);
}
async function embedText(q) {
  const c = await getClip();
  const inp = c.tokenizer([String(q)], { padding: true, truncation: true });
  const { text_embeds } = await c.text(inp);
  return norm(text_embeds.data);
}
async function getTess() {
  if (tess) return tess;
  const { createWorker } = require('tesseract.js');
  tess = await createWorker(['eng', 'ron'], 1, { cachePath: MODELS_DIR });
  return tess;
}
async function ocrImage(file) {
  const w = await getTess();
  const { data } = await w.recognize(file);
  return String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// Baza de date: conexiune proprie a worker-ului (WAL — coexistă cu serverul)
const Database = require('better-sqlite3');
let wdb = null;
const getDb = () => (wdb || (wdb = new Database(path.join(DATA_DIR, 'media.db'))));
const ORIGINAL_DIR = path.join(process.env.MEDIA_DIR || DATA_DIR, 'originals');
const THUMB_DIR = path.join(process.env.MEDIA_DIR || DATA_DIR, 'thumbs');

async function runIndex(msg) {
  const db = getDb();
  const ocr = !!msg.ocr;
  send({ id: msg.id, ev: 'progress', phase: 'scanning', total: 0, done: 0, embedded: 0, ocred: 0 });
  const rows = db.prepare(`
    SELECT m.id, m.type, m.stored_name, m.ocr_done, e.media_id AS hasVec
    FROM media m LEFT JOIN media_embed e ON e.media_id = m.id
    WHERE m.deleted_at IS NULL
  `).all();
  const todo = rows.filter((r) => !r.hasVec || (ocr && !r.ocr_done && r.type === 'image'));
  const insVec = db.prepare('INSERT OR REPLACE INTO media_embed (media_id, vec, done_at) VALUES (?, ?, ?)');
  const setOcr = db.prepare('UPDATE media SET ocr_text = ?, ocr_done = 1 WHERE id = ?');
  let embedded = 0, ocred = 0, done = 0;
  for (const r of todo) {
    const thumb = path.join(THUMB_DIR, r.id + '.webp');
    const orig = path.join(ORIGINAL_DIR, r.stored_name);
    const img = fs.existsSync(thumb) ? thumb : orig;
    try {
      if (!r.hasVec && fs.existsSync(img)) {
        const v = await embedImage(img);
        insVec.run(r.id, Buffer.from(v.buffer, v.byteOffset, v.byteLength), new Date().toISOString());
        embedded++;
      }
      if (ocr && r.type === 'image' && !r.ocr_done && fs.existsSync(img)) {
        setOcr.run((await ocrImage(img)) || null, r.id);
        ocred++;
      }
    } catch (e) { /* sări peste */ }
    done++;
    if (done % 3 === 0 || done === todo.length) {
      send({ id: msg.id, ev: 'progress', phase: 'running', total: todo.length, done, embedded, ocred });
    }
  }
  send({ id: msg.id, ev: 'done', phase: 'done', total: todo.length, done, embedded, ocred });
}

function send(o) { try { process.send(o); } catch {} }

process.on('message', async (msg) => {
  try {
    if (msg.op === 'ping') return send({ id: msg.id, ok: true });
    if (msg.op === 'embedText') {
      const v = await embedText(msg.q);
      return send({ id: msg.id, ok: true, vec: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') });
    }
    if (msg.op === 'index') return void runIndex(msg);
    send({ id: msg.id, ok: false, error: 'op necunoscut' });
  } catch (e) {
    send({ id: msg.id, ok: false, error: e && e.message || String(e) });
  }
});
process.on('disconnect', () => process.exit(0));
send({ ev: 'ready' });
