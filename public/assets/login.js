'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const submitBtn = document.getElementById('submitBtn');

const E = {
  'google-off': 'Autentificarea cu Google nu e configurată.',
  'google-cancel': 'Autentificarea Google a fost anulată.',
  'google-fail': 'Autentificarea Google a eșuat, încearcă din nou.',
  state: 'Sesiune expirată, încearcă din nou.',
  session: 'Eroare de sesiune.',
};
const e = new URLSearchParams(location.search).get('e');
if (e && E[e]) { err.textContent = E[e]; err.hidden = false; }

fetch('/api/auth/config').then((r) => r.json()).then((c) => {
  if (c.google) { document.getElementById('googleBtn').hidden = false; document.getElementById('orSep').hidden = false; }
}).catch(() => {});

let awaiting2fa = false;
const twofaBox = document.getElementById('twofaBox');
const twofaCode = document.getElementById('twofaCode');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  try {
    if (awaiting2fa) {
      const res = await fetch('/api/login/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: twofaCode.value.trim() }),
      });
      if (res.ok) { location.href = '/'; return; }
      const data = await res.json().catch(() => ({}));
      err.textContent = data.error || 'Cod greșit';
      err.hidden = false;
      return;
    }
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.need2fa) {
      awaiting2fa = true;
      document.getElementById('username').disabled = true;
      document.getElementById('password').disabled = true;
      document.getElementById('loginHint').hidden = true;
      twofaBox.hidden = false;
      submitBtn.textContent = 'Confirmă';
      twofaCode.focus();
      return;
    }
    if (res.ok) { location.href = '/'; return; }
    err.textContent = data.error || 'Autentificare eșuată';
    err.hidden = false;
  } catch { err.textContent = 'Eroare de rețea'; err.hidden = false; }
  finally { submitBtn.disabled = false; }
});
