'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (res.ok) { location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Autentificare eșuată';
    err.hidden = false;
  } catch {
    err.textContent = 'Eroare de rețea';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
