'use strict';
// Geocodare inversă (OSM Nominatim) cu cache pe celule de ~1 km. Politicos:
// max 1 cerere/sec, User-Agent propriu.
const db = require('./db');
const UA = 'cloud.acsr.ro self-hosted gallery (reverse-geocode backfill)';
const cell = (lat, lon) => Number(lat).toFixed(2) + ',' + Number(lon).toFixed(2);
let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reverse(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = cell(lat, lon);
  const hit = db.prepare('SELECT place, city, country FROM geocache WHERE cell = ?').get(key);
  if (hit) return hit;

  const wait = 1100 - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  last = Date.now();

  let j;
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=jsonv2&zoom=12&accept-language=ro`;
    const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch { return null; }

  const a = j.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.county || j.name || null;
  const country = a.country || null;
  const place = [city, country].filter(Boolean).join(', ') || null;
  const row = { place, city, country };
  db.prepare('INSERT OR REPLACE INTO geocache (cell, place, city, country, at) VALUES (?, ?, ?, ?, ?)')
    .run(key, place, city, country, new Date().toISOString());
  return row;
}

// Completează media.place pentru pozele geotag-uite (fundal, lent).
async function backfillPlaces(limit = 400) {
  const rows = db.prepare(
    'SELECT id, lat, lon FROM media WHERE lat IS NOT NULL AND lon IS NOT NULL AND place_done = 0 AND deleted_at IS NULL LIMIT ?'
  ).all(limit);
  let done = 0;
  for (const r of rows) {
    const g = await reverse(r.lat, r.lon);
    db.prepare('UPDATE media SET place = ?, city = ?, country = ?, place_done = 1 WHERE id = ?')
      .run(g && g.place || null, g && g.city || null, g && g.country || null, r.id);
    if (g && g.place) done++;
  }
  if (rows.length) console.log(`locuri completate: ${done}/${rows.length}`);
}

function placesSummary() {
  return db.prepare(`
    SELECT COALESCE(place, city, country) AS place,
           COUNT(*) n,
           (SELECT id FROM media m2 WHERE COALESCE(m2.place, m2.city, m2.country) = COALESCE(m.place, m.city, m.country)
              AND m2.deleted_at IS NULL AND m2.archived = 0 AND m2.locked = 0 ORDER BY COALESCE(m2.taken_at, m2.created_at) DESC LIMIT 1) AS sampleId
    FROM media m
    WHERE lat IS NOT NULL AND deleted_at IS NULL AND archived = 0 AND locked = 0
      AND COALESCE(place, city, country) IS NOT NULL
    GROUP BY COALESCE(place, city, country)
    ORDER BY n DESC
  `).all();
}

module.exports = { reverse, backfillPlaces, placesSummary };
