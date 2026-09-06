'use strict';
// Scanner de documente: alegi manual cele 4 colțuri, se corectează
// perspectiva (homografie) și, opțional, se aplică un aspect „document".
// window.openScanner(item, onSaved) — onSaved primește un File JPEG.
(function () {
  let root, stage, img, svg;
  let item = null, onSaved = null;
  let pts = [];          // 4 colțuri în px, relativ la overlay
  let drag = null;
  let bw = false;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'scanner';
    root.hidden = true;
    root.innerHTML = `
      <div class="sc-bar">
        <button class="sc-btn" data-sc="cancel"><span class="msi">close</span>Anulează</button>
        <span class="sc-title">Scanează document</span>
        <button class="sc-btn primary" data-sc="save"><span class="msi">check</span>Salvează</button>
      </div>
      <div class="sc-stage" id="scStage">
        <img alt="">
        <svg class="sc-ovl">
          <polygon></polygon>
          <circle data-i="0" r="13"></circle><circle data-i="1" r="13"></circle>
          <circle data-i="2" r="13"></circle><circle data-i="3" r="13"></circle>
        </svg>
      </div>
      <div class="sc-tools">
        <label class="sc-check"><input type="checkbox" data-sc="bw"> Aspect alb-negru (document)</label>
        <button class="sc-btn" data-sc="reset"><span class="msi">crop_free</span>Resetează colțurile</button>
      </div>`;
    document.body.appendChild(root);
    stage = root.querySelector('#scStage');
    img = stage.querySelector('img');
    svg = stage.querySelector('svg');

    const pos = (e) => {
      const r = svg.getBoundingClientRect();
      return { x: clamp(e.clientX - r.left, 0, r.width), y: clamp(e.clientY - r.top, 0, r.height) };
    };
    svg.addEventListener('pointerdown', (e) => {
      const c = e.target.closest('circle');
      if (!c) return;
      drag = Number(c.dataset.i);
      try { svg.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      pts[drag] = pos(e);
      paintOverlay();
    });
    svg.addEventListener('pointerup', () => { drag = null; });

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sc]'); if (!b) return;
      const k = b.dataset.sc;
      if (k === 'cancel') close();
      else if (k === 'save') save();
      else if (k === 'reset') { resetPts(); paintOverlay(); }
    });
    root.querySelector('[data-sc=bw]').addEventListener('change', (e) => { bw = e.target.checked; });
    window.addEventListener('resize', () => { if (!root.hidden) { fitStage(); resetPts(); paintOverlay(); } });
  }

  function ovlSize() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 300, h: r.height || 300 };
  }
  function fitStage() {
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    svg.style.left = (r.left - s.left) + 'px';
    svg.style.top = (r.top - s.top) + 'px';
    svg.style.width = r.width + 'px';
    svg.style.height = r.height + 'px';
  }
  function resetPts() {
    const { w, h } = ovlSize();
    const mx = w * 0.12, my = h * 0.12;
    pts = [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }
  function paintOverlay() {
    svg.querySelector('polygon').setAttribute('points', pts.map((p) => p.x + ',' + p.y).join(' '));
    [...svg.querySelectorAll('circle')].forEach((c, i) => {
      c.setAttribute('cx', pts[i].x); c.setAttribute('cy', pts[i].y);
    });
  }

  // Homografie din 4 corespondențe (8 necunoscute) prin eliminare gaussiană.
  function solveH(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const s = src[i], d = dst[i];
      A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]); b.push(d.x);
      A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]); b.push(d.y);
    }
    const h = gauss(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  function gauss(A, b) {
    const n = 8;
    const M = A.map((r, i) => r.concat(b[i]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      const t = M[col]; M[col] = M[piv]; M[piv] = t;
      const d = M[col][col] || 1e-9;
      for (let c = col; c <= n; c++) M[col][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((r) => r[n]);
  }
  function applyH(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
  }

  function documentLook(d) {
    const n = d.length / 4;
    const g = new Float32Array(n);
    let mn = 255, mx = 0;
    for (let i = 0; i < n; i++) {
      const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      g[i] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const range = Math.max(1, mx - mn);
    for (let i = 0; i < n; i++) {
      let v = (g[i] - mn) / range * 255;
      v = 255 * Math.pow(v / 255, 0.8);
      v = clamp((v - 128) * 1.35 + 140, 0, 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
  }

  function save() {
    const { w: ow, h: oh } = ovlSize();
    const sx = img.naturalWidth / ow, sy = img.naturalHeight / oh;
    const srcPts = pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let OW = Math.round(Math.max(dist(srcPts[0], srcPts[1]), dist(srcPts[3], srcPts[2])));
    let OH = Math.round(Math.max(dist(srcPts[0], srcPts[3]), dist(srcPts[1], srcPts[2])));
    const cap = 2000;
    if (Math.max(OW, OH) > cap) { const k = cap / Math.max(OW, OH); OW = Math.round(OW * k); OH = Math.round(OH * k); }
    OW = Math.max(16, OW); OH = Math.max(16, OH);
    const dstPts = [{ x: 0, y: 0 }, { x: OW, y: 0 }, { x: OW, y: OH }, { x: 0, y: OH }];
    const H = solveH(dstPts, srcPts); // dst -> src (mapare inversă)

    const sc = document.createElement('canvas');
    sc.width = img.naturalWidth; sc.height = img.naturalHeight;
    sc.getContext('2d').drawImage(img, 0, 0);
    let sdata;
    try { sdata = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data; }
    catch { return; }

    const out = document.createElement('canvas');
    out.width = OW; out.height = OH;
    const octx = out.getContext('2d');
    const odata = octx.createImageData(OW, OH);
    const od = odata.data, SW = sc.width, SH = sc.height;
    for (let y = 0; y < OH; y++) {
      for (let x = 0; x < OW; x++) {
        const p = applyH(H, x + 0.5, y + 0.5);
        const ux = p[0], uy = p[1];
        const oi = (y * OW + x) * 4;
        if (ux < 0 || uy < 0 || ux >= SW - 1 || uy >= SH - 1) {
          od[oi] = od[oi + 1] = od[oi + 2] = 255; od[oi + 3] = 255; continue;
        }
        const x0 = ux | 0, y0 = uy | 0, fx = ux - x0, fy = uy - y0;
        const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          const top = sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx;
          const bot = sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx;
          od[oi + c] = top * (1 - fy) + bot * fy;
        }
        od[oi + 3] = 255;
      }
    }
    if (bw) documentLook(od);
    octx.putImageData(odata, 0, 0);

    const nm = (item.originalName || 'document').replace(/\.[^.]+$/, '') + '-scan.jpg';
    const cb = onSaved;
    const btn = root.querySelector('[data-sc=save]');
    btn.disabled = true;
    out.toBlob((blob) => {
      btn.disabled = false;
      if (!blob) return;
      close();
      if (cb) cb(new File([blob], nm, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }

  function open(it, cb) {
    build();
    item = it; onSaved = cb; bw = false; drag = null;
    root.querySelector('[data-sc=bw]').checked = false;
    root.hidden = false;
    document.body.classList.add('no-scroll');
    img.onload = () => { fitStage(); resetPts(); paintOverlay(); };
    img.onerror = () => close();
    img.src = '/media/' + it.id + '/full';
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove('no-scroll');
    item = null; onSaved = null;
  }
  window.openScanner = open;
})();
