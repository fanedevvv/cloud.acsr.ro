'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const uEl = document.getElementById('username');
const nEl = document.getElementById('displayName');
const pEl = document.getElementById('password');
const submitBtn = document.getElementById('submitBtn');
const tabLogin = document.getElementById('tabLogin');
const tabReg = document.getElementById('tabReg');
const adminHint = document.getElementById('adminHint');
let mode = 'login';

function setMode(m) {
  mode = m;
  tabLogin.classList.toggle('on', m === 'login');
  tabReg.classList.toggle('on', m === 'reg');
  nEl.hidden = m !== 'reg';
  adminHint.hidden = m !== 'login';
  submitBtn.textContent = m === 'reg' ? 'Creează contul' : 'Intră';
  pEl.setAttribute('autocomplete', m === 'reg' ? 'new-password' : 'current-password');
  uEl.required = m === 'reg';
  err.hidden = true;
}
tabLogin.onclick = () => setMode('login');
tabReg.onclick = () => setMode('reg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  const url = mode === 'reg' ? '/api/register' : '/api/login';
  const body = mode === 'reg'
    ? { username: uEl.value.trim(), password: pEl.value, displayName: nEl.value.trim() }
    : { username: uEl.value.trim(), password: pEl.value };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) { location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'A eșuat';
    err.hidden = false;
  } catch {
    err.textContent = 'Eroare de rețea';
    err.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});
