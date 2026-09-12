'use strict';
// TOTP (RFC 6238) minimal, fără dependințe externe — compatibil Google
// Authenticator / Authy / orice aplicație standard.
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += B32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(str) {
  str = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of str) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretB32, counter, digits = 6) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

// Acceptă codul dacă se potrivește în fereastra curentă ± un pas (30s înainte/după),
// ca să tolereze ceasuri ușor decalate între telefon și server.
function verifyTotp(secretB32, token, step = 30, window = 1) {
  token = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let e = -window; e <= window; e++) {
    if (hotp(secretB32, counter + e) === token) return true;
  }
  return false;
}

function otpauthUrl(secretB32, accountLabel, issuer) {
  const l = encodeURIComponent(issuer + ':' + accountLabel);
  return `otpauth://totp/${l}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function generateBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').slice(0, 8));
  }
  return codes;
}

module.exports = { generateSecret, verifyTotp, otpauthUrl, generateBackupCodes };
