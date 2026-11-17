/* THP Ghana – builds the consent PDF on the device (works offline, no libraries).
 * The page is drawn on a canvas in the same layout as the printed form, then wrapped
 * as a JPEG inside a one-page A4 PDF.
 * Exposes: window.ConsentPDF.build(record) -> Promise<Blob>, window.ConsentPDF.fileName(record)
 */
(() => {
  'use strict';
  const PW = 595.28, PH = 841.89;          // A4 in PDF points
  const DPI_SCALE = 2.5;                   // canvas px per point (~180 dpi)
  const NAVY = '#32347C', TEAL = '#2FB2A0', INK = '#1d1f3a', GREY = '#555', LINE = '#444', SHADE = '#f1f2f7';
  const SANS = 'Helvetica, Arial, sans-serif', SERIF = 'Georgia, "Times New Roman", serif';

  const loadImg = (src) => new Promise((res) => {
    if (!src) return res(null);
    const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src;
  });

  async function drawPage(r) {
    const k = DPI_SCALE;
    const cv = document.createElement('canvas');
    cv.width = Math.round(PW * k); cv.height = Math.round(PH * k);
    const g = cv.getContext('2d');
    g.scale(k, k);
    g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
    g.textBaseline = 'alphabetic';

    const [logo, sigP, sigG, sigR, photo, groupPh] = await Promise.all([
      loadImg('assets/logo.png'), loadImg(r.participantSignature), loadImg(r.guardianSignature),
      loadImg(r.repSignature), loadImg(r.photo), loadImg(r.groupPhoto),
    ]);

    const font = (size, bold, family = SANS, italic) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
    function text(s, x, y, o = {}) {
      g.font = font(o.size || 9, o.bold, o.family, o.italic); g.fillStyle = o.color || INK;
      g.textAlign = o.align || 'left'; g.fillText(String(s ?? ''), x, y); g.textAlign = 'left';
    }
    // Word-wrap; returns the y of the next line. Supports **bold** segments? Keep simple: whole string one style.
    function wrap(s, x, y, maxW, o = {}) {
      const size = o.size || 9, lh = o.lh || size * 1.28;
      g.font = font(size, o.bold, o.family, o.italic); g.fillStyle = o.color || INK;
      const lines = [];
      String(s ?? '').split('\n').forEach((para) => {
        let line = '';
        para.split(/\s+/).forEach((w) => {
          const t = line ? line + ' ' + w : w;
          if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
        });
        lines.push(line);
      });
      if (!o.measure) lines.forEach((l, i) => g.fillText(l, x, y + i * lh));
      return y + lines.length * lh;
    }
    const wrapHeight = (s, maxW, o = {}) => wrap(s, 0, 0, maxW, { ...o, measure: true });
    function box(x, y, checked, size = 9) {
      g.lineWidth = 1; g.strokeStyle = NAVY; g.strokeRect(x, y, size, size);
      if (checked) {
        g.strokeStyle = TEAL; g.lineWidth = 1.6; g.beginPath();
        g.moveTo(x + size * 0.2, y + size * 0.55); g.lineTo(x + size * 0.42, y + size * 0.78); g.lineTo(x + size * 0.82, y + size * 0.22);
        g.stroke();
      }
    }
    function drawImgFit(img, x, y, w, h) {
      if (!img) return;
      const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      g.drawImage(img, x, y + (h - dh) / 2, dw, dh);
    }

    /* Table row: cells = [{w, label, text, img, yesno, minH}] ; returns new y */
    const PAD = 5;
    function row(x, y, cells, minH = 22) {
      let h = minH;
      cells.forEach((cl) => {
        let ch = 0;
        if (cl.text != null) ch = wrapHeight(cl.text, cl.w - PAD * 2, { size: cl.label ? 8 : 9, bold: cl.bold }) + PAD * 2 - 2;
        if (cl.sub) ch += 10;
        if (cl.img !== undefined) ch = Math.max(ch, cl.imgH || 40) + PAD * 2;
        h = Math.max(h, ch, cl.minH || 0);
      });
      let cx = x;
      cells.forEach((cl) => {
        if (cl.label) { g.fillStyle = SHADE; g.fillRect(cx, y, cl.w, h); }
        g.strokeStyle = LINE; g.lineWidth = 0.8; g.strokeRect(cx, y, cl.w, h);
        if (cl.text != null) wrap(cl.text, cx + PAD, y + PAD + 7, cl.w - PAD * 2, { size: cl.label ? 8 : 9, bold: cl.bold, color: cl.color });
        if (cl.sub) text(cl.sub, cx + PAD, y + PAD + 18, { size: 7, italic: true, color: GREY });
        if (cl.yesno !== undefined) {
          box(cx + PAD, y + PAD, cl.yesno === 'Yes'); text('Yes', cx + PAD + 13, y + PAD + 8, { size: 9 });
          box(cx + PAD + 42, y + PAD, cl.yesno === 'No'); text('No', cx + PAD + 55, y + PAD + 8, { size: 9 });
        }
        if (cl.img !== undefined) {
          if (cl.img) drawImgFit(cl.img, cx + PAD, y + PAD, cl.w - PAD * 2, cl.imgH || 40);
          else if (cl.empty) text(cl.empty, cx + PAD, y + PAD + 8, { size: 8, color: '#999' });
        }
        cx += cl.w;
      });
      return y + h;
    }

    const L = 36, W = PW - 72;
    let y = 30;

    // Header
    if (logo) drawImgFit(logo, L, y, 54, 56);
    text('Informed Consent Form', L + 66, y + 28, { size: 21, bold: true, family: SERIF, color: NAVY });
    text('The Hunger Project Ghana · Release and Consent for photos / video / audio / stories', L + 66, y + 43, { size: 8, color: GREY });
    text('Consent ID', L + W, y + 20, { size: 7.5, color: GREY, align: 'right' });
    text(r.consentId, L + W, y + 33, { size: 10, bold: true, color: NAVY, align: 'right' });
    y += 62;
    g.fillStyle = TEAL; g.fillRect(L, y, W, 3); y += 16;

    y = wrap('The Hunger Project would like your permission to record your photos/video/audio/story, which may be used to fundraise, raise awareness, educate or for programmatic purposes. Please read the statements below and put a checkmark to show that you consent to the following:', L, y, W, { size: 8.6 }) + 4;

    const c = r.consents || {};
    [
      [c.notAffected, 'My involvement with The Hunger Project is not affected by my decision regarding the use of my photo/video/audio/story.'],
      [c.noPayment, 'I will not receive any payment for the use of my image/photo now or in the future.'],
      [c.storageAndUse, 'I understand that my photos, video, interviews, and/or artwork will be stored by The Hunger Project, adhering to data privacy standards, and used in various media platforms for fundraising, awareness, education, or programmatic purposes. No additional consent is required for future uses.'],
      [c.canWithdraw, 'I can withdraw or modify my consent by contacting The Hunger Project office. Changes to consent may apply to future materials only, existing materials cannot be changed.'],
    ].forEach(([on, s]) => { box(L, y - 7.5, on); y = wrap(s, L + 16, y, W - 16, { size: 8.6 }) + 3; });

    y += 6;
    text('Fill out the following section to give The Hunger Project consent to use photos/videos/audio/stories.', L, y, { size: 9, bold: true });
    y += 6;

    const c1 = W * 0.24, c2 = W * 0.26, c3 = W * 0.24, c4 = W - c1 - c2 - c3;
    y = row(L, y, [{ w: c1, label: true, text: 'Full Name:' }, { w: W - c1, text: r.fullName, bold: true }]);
    y = row(L, y, [{ w: c1, label: true, text: 'Community Name:' }, { w: c2, text: r.community },
      { w: c3, label: true, text: "Do you represent your community's consent?" }, { w: c4, yesno: r.representsCommunity }]);
    y = row(L, y, [{ w: c1, label: true, text: 'Contact Information:', sub: '(if available)', minH: 30 }, { w: W - c1, text: r.contact || '' }]);
    y = row(L, y, [{ w: c1, label: true, text: 'Gender Identity:' }, { w: c2, text: r.gender || '' },
      { w: c3, label: true, text: 'Age:' }, { w: c4, text: String(r.age ?? '') }]);
    y = row(L, y, [{ w: c1, label: true, text: 'Would you like us to use a different name?' }, { w: c2, yesno: r.usePreferredName },
      { w: c3, label: true, text: 'If yes, what name would you like us to use?' }, { w: c4, text: r.preferredName || '' }]);
    y = row(L, y, [{ w: c1, label: true, text: 'Signature:' }, { w: c2, img: sigP, imgH: 40, empty: '—' },
      { w: c3, label: true, text: 'Date:' }, { w: c4, text: `${r.consentDate}   ${r.consentTime || ''}` }]);

    // Guardian
    y += 16;
    text('EVERY INDIVIDUAL CHILD (EVEN IN A GROUP) REQUIRES A SIGNED CONSENT FORM', L, y, { size: 9.5, bold: true });
    y += 12;
    text('Permission from Parent or Legal Guardian for child/children under 18:', L, y, { size: 8.6, bold: true, family: SERIF });
    y = wrap('I give consent to have my child/children\'s photos/video/audio/story collected and used by The Hunger Project and affiliated entities.', L, y + 11, W, { size: 8.6 }) + 1;
    const g1 = W * 0.14, g3 = W * 0.12, g5 = W * 0.08, g6 = W * 0.13, g4 = W * 0.24, g2 = W - g1 - g3 - g4 - g5 - g6;
    y = row(L, y, [
      { w: g1, label: true, text: 'Full Name:' },
      { w: g2, text: r.isMinor ? `${r.guardianName}${r.guardianRelationship ? ' (' + r.guardianRelationship + ')' : ''}` : 'Not applicable – participant is 18 or over', color: r.isMinor ? INK : '#999' },
      { w: g3, label: true, text: 'Signature:' }, { w: g4, img: r.isMinor ? sigG : null, imgH: 36 },
      { w: g5, label: true, text: 'Date:' }, { w: g6, text: r.isMinor ? r.consentDate : '' },
    ], 28);

    // THP rep
    y += 16;
    text('THP Representative:', L, y, { size: 10, bold: true, family: SERIF });
    y += 6;
    const r1 = W * 0.14, r3 = W * 0.12, r2 = W * 0.36, r4 = W - r1 - r2 - r3;
    y = row(L, y, [{ w: r1, label: true, text: 'Full Name:' }, { w: r2, text: r.repName },
      { w: r3, label: true, text: 'Signature:' }, { w: r4, img: sigR, imgH: 36 }]);
    y = row(L, y, [{ w: r1, label: true, text: 'Project / activity:' }, { w: W - r1, text: r.project || '' }]);

    // Photos (individual and/or group)
    const photos = [];
    if (photo) photos.push([photo, 'Photo of participant taken at time of consent.']);
    if (groupPh) photos.push([groupPh, `Group photo – session ${r.sessionName || ''} (${r.sessionId || ''}).`]);
    if (photos.length) {
      y += 10;
      const maxH = Math.min(150, PH - 84 - y);
      if (maxH > 40) {
        let px = L;
        photos.forEach(([im, cap]) => {
          const maxW = photos.length > 1 ? (W - 12) / 2 : 160;
          const s2 = Math.min(maxW / im.naturalWidth, (maxH - 14) / im.naturalHeight);
          const w2 = im.naturalWidth * s2, h2 = im.naturalHeight * s2;
          g.drawImage(im, px, y, w2, h2);
          g.strokeStyle = '#ccc'; g.lineWidth = 0.6; g.strokeRect(px, y, w2, h2);
          if (photos.length > 1) wrap(cap, px, y + h2 + 9, maxW, { size: 7, color: GREY });
          else wrap(cap, px + w2 + 10, y + 9, W - w2 - 10, { size: 7.5, color: GREY });
          px += maxW + 12;
        });
      }
    }

    // Audit + footer (pinned to the bottom of the page)
    let fy = PH - 52;
    g.fillStyle = '#ddd'; g.fillRect(L, fy - 9, W, 0.7);
    text(`Signed electronically on device${r.device ? ' "' + r.device + '"' : ''} at ${r.createdAt || ''} · Consent ID ${r.consentId} ${r.sessionId ? ' · Group session ' + r.sessionId : ''} · App v${r.appVersion || ''} · Copy made on device`, L, fy, { size: 6.3, color: '#777' });
    text('110 West 30th Street, 6th Floor, New York, NY 10001   Tel: (212) 251-9100   Web: www.thp.org', PW / 2, fy + 14, { size: 7.5, color: '#333', align: 'center' });
    g.font = font(6, false); g.fillStyle = '#777'; g.textAlign = 'center';
    g.fillText('Ethical Image Protocol (2023) | The Hunger Project   The Hunger Project is a publicly supported organization as described in section 501(c)(3) of the', PW / 2, fy + 24);
    g.fillText('Internal Revenue Code. Our U.S. Tax Identification Number is 94-2443282.', PW / 2, fy + 31);
    g.textAlign = 'left';
    return cv;
  }

  /* Minimal PDF writer: one A4 page showing one JPEG. */
  function pdfFromJpeg(jpegBytes, imgW, imgH, title) {
    const enc = new TextEncoder();
    const parts = []; const offsets = []; let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const safeTitle = String(title || '').replace(/[()\\]/g, '').replace(/[^\x20-\x7E]/g, '');
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
    obj(4, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
      push(jpegBytes); push('\nendstream');
    });
    obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(6, () => push(`<< /Title (${safeTitle}) /Producer (THP Ghana Consent App) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`));
    const xref = len;
    push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`);
    push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  async function build(r) {
    const canvas = await drawPage(r);
    const jpegBlob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
    return pdfFromJpeg(bytes, canvas.width, canvas.height, `THP consent ${r.consentId} - ${r.fullName}`);
  }

  function fileName(r) {
    const clean = (s) => String(s || '').replace(/[\\/:*?"<>|#%]+/g, '').replace(/\s+/g, '-').slice(0, 60);
    return `${r.consentDate}_${clean(r.fullName)}_${clean(r.community)}_${r.consentId.slice(-5)}.pdf`;
  }

  window.ConsentPDF = { build, fileName };
})();
