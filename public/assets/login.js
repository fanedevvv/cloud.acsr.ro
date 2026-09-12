'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const submitBtn = document.getElementById('submitBtn');
const userField = document.getElementById('username');
const passField = document.getElementById('password');
const totpField = document.getElementById('totpCode');

let awaitingTotp = false;

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  try {
    let res, data;
    if (awaitingTotp) {
      res = await fetch('/api/login/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpField.value.trim() }),
      });
    } else {
      res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: userField.value.trim(), password: passField.value }),
      });
    }
    data = await res.json().catch(() => ({}));
    if (res.ok && data.need2fa) {
      awaitingTotp = true;
      userField.hidden = true; passField.hidden = true;
      totpField.hidden = false; totpField.required = true; totpField.focus();
      submitBtn.textContent = 'Confirmă';
      return;
    }
    if (res.ok) { location.href = '/'; return; }
    err.textContent = data.error || 'Autentificare eșuată';
    err.hidden = false;
    if (awaitingTotp) { totpField.value = ''; totpField.focus(); }
  } catch { err.textContent = 'Eroare de rețea'; err.hidden = false; }
  finally { submitBtn.disabled = false; }
});
