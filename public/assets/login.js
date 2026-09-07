'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    if (res.ok) { location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Autentificare eșuată';
    err.hidden = false;
  } catch { err.textContent = 'Eroare de rețea'; err.hidden = false; }
  finally { submitBtn.disabled = false; }
});
