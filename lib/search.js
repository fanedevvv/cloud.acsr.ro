'use strict';
// Client pentru worker-ul ML (lib/ml-worker.js). Serverul principal NU încarcă
// onnxruntime — doar relează cererile și face rankingul cosinus (JS pur).
const path = require('path');
const { fork } = require('child_process');
const db = require('./db');
const joblog = require('./joblog');

let worker = null;
let ready = false;
let seq = 0;
const pending = new Map();      // id -> {resolve, reject}
let job = null;                 // starea jobului de indexare (in-memory)

function spawn() {
  worker = fork(path.join(__dirname, 'ml-worker.js'), [], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', (m) => {
    if (m.ev === 'ready') { ready = true; return; }
    if (m.ev === 'progress' && job && m.id === job.id) {
      Object.assign(job, { phase: m.phase, total: m.total, done: m.done, embedded: m.embedded, ocred: m.ocred });
      return;
    }
    if (m.ev === 'done' && job && m.id === job.id) {
      Object.assign(job, { phase: 'done', total: m.total, done: m.done, embedded: m.embedded, ocred: m.ocred, finishedAt: new Date().toISOString() });
      joblog.finish(job._log, 'done', job.embedded + ' imagini' + (job.ocred ? ', ' + job.ocred + ' OCR' : ''));
      return;
    }
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'eroare worker'));
    }
  });
  worker.on('exit', (code) => {
    ready = false; worker = null;
    for (const p of pending.values()) p.reject(new Error('worker oprit'));
    pending.clear();
    if (job && !job.finishedAt) { job.phase = 'error'; job.error = 'worker oprit (cod ' + code + ')'; joblog.finish(job._log, 'error', job.error); }
  });
}
function ensure() { if (!worker) spawn(); return worker; }
function call(op, extra = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    ensure();
    const id = ++seq;
    pending.set(id, { resolve, reject });
    const to = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout worker')); } }, timeoutMs);
    const done = (fn) => (v) => { clearTimeout(to); fn(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    worker.send({ id, op, ...extra });
  });
}

// ─── Indexare ────────────────────────────────────────────────────────────
let jseq = 0;
function newJob(kind) { job = { id: 'idx' + (++jseq), phase: 'starting', total: 0, done: 0, embedded: 0, ocred: 0, startedAt: new Date().toISOString() }; job._log = joblog.start(kind || 'Indexare'); return job; }
const getJob = (id) => (job && String(job.id) === String(id) ? job : null);
const current = () => job;

function runIndex(j, { ocr }) {
  ensure();
  worker.send({ id: j.id, op: 'index', ocr: !!ocr });
  return Promise.resolve();
}

function runRetag(j) {
  ensure();
  worker.send({ id: j.id, op: 'retag' });
  return Promise.resolve();
}

function things() {
  return db.prepare(`
    SELECT t.tag, COUNT(*) n,
      (SELECT media_id FROM media_tags t2 JOIN media m2 ON m2.id = t2.media_id
       WHERE t2.tag = t.tag AND m2.deleted_at IS NULL AND m2.archived = 0 AND m2.locked = 0 AND m2.is_live_motion = 0
       ORDER BY t2.score DESC LIMIT 1) AS sampleId
    FROM media_tags t JOIN media m ON m.id = t.media_id
    WHERE m.deleted_at IS NULL AND m.archived = 0 AND m.locked = 0 AND m.is_live_motion = 0
    GROUP BY t.tag ORDER BY n DESC
  `).all();
}
function thingItems(tag) {
  return db.prepare(`
    SELECT mt.media_id AS id, mt.score FROM media_tags mt JOIN media m ON m.id = mt.media_id
    WHERE mt.tag = ? AND m.deleted_at IS NULL AND m.archived = 0 AND m.locked = 0 AND m.is_live_motion = 0
    ORDER BY mt.score DESC
  `).all(String(tag)).map((r) => r.id);
}

// ─── Interogare ──────────────────────────────────────────────────────────
function cosine(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

async function search(q, { limit = 120 } = {}) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const scores = new Map();
  const bump = (id, s) => scores.set(id, Math.max(scores.get(id) || 0, s));

  // 1. semantic
  const vecRows = db.prepare(`
    SELECT e.media_id, e.vec FROM media_embed e
    JOIN media m ON m.id = e.media_id
    WHERE m.deleted_at IS NULL AND m.archived = 0 AND m.locked = 0 AND m.is_live_motion = 0
  `).all();
  if (vecRows.length) {
    let tv = null;
    try {
      const r = await call('embedText', { q }, 60000);
      const buf = Buffer.from(r.vec, 'base64');
      tv = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    } catch { tv = null; }
    if (tv) {
      const sims = vecRows.map((r) => {
        const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
        return [r.media_id, cosine(tv, v)];
      }).sort((a, b) => b[1] - a[1]);
      // prag dinamic: reține doar ce e aproape de cel mai bun scor (și peste un minim)
      const top = sims.length ? sims[0][1] : 0;
      const cut = Math.max(0.22, top - 0.045);
      for (const [id, c] of sims) {
        if (c < cut) break;
        bump(id, 0.4 + c);
      }
    }
  }

  // 2. OCR / nume / descriere
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const ql = q.toLowerCase();
  for (const r of db.prepare(`
    SELECT id, ocr_text, original_name, caption FROM media
    WHERE deleted_at IS NULL AND archived = 0 AND locked = 0
      AND (ocr_text LIKE ? OR original_name LIKE ? OR caption LIKE ?)
  `).all(like, like, like)) {
    let s = 0.5;
    if (r.caption && r.caption.toLowerCase().includes(ql)) s = 1.6;
    else if (r.original_name && r.original_name.toLowerCase().includes(ql)) s = 1.2;
    else if (r.ocr_text) s = 1.0;
    bump(r.id, s);
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

// Grupuri de aproape-duplicate din embeddings (cosinus > prag). O(n²) — limitat.
function nearDuplicates(th = 0.955, cap = 6000) {
  const rows = db.prepare(`
    SELECT e.media_id AS id, e.vec FROM media_embed e JOIN media m ON m.id = e.media_id
    WHERE m.deleted_at IS NULL AND m.archived = 0 AND m.locked = 0 AND m.is_live_motion = 0
  `).all();
  if (rows.length > cap) return [];
  const ids = rows.map((r) => r.id);
  const vs = rows.map((r) => new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
  const parent = ids.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      let s = 0; const a = vs[i], b = vs[j];
      for (let k = 0; k < 512; k++) s += a[k] * b[k];
      if (s > th) uni(i, j);
    }
  }
  const g = new Map();
  for (let i = 0; i < ids.length; i++) {
    const r = find(i);
    if (!g.has(r)) g.set(r, []);
    g.get(r).push(ids[i]);
  }
  return [...g.values()].filter((x) => x.length > 1);
}

function stats() {
  const embed = db.prepare('SELECT COUNT(*) n FROM media_embed').get().n;
  const ocr = db.prepare('SELECT COUNT(*) n FROM media WHERE ocr_done = 1').get().n;
  const total = db.prepare('SELECT COUNT(*) n FROM media WHERE deleted_at IS NULL').get().n;
  return { embed, ocr, total };
}

function warm() { call('embedText', { q: 'photo' }, 90000).catch(() => {}); }

module.exports = { newJob, getJob, current, runIndex, runRetag, search, stats, warm, things, thingItems, nearDuplicates };
