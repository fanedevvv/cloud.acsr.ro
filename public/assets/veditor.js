'use strict';
// Editor video simplu: tăiere (in/out), mut, rotire; + „cadru -> poză".
// window.openVideoEditor(item, onSaved)
(function () {
  let root, video, item, onSaved, timer;
  let dur = 0, inT = 0, outT = 0, rot = 0, mute = false, drag = null;

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'editor veditor';
    root.hidden = true;
    root.innerHTML = `
      <div class="ed-bar">
        <button class="ed-btn" data-ve="cancel"><span class="msi">close</span>Anulează</button>
        <span class="ed-title">Editare video</span>
        <button class="ed-btn primary" data-ve="save"><span class="msi">check</span>Salvează copia</button>
      </div>
      <div class="ed-stage"><video id="veVid" playsinline></video></div>
      <div class="ve-tl">
        <div class="ve-track" id="veTrack">
          <div class="ve-range" id="veRange"></div>
          <div class="ve-handle" data-h="in" id="veIn"></div>
          <div class="ve-handle" data-h="out" id="veOut"></div>
          <div class="ve-play" id="vePlay"></div>
        </div>
        <div class="ve-times"><span id="veInT">0:00</span><span id="veDurT">0:00</span><span id="veOutT">0:00</span></div>
      </div>
      <div class="ed-panel">
        <div class="ed-crop-tools">
          <button class="ed-ic" data-ve="rotL" title="Rotește stânga"><span class="msi">rotate_left</span></button>
          <button class="ed-ic" data-ve="rotR" title="Rotește dreapta"><span class="msi">rotate_right</span></button>
          <button class="ed-ic" data-ve="mute" id="veMute" title="Sunet"><span class="msi">volume_up</span></button>
          <span class="ed-sep"></span>
          <button class="ed-btn" data-ve="frame"><span class="msi">photo_camera</span>Cadru → poză</button>
          <button class="ed-btn" data-ve="playpause"><span class="msi">play_arrow</span>Redă intervalul</button>
        </div>
        <div id="veProg" class="import-prog" hidden><div class="bar"><div id="veBar" class="fill"></div></div><div id="veStat" class="muted"></div></div>
      </div>`;
    document.body.appendChild(root);
    video = root.querySelector('#veVid');

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ve]'); if (!b) return;
      act(b.dataset.ve);
    });
    video.addEventListener('loadedmetadata', () => {
      dur = video.duration || 0; inT = 0; outT = dur;
      layout(); paintTimes();
    });
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime;
      if (t >= outT) { video.pause(); video.currentTime = inT; }
      const track = root.querySelector('#veTrack').getBoundingClientRect();
      root.querySelector('#vePlay').style.left = (dur ? (t / dur) * 100 : 0) + '%';
    });
    initDrag();
  }

  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function paintTimes() {
    root.querySelector('#veInT').textContent = fmt(inT);
    root.querySelector('#veOutT').textContent = fmt(outT);
    root.querySelector('#veDurT').textContent = fmt(outT - inT);
  }
  function layout() {
    const p = (t) => (dur ? (t / dur) * 100 : 0);
    root.querySelector('#veIn').style.left = p(inT) + '%';
    root.querySelector('#veOut').style.left = p(outT) + '%';
    const r = root.querySelector('#veRange');
    r.style.left = p(inT) + '%';
    r.style.width = (p(outT) - p(inT)) + '%';
    video.style.transform = rot ? 'rotate(' + rot + 'deg)' : '';
  }
  function initDrag() {
    const track = root.querySelector('#veTrack');
    const at = (clientX) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
    };
    track.addEventListener('pointerdown', (e) => {
      const h = e.target.dataset && e.target.dataset.h;
      if (h) { drag = h; }
      else { video.currentTime = Math.max(inT, Math.min(outT, at(e.clientX))); return; }
      track.setPointerCapture(e.pointerId);
    });
    track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const t = at(e.clientX);
      if (drag === 'in') inT = Math.min(t, outT - 0.2);
      else outT = Math.max(t, inT + 0.2);
      layout(); paintTimes();
      video.currentTime = drag === 'in' ? inT : outT;
    });
    const up = (e) => { drag = null; try { track.releasePointerCapture(e.pointerId); } catch {} };
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  }

  async function act(a) {
    if (a === 'cancel') return close();
    if (a === 'rotL') { rot = (rot - 90) % 360; layout(); return; }
    if (a === 'rotR') { rot = (rot + 90) % 360; layout(); return; }
    if (a === 'mute') {
      mute = !mute; video.muted = mute;
      root.querySelector('#veMute .msi').textContent = mute ? 'volume_off' : 'volume_up';
      root.querySelector('#veMute').classList.toggle('on', mute);
      return;
    }
    if (a === 'playpause') {
      if (video.paused) { video.currentTime = Math.max(inT, video.currentTime); video.play(); }
      else video.pause();
      return;
    }
    if (a === 'frame') {
      const t = video.currentTime;
      try {
        root.querySelector('#veStat').textContent = 'Se salvează cadrul…';
        root.querySelector('#veProg').hidden = false;
        await window.__api('/api/media/' + item.id + '/frame', { method: 'POST', body: { t } });
        root.querySelector('#veStat').textContent = 'Cadru salvat ca poză.';
        if (onSaved) onSaved();
      } catch (e) { root.querySelector('#veStat').textContent = e.message || 'eroare'; }
      return;
    }
    if (a === 'save') return save();
  }

  async function save() {
    const norm = ((rot % 360) + 360) % 360;
    const payload = { start: Math.round(inT * 100) / 100, end: Math.round(outT * 100) / 100, mute, rotate: norm === 270 ? -90 : norm };
    if (payload.start <= 0.05 && payload.end >= dur - 0.05 && !mute && !norm) { close(); return; }
    root.querySelector('[data-ve=save]').disabled = true;
    root.querySelector('#veProg').hidden = false;
    root.querySelector('#veBar').style.width = '15%';
    root.querySelector('#veStat').textContent = 'Se procesează cu ffmpeg…';
    let jobId;
    try {
      const d = await window.__api('/api/media/' + item.id + '/video-edit', { method: 'POST', body: payload });
      jobId = d.jobId;
    } catch (e) { root.querySelector('#veStat').textContent = e.message; root.querySelector('[data-ve=save]').disabled = false; return; }
    clearInterval(timer);
    timer = setInterval(async () => {
      let j;
      try { j = await window.__api('/api/video-edit/status/' + jobId); } catch { return; }
      root.querySelector('#veBar').style.width = (j.phase === 'done' ? 100 : j.phase === 'processing' ? 60 : 25) + '%';
      root.querySelector('#veStat').textContent = { starting: 'Se pregătește…', processing: 'Se codează…', done: 'Gata', error: 'Eroare' }[j.phase] || j.phase;
      if (j.phase === 'done' || j.phase === 'error') {
        clearInterval(timer);
        root.querySelector('[data-ve=save]').disabled = false;
        if (j.phase === 'done') { if (onSaved) onSaved(); close(); }
        else root.querySelector('#veStat').textContent = 'Eroare: ' + (j.error || '');
      }
    }, 1500);
  }

  function open(it, cb) {
    build();
    item = it; onSaved = cb; rot = 0; mute = false; inT = 0; outT = 0;
    root.querySelector('[data-ve=save]').disabled = false;
    root.querySelector('#veProg').hidden = true;
    root.querySelector('#veBar').style.width = '0%';
    root.querySelector('#veMute .msi').textContent = 'volume_up';
    root.querySelector('#veMute').classList.remove('on');
    video.muted = false;
    video.src = '/media/' + it.id + '/full';
    root.hidden = false;
    document.body.classList.add('no-scroll');
  }
  function close() {
    clearInterval(timer);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
    root.hidden = true;
    document.body.classList.remove('no-scroll');
    item = null; onSaved = null;
  }

  window.openVideoEditor = open;
})();
