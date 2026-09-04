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
// Traducere interogare -> engleză (CLIP e antrenat pe engleză). Model mic
// pentru limbile romanice (inclusiv română). Se poate opri cu TRANSLATE_QUERIES=off.
let translator = null;
const trCache = new Map();
const TRANSLATE = (process.env.TRANSLATE_QUERIES || 'on').toLowerCase() !== 'off';
async function getTranslator() {
  if (translator) return translator;
  const t = await loadT();
  translator = await t.pipeline('translation', 'Xenova/opus-mt-ROMANCE-en', { quantized: true });
  return translator;
}
async function toEnglish(q) {
  q = String(q).trim();
  if (!TRANSLATE || !q) return q;
  if (trCache.has(q)) return trCache.get(q);
  try {
    const tr = await getTranslator();
    const out = await tr(q, { max_new_tokens: 48 });
    const en = (Array.isArray(out) ? out[0] : out).translation_text || q;
    trCache.set(q, en);
    return en;
  } catch { return q; }
}

async function embedText(q, opts) {
  const c = await getClip();
  const text = (opts && opts.translate === false) ? String(q) : await toEnglish(q);
  const inp = c.tokenizer([text], { padding: true, truncation: true });
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

// Concepte pentru „Lucruri" (etichetă RO, prompt EN pentru CLIP)
const CONCEPTS = [
  ['Plajă', 'a photo of a beach with sand and sea'],
  ['Munte', 'a photo of mountains'],
  ['Mâncare', 'a photo of food, a meal on a plate'],
  ['Apus', 'a photo of a sunset or sunrise sky'],
  ['Flori', 'a close-up photo of flowers'],
  ['Mașini', 'a photo of a car or vehicle'],
  ['Animale', 'a photo of an animal or a pet'],
  ['Clădiri', 'a photo of buildings and architecture'],
  ['Noapte', 'a night photo with city lights'],
  ['Zăpadă', 'a photo of snow in winter'],
  ['Apă', 'a photo of the sea, a lake or a river'],
  ['Petreceri', 'a photo of a party or celebration'],
  ['Sport', 'a photo of people doing sports'],
  ['Natură', 'a landscape photo of nature, forest or fields'],
  ['Documente', 'a scan or photo of a document with text'],
  ['Selfie', 'a selfie portrait photo of a person'],
];
let conceptVecs = null;
async function getConceptVecs() {
  if (conceptVecs) return conceptVecs;
  conceptVecs = [];
  for (const [tag, prompt] of CONCEPTS) conceptVecs.push([tag, await embedText(prompt, { translate: false })]);
  return conceptVecs;
}
function cos(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

async function runIndex(msg) {
  const db = getDb();
  const ocr = !!msg.ocr;
  send({ id: msg.id, ev: 'progress', phase: 'scanning', total: 0, done: 0, embedded: 0, ocred: 0 });
  const rows = db.prepare(`
    SELECT m.id, m.type, m.stored_name, m.ocr_done, e.media_id AS hasVec
    FROM media m LEFT JOIN media_embed e ON e.media_id = m.id
    WHERE m.deleted_at IS NULL AND m.is_live_motion = 0
  `).all();
  const todo = rows.filter((r) => !r.hasVec || (ocr && !r.ocr_done && r.type === 'image'));
  const insVec = db.prepare('INSERT OR REPLACE INTO media_embed (media_id, vec, done_at) VALUES (?, ?, ?)');
  const setOcr = db.prepare('UPDATE media SET ocr_text = ?, ocr_done = 1 WHERE id = ?');
  const insTag = db.prepare('INSERT OR REPLACE INTO media_tags (media_id, tag, score) VALUES (?, ?, ?)');
  const concepts = await getConceptVecs().catch(() => null);
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
        if (concepts && r.type === 'image') {
          const scored = concepts.map(([tag, cv]) => [tag, cos(v, cv)]).sort((a, b) => b[1] - a[1]);
          db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(r.id);
          for (const [tag, sc] of scored.slice(0, 4)) if (sc >= 0.235) insTag.run(r.id, tag, sc);
        }
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

async function runRetag(msg) {
  const db = getDb();
  const concepts = await getConceptVecs();
  const rows = db.prepare('SELECT media_id, vec FROM media_embed').all();
  send({ id: msg.id, ev: 'progress', phase: 'running', total: rows.length, done: 0, embedded: 0, ocred: 0 });
  const insTag = db.prepare('INSERT OR REPLACE INTO media_tags (media_id, tag, score) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM media_tags WHERE media_id = ?');
  let done = 0, tagged = 0;
  for (const r of rows) {
    try {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      const scored = concepts.map(([tag, cv]) => [tag, cos(v, cv)]).sort((a, b) => b[1] - a[1]);
      del.run(r.media_id);
      for (const [tag, sc] of scored.slice(0, 4)) if (sc >= 0.235) { insTag.run(r.media_id, tag, sc); tagged++; }
    } catch {}
    done++;
    if (done % 20 === 0 || done === rows.length) send({ id: msg.id, ev: 'progress', phase: 'running', total: rows.length, done, embedded: tagged, ocred: 0 });
  }
  send({ id: msg.id, ev: 'done', phase: 'done', total: rows.length, done, embedded: tagged, ocred: 0 });
}

function send(o) { try { process.send(o); } catch {} }

process.on('message', async (msg) => {
  try {
    if (msg.op === 'ping') return send({ id: msg.id, ok: true });
    if (msg.op === 'retag') return void runRetag(msg);
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
