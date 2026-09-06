'use strict';
// Generator PDF minimal, fără dependențe: o pagină A4 per poză, imagine
// JPEG încorporată direct (filtru DCTDecode). Pozele non-JPEG se
// transcodează în JPEG cu sharp înainte de încorporare.
const sharp = require('sharp');

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 28;
const n2 = (x) => (Math.round(x * 100) / 100).toString();

async function toJpeg(buf) {
  const base = sharp(buf, { failOn: 'none', limitInputPixels: 2_000_000_000 }).rotate();
  const meta = await base.metadata();
  let p = sharp(buf, { failOn: 'none', limitInputPixels: 2_000_000_000 }).rotate();
  const maxEdge = 1800;
  if (Math.max(meta.width || 0, meta.height || 0) > maxEdge) p = p.resize(maxEdge, maxEdge, { fit: 'inside' });
  const out = await p.jpeg({ quality: 82 }).toBuffer();
  const m2 = await sharp(out).metadata();
  return { buf: out, w: m2.width, h: m2.height };
}

// items: [{ buf, caption? }]
async function buildPdf(items) {
  const pics = [];
  for (const it of items) {
    try {
      const jp = await toJpeg(it.buf);
      jp.caption = (it.caption || '').toString();
      pics.push(jp);
    } catch { /* sări peste ce nu se poate citi */ }
  }
  if (!pics.length) throw new Error('nicio imagine validă');

  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };

  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];

  for (const jp of pics) {
    const capH = jp.caption ? 22 : 0;
    const availW = A4.w - MARGIN * 2;
    const availH = A4.h - MARGIN * 2 - capH;
    const scale = Math.min(availW / jp.w, availH / jp.h);
    const dw = jp.w * scale, dh = jp.h * scale;
    const x = (A4.w - dw) / 2;
    const y = (A4.h - dh) / 2 + capH / 2;

    const imgId = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${jp.w} /Height ${jp.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jp.buf.length} >>\nstream\n`, 'binary'),
      jp.buf,
      Buffer.from('\nendstream', 'binary'),
    ]));

    let content = `q\n${n2(dw)} 0 0 ${n2(dh)} ${n2(x)} ${n2(y)} cm\n/Im0 Do\nQ\n`;
    if (jp.caption) {
      const cap = jp.caption.replace(/[\\()\r\n]/g, (c) => (c === '\r' || c === '\n' ? ' ' : '\\' + c)).slice(0, 160);
      content += `BT /F1 10 Tf ${n2(MARGIN)} ${n2(MARGIN)} Td (${cap}) Tj ET\n`;
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n2(A4.w)} ${n2(A4.h)}] `
      + `/Resources << /XObject << /Im0 ${imgId} 0 R >> /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(pageId);
  }

  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] >>`;

  const chunks = [];
  let pos = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'binary'); chunks.push(buf); pos += buf.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets[i] = pos;
    push(`${i + 1} 0 obj\n`);
    push(objs[i]);
    push('\nendobj\n');
  }
  const xrefPos = pos;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (let i = 0; i < objs.length; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);
  return Buffer.concat(chunks);
}

module.exports = { buildPdf };
