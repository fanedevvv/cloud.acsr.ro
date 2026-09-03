'use strict';
// Setează parola contului de administrator (username fix: „admin").
// Utilizare:  npm run set-admin -- PAROLA
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const pw = process.argv[2];
if (!pw || pw.length < 6) {
  console.error('Utilizare:  npm run set-admin -- <parola>   (minim 6 caractere)');
  process.exit(1);
}
const envPath = path.join(__dirname, '..', '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const line = 'ADMIN_PASSWORD_HASH=' + bcrypt.hashSync(pw, 12);
env = /^ADMIN_PASSWORD_HASH=.*$/m.test(env)
  ? env.replace(/^ADMIN_PASSWORD_HASH=.*$/m, line)
  : (env && !env.endsWith('\n') ? env + '\n' : env) + line + '\n';
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log('OK — parola de admin setată. Repornește:  pm2 restart cloud-acsr');
