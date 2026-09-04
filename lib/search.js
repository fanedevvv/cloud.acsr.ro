'use strict';
// Client pentru worker-ul ML (lib/ml-worker.js). Serverul principal NU încarcă
// onnxruntime — doar relează cererile și face rankingul cosinus (JS pur).
const path = require('path');
const { fork } = require('child_process');
const db = require('./db');

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
    if (job && !job.finishedAt) { job.phase = 'error'; job.error = 'worker oprit (cod ' + code + ')'; }
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
function newJob() { job = { id: 'idx' + (++jseq), phase: 'starting', total: 0, done: 0, embedded: 0, ocred: 0, startedAt: new Date().toISOString() }; return job; }
const getJob = (id) => (job && String(job.id) === String(id) ? job : null);
const current = () => job;

function runIndex(j, { ocr }) {
  ensure();
  worker.send({ id: j.id, op: 'index', ocr: !!ocr });
  return Promise.resolve();
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
    WHERE m.deleted_at IS NULL AND m.archived = 0 AND m.locked = 0
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

function stats() {
  const embed = db.prepare('SELECT COUNT(*) n FROM media_embed').get().n;
  const ocr = db.prepare('SELECT COUNT(*) n FROM media WHERE ocr_done = 1').get().n;
  const total = db.prepare('SELECT COUNT(*) n FROM media WHERE deleted_at IS NULL').get().n;
  return { embed, ocr, total };
}

module.exports = { newJob, getJob, current, runIndex, search, stats };
