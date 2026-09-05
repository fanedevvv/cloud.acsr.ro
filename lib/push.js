'use strict';
// Notificări push în browser (Web Push / VAPID). Abonamentele sunt legate
// de un cont (user_id) sau anonime (user_id NULL — vizitatori care doar
// urmăresc un share, dacă vrem asta pe viitor; momentan folosim doar per-cont).
const webpush = require('web-push');
const crypto = require('crypto');
const db = require('./db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const ENABLED = !!(PUBLIC_KEY && PRIVATE_KEY);

if (ENABLED) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

async function subscribe(userId, sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('abonament invalid');
  const existing = await db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint);
  if (existing) {
    await db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?')
      .run(userId || null, sub.keys.p256dh, sub.keys.auth, existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId || null, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
  return id;
}

async function unsubscribe(endpoint) {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

async function sendToUser(userId, payload) {
  if (!ENABLED || !userId) return;
  const rows = await db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  await sendToRows(rows, payload);
}

async function sendToRows(rows, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id).catch(() => {});
      }
    }
  }));
}

module.exports = { subscribe, unsubscribe, sendToUser, enabled: ENABLED, publicKey: PUBLIC_KEY };
