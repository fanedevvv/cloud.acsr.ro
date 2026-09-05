'use strict';
// TOTP (RFC 6238) + HOTP (RFC 4226) minimale, fără dependințe externe —
// compatibile cu Google Authenticator / Authy / orice app standard.
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomBase32Secret(len = 20) {
  return base32Encode(crypto.randomBytes(len));
}

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  const rem = bits.length % 5;
  if (rem) out += B32_ALPHABET[parseInt(bits.slice(bits.length - rem).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(str) {
  str = String(str || '').replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of str) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 |
    (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}

// Acceptă coduri din fereastra ±1 pas (30s) pentru toleranță la desincronizare de ceas.
function verifyTotp(secretBase32, token, { step = 30, window = 1 } = {}) {
  token = String(token || '').trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const secretBuf = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let e = -window; e <= window; e++) {
    if (hotp(secretBuf, counter + e) === token) return true;
  }
  return false;
}

function otpauthURL({ secret, label, issuer = 'Cloud' }) {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}

function genBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(crypto.randomBytes(5).toString('hex'));
  return codes;
}

module.exports = { randomBase32Secret, verifyTotp, otpauthURL, genBackupCodes };
