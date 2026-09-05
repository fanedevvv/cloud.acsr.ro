'use strict';
// Istoric persistent al procesărilor (index, fețe, slideshow, optimizare, import).
// Tabela job_log e creată în lib/db.js (init()).
const db = require('./db');

async function start(kind) {
  const info = await db.prepare('INSERT INTO job_log (kind, phase, started_at) VALUES (?, ?, ?)')
    .run(String(kind), 'running', new Date().toISOString());
  return info.lastInsertRowid;
}
async function finish(id, phase, detail) {
  if (!id) return;
  await db.prepare('UPDATE job_log SET phase = ?, detail = ?, finished_at = ? WHERE id = ?')
    .run(String(phase || 'done'), detail ? String(detail).slice(0, 300) : null, new Date().toISOString(), id);
}
// La pornire: procesările rămase „running" au fost întrerupte de un restart.
async function sweep() {
  await db.prepare("UPDATE job_log SET phase = 'interrupted', finished_at = ? WHERE phase = 'running'")
    .run(new Date().toISOString());
  // păstrează ultimele 200
  await db.exec('DELETE FROM job_log WHERE id NOT IN (SELECT id FROM (SELECT id FROM job_log ORDER BY id DESC LIMIT 200) t)');
}
async function recent(n = 15) {
  return db.prepare('SELECT kind, phase, detail, started_at AS startedAt, finished_at AS finishedAt FROM job_log ORDER BY id DESC LIMIT ?')
    .all(Math.min(50, n));
}

module.exports = { start, finish, sweep, recent };
