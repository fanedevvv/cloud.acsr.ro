'use strict';
// Editor foto simplu, în browser (canvas). Nedistructiv: salvează o copie nouă.
// Expus ca window.openEditor(item, onSaved).
(function () {
  let img = null;          // <img> cu originalul
  let item = null;
  let onSaved = null;
  let st = null;           // starea editării
  let mode = 'adjust';     // adjust | filter | crop
  let cropDrag = null;

  const PRESETS = {
    none:   { label: 'Original', a: {} },
    auto:   { label: 'Auto',     a: { bright: 104, contrast: 108, sat: 106 } },
    vivid:  { label: 'Vivid',    a: { contrast: 112, sat: 138 } },
    bw:     { label: 'Alb-negru', a: { sat: 0, contrast: 112 }, extra: '' },
    sepia:  { label: 'Sepia',    a: { sat: 92 }, extra: 'sepia(65%)' },
    cool:   { label: 'Rece',     a: { warm: -42 } },
    warm:   { label: 'Cald',     a: { warm: 42 } },
  };
  const ASPECTS = [['Liber', 0], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16]];

  function freshState() {
    return { rot: 0, flipH: false, flipV: false, crop: null, aspect: 0,
      adj: { bright: 100, contrast: 100, sat: 100, warm: 0 }, preset: 'none' };
  }

  // ─── DOM ─────────────────────────────────────────────────────────────────
  let root, wrap, canvas, cropBox;
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'editor';
    root.hidden = true;
    root.innerHTML = `
      <div class="ed-bar">
        <button class="ed-btn" data-ed="cancel"><span class="msi">close</span>Anulează</button>
        <span class="ed-title">Editare</span>
        <button class="ed-btn primary" data-ed="save"><span class="msi">check</span>Salvează copia</button>
      </div>
      <div class="ed-stage"><div class="ed-cwrap"><canvas></canvas><div class="ed-crop" hidden>
        <i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i>
      </div></div></div>
      <div class="ed-tabs">
        <button class="ed-tab on" data-tab="adjust"><span class="msi">tune</span>Ajustări</button>
        <button class="ed-tab" data-tab="filter"><span class="msi">auto_awesome</span>Filtre</button>
        <button class="ed-tab" data-tab="crop"><span class="msi">crop_rotate</span>Decupare</button>
      </div>
      <div class="ed-panel" data-panel="adjust">
        ${slider('bright', 'Luminozitate', 50, 150)}
        ${slider('contrast', 'Contrast', 50, 150)}
        ${slider('sat', 'Saturație', 0, 200)}
        ${slider('warm', 'Căldură', -100, 100)}
      </div>
      <div class="ed-panel" data-panel="filter" hidden><div class="ed-filters"></div></div>
      <div class="ed-panel" data-panel="crop" hidden>
        <div class="ed-crop-tools">
          <button class="ed-ic" data-ed="rotL"><span class="msi">rotate_left</span></button>
          <button class="ed-ic" data-ed="rotR"><span class="msi">rotate_right</span></button>
          <button class="ed-ic" data-ed="flipH"><span class="msi">flip</span></button>
          <button class="ed-ic" data-ed="flipV"><span class="msi">flip</span><span class="ed-v">V</span></button>
          <span class="ed-sep"></span>
          <div class="ed-aspects"></div>
        </div>
      </div>`;
    document.body.appendChild(root);
    wrap = root.querySelector('.ed-cwrap');
    canvas = root.querySelector('canvas');
    cropBox = root.querySelector('.ed-crop');

    const fl = root.querySelector('.ed-filters');
    for (const [k, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'ed-filt'; b.dataset.preset = k; b.textContent = p.label;
      b.onclick = () => { applyPreset(k); };
      fl.appendChild(b);
    }
    const asp = root.querySelector('.ed-aspects');
    for (const [lbl, r] of ASPECTS) {
      const b = document.createElement('button');
      b.className = 'ed-asp'; b.dataset.ar = r; b.textContent = lbl;
      b.onclick = () => { st.aspect = r; if (r) fixAspect(); draw(); markAspects(); };
      asp.appendChild(b);
    }

    root.addEventListener('input', (e) => {
      const s = e.target.closest('input[type=range]');
      if (!s) return;
      st.adj[s.dataset.k] = Number(s.value);
      s.nextElementSibling.textContent = s.dataset.k === 'warm' ? st.adj.warm : st.adj[s.dataset.k] + '%';
      st.preset = 'none'; markFilters();
      draw();
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed]'); if (b) return act(b.dataset.ed);
      const t = e.target.closest('.ed-tab'); if (t) return setMode(t.dataset.tab);
    });
    initCropDrag();
  }
  function slider(k, label, min, max) {
    return `<label class="ed-slider"><span>${label}</span>
      <input type="range" data-k="${k}" min="${min}" max="${max}" value="${k === 'warm' ? 0 : 100}">
      <b>${k === 'warm' ? '0' : '100%'}</b></label>`;
  }

  // ─── Randare ─────────────────────────────────────────────────────────────
  function orientedSize() {
    const sw = img.naturalWidth, sh = img.naturalHeight;
    return (st.rot % 180) ? { w: sh, h: sw } : { w: sw, h: sh };
  }
  function filterStr() {
    const a = st.adj;
    let f = `brightness(${a.bright}%) contrast(${a.contrast}%) saturate(${a.sat}%)`;
    const ex = PRESETS[st.preset] && PRESETS[st.preset].extra;
    if (ex) f += ' ' + ex;
    return f;
  }
  function paint(ctx, W, H) {
    // W,H = dimensiunea zonei orientate (înainte de crop)
    ctx.save();
    ctx.filter = filterStr();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(st.rot * Math.PI / 180);
    ctx.scale(st.flipH ? -1 : 1, st.flipV ? -1 : 1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
    if (st.adj.warm) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.min(0.6, Math.abs(st.adj.warm) / 100);
      ctx.fillStyle = st.adj.warm > 0 ? '#ff9b3d' : '#3da5ff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  function draw() {
    if (!img || !img.complete || !img.naturalWidth) return;
    const os = orientedSize();
    const box = root.querySelector('.ed-stage').getBoundingClientRect();
    const maxW = box.width - 32, maxH = box.height - 32;
    const scale = Math.min(maxW / os.w, maxH / os.h, 1);
    const dw = Math.round(os.w * scale), dh = Math.round(os.h * scale);
    wrap.style.width = dw + 'px'; wrap.style.height = dh + 'px';
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);
    ctx.save();
    ctx.scale(dw / os.w, dh / os.h);
    paint(ctx, os.w, os.h);
    ctx.restore();
    drawCropUI(dw, dh);
  }

  // ─── Crop UI ─────────────────────────────────────────────────────────────
  function drawCropUI(dw, dh) {
    const on = mode === 'crop';
    cropBox.hidden = !on || !st.crop;
    if (!on) return;
    if (!st.crop) st.crop = { x: 0, y: 0, w: 1, h: 1 };
    const c = st.crop;
    cropBox.style.left = c.x * dw + 'px';
    cropBox.style.top = c.y * dh + 'px';
    cropBox.style.width = c.w * dw + 'px';
    cropBox.style.height = c.h * dh + 'px';
    cropBox.hidden = false;
  }
  function fixAspect() {
    if (!st.aspect) return;
    if (!st.crop) st.crop = { x: 0, y: 0, w: 1, h: 1 };
    const os = orientedSize();
    // păstrează centrul, potrivește proporția în px orientați
    let w = st.crop.w * os.w, h = st.crop.h * os.h;
    if (w / h > st.aspect) w = h * st.aspect; else h = w / st.aspect;
    const cx = (st.crop.x + st.crop.w / 2) * os.w, cy = (st.crop.y + st.crop.h / 2) * os.h;
    let x = cx - w / 2, y = cy - h / 2;
    x = Math.max(0, Math.min(x, os.w - w)); y = Math.max(0, Math.min(y, os.h - h));
    st.crop = { x: x / os.w, y: y / os.h, w: w / os.w, h: h / os.h };
  }
  function initCropDrag() {
    const onDown = (e) => {
      if (mode !== 'crop') return;
      const h = e.target.dataset && e.target.dataset.h;
      const r = wrap.getBoundingClientRect();
      cropDrag = { h: h || 'move', sx: e.clientX, sy: e.clientY, r, start: { ...(st.crop || { x: 0, y: 0, w: 1, h: 1 }) } };
      if (!st.crop) { st.crop = { x: 0, y: 0, w: 1, h: 1 }; cropDrag.start = { ...st.crop }; }
      e.preventDefault();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    const onMove = (e) => {
      if (!cropDrag) return;
      const { r, start, h } = cropDrag;
      let dx = (e.clientX - cropDrag.sx) / r.width;
      let dy = (e.clientY - cropDrag.sy) / r.height;
      let c = { ...start };
      if (h === 'move') { c.x = clamp(start.x + dx, 0, 1 - start.w); c.y = clamp(start.y + dy, 0, 1 - start.h); }
      else {
        if (h.includes('w')) { c.x = clamp(start.x + dx, 0, start.x + start.w - 0.05); c.w = start.w - (c.x - start.x); }
        if (h.includes('e')) { c.w = clamp(start.w + dx, 0.05, 1 - start.x); }
        if (h.includes('n')) { c.y = clamp(start.y + dy, 0, start.y + start.h - 0.05); c.h = start.h - (c.y - start.y); }
        if (h.includes('s')) { c.h = clamp(start.h + dy, 0.05, 1 - start.y); }
        if (st.aspect) {
          const os = orientedSize();
          let w = c.w * os.w, hh = w / st.aspect;
          c.h = hh / os.h;
          if (c.y + c.h > 1) c.h = 1 - c.y;
        }
      }
      st.crop = c; draw();
    };
    const onUp = () => { cropDrag = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    wrap.addEventListener('pointerdown', onDown);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ─── Acțiuni ─────────────────────────────────────────────────────────────
  function setMode(m) {
    mode = m;
    root.querySelectorAll('.ed-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === m));
    root.querySelectorAll('.ed-panel').forEach((p) => (p.hidden = p.dataset.panel !== m));
    if (m === 'crop' && !st.crop) st.crop = { x: 0.04, y: 0.04, w: 0.92, h: 0.92 };
    draw();
  }
  function markFilters() {
    root.querySelectorAll('.ed-filt').forEach((b) => b.classList.toggle('on', b.dataset.preset === st.preset));
  }
  function markAspects() {
    root.querySelectorAll('.ed-asp').forEach((b) => b.classList.toggle('on', Number(b.dataset.ar) === st.aspect));
  }
  function applyPreset(k) {
    const p = PRESETS[k]; if (!p) return;
    st.adj = { bright: 100, contrast: 100, sat: 100, warm: 0, ...p.a };
    st.preset = k;
    syncSliders(); markFilters(); draw();
  }
  function syncSliders() {
    root.querySelectorAll('input[type=range]').forEach((s) => {
      s.value = st.adj[s.dataset.k];
      s.nextElementSibling.textContent = s.dataset.k === 'warm' ? st.adj.warm : st.adj[s.dataset.k] + '%';
    });
  }
  function act(a) {
    if (a === 'cancel') return close();
    if (a === 'save') return save();
    if (a === 'rotL') { st.rot = (st.rot + 270) % 360; st.crop = null; draw(); }
    if (a === 'rotR') { st.rot = (st.rot + 90) % 360; st.crop = null; draw(); }
    if (a === 'flipH') { st.flipH = !st.flipH; draw(); }
    if (a === 'flipV') { st.flipV = !st.flipV; draw(); }
  }

  // ─── Salvare ─────────────────────────────────────────────────────────────
  function save() {
    const os = orientedSize();
    const c = st.crop || { x: 0, y: 0, w: 1, h: 1 };
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(c.w * os.w));
    out.height = Math.max(1, Math.round(c.h * os.h));
    const ctx = out.getContext('2d');
    ctx.translate(-c.x * os.w, -c.y * os.h);
    paint(ctx, os.w, os.h);
    const nm = (item.originalName || 'poza').replace(/\.[^.]+$/, '') + '-editat.jpg';
    const cb = onSaved;
    root.querySelector('[data-ed=save]').disabled = true;
    out.toBlob((blob) => {
      root.querySelector('[data-ed=save]').disabled = false;
      if (!blob) return;
      const f = new File([blob], nm, { type: 'image/jpeg' });
      close();
      if (cb) cb(f);
    }, 'image/jpeg', 0.92);
  }

  function open(it, cb) {
    build();
    item = it; onSaved = cb; st = freshState(); mode = 'adjust'; img = null;
    root.hidden = false;
    document.body.classList.add('no-scroll');
    setMode('adjust'); markFilters(); markAspects(); syncSliders();
    img = new Image();
    img.onload = () => { draw(); };
    img.onerror = () => { close(); };
    img.src = '/media/' + it.id + '/full';
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove('no-scroll');
    img = null; item = null; onSaved = null;
  }

  window.openEditor = open;
})();
