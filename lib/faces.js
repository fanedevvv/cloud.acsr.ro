'use strict';
// Client pentru faces-worker.js. Detecția rulează în proces separat.
const path = require('path');
const { fork } = require('child_process');
const joblog = require('./joblog');

let worker = null, seq = 0, job = null;
const pending = new Map();

function spawn() {
  worker = fork(path.join(__dirname, 'faces-worker.js'), [], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  worker.on('message', (m) => {
    if (m.ev === 'ready') return;
    if ((m.ev === 'progress' || m.ev === 'done') && job && m.id === job.id) {
      Object.assign(job, { phase: m.phase, total: m.total, done: m.done, faces: m.faces, people: m.people });
      if (m.ev === 'done') { job.finishedAt = new Date().toISOString(); joblog.finish(job._log, 'done', job.faces + ' fețe, ' + job.people + ' persoane'); }
      return;
    }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'eroare')); }
  });
  worker.on('exit', (code) => {
    worker = null;
    for (const p of pending.values()) p.reject(new Error('worker oprit'));
    pending.clear();
    if (job && !job.finishedAt) { job.phase = 'error'; job.error = 'worker oprit (' + code + ')'; joblog.finish(job._log, 'error', job.error); }
  });
}
const ensure = () => { if (!worker) spawn(); return worker; };

let jseq = 0;
function newJob() { job = { id: 'face' + (++jseq), phase: 'starting', total: 0, done: 0, faces: 0, people: 0, startedAt: new Date().toISOString() }; job._log = joblog.start('Găsire persoane'); return job; }
const getJob = (id) => (job && String(job.id) === String(id) ? job : null);
const current = () => job;
function runIndex(j) { ensure(); worker.send({ id: j.id, op: 'index' }); return Promise.resolve(); }
function warm() {
  ensure();
  const id = ++seq;
  const to = setTimeout(() => pending.delete(id), 180000);
  pending.set(id, { resolve: () => clearTimeout(to), reject: () => clearTimeout(to) });
  worker.send({ id, op: 'ping' });
}

module.exports = { newJob, getJob, current, runIndex, warm };
