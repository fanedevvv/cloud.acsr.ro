'use strict';
// Setează parola de acces: scrie hash-ul bcrypt + un SESSION_SECRET în .env
// Utilizare:  npm run set-password -- PAROLA_TA
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw || pw.length < 6) {
  console.error('Utilizare:  npm run set-password -- <parola>   (minim 6 caractere)');
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

function setKey(src, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(src)) return src.replace(re, line);
  return (src && !src.endsWith('\n') ? src + '\n' : src) + line + '\n';
}

const hash = bcrypt.hashSync(pw, 12);
env = setKey(env, 'PASSWORD_HASH', hash);
if (!/^SESSION_SECRET=.+$/m.test(env)) {
  env = setKey(env, 'SESSION_SECRET', crypto.randomBytes(48).toString('hex'));
}
if (!/^PORT=/m.test(env)) env = setKey(env, 'PORT', '4300');
if (!/^COOKIE_SECURE=/m.test(env)) env = setKey(env, 'COOKIE_SECURE', 'false');
if (!/^MAX_UPLOAD_MB=/m.test(env)) env = setKey(env, 'MAX_UPLOAD_MB', '2048');

fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log('OK — am scris .env (hash parolă + secret sesiune).');
console.log('Pornește serverul cu:  npm start');
