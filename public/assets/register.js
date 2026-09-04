'use strict';
const form = document.getElementById('regForm');
const err = document.getElementById('err');
const submitBtn = document.getElementById('submitBtn');

fetch('/api/auth/config').then((r) => r.json()).then((c) => {
  if (c.google) { document.getElementById('googleBtn').hidden = false; document.getElementById('orSep').hidden = false; }
}).catch(() => {});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        displayName: document.getElementById('displayName').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    if (res.ok) { location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Nu s-a putut crea contul';
    err.hidden = false;
  } catch { err.textContent = 'Eroare de rețea'; err.hidden = false; }
  finally { submitBtn.disabled = false; }
});
