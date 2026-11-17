/* THP Ghana – offline consent form  (v1.1)
 * - Forms are saved on the device (IndexedDB) and uploaded to the Google Apps Script
 *   backend when there is internet. The backend creates the Drive PDF and logs it in Google Sheets.
 * - A PDF copy is also generated on the device (pdf.js) and kept in the app / downloaded.
 * - An unfinished form is autosaved, so a refresh or app restart returns to the same step.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const form = $('#consentForm');
  const APP_VERSION = '1.2.0';

  /* ---------------- settings ---------------- */
  const SETTINGS_KEY = 'thp-settings';
  const settings = Object.assign(
    { url: '', key: '', device: '', rep: '', project: '', autoDownload: true, repSig: null },
    JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
  );
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const remembered = (k) => JSON.parse(localStorage.getItem('thp-list-' + k) || '[]');
  const remember = (k, v) => {
    if (!v) return;
    const list = remembered(k).filter((x) => x.toLowerCase() !== v.toLowerCase());
    list.unshift(v);
    localStorage.setItem('thp-list-' + k, JSON.stringify(list.slice(0, 30)));
  };
  const fillDatalist = (id, k) => {
    $(id).innerHTML = remembered(k).map((v) => `<option value="${esc(v)}">`).join('');
  };

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  function newConsentId() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const rnd = new Uint8Array(5); crypto.getRandomValues(rnd);
    return `THP-${todayISO().replace(/-/g, '')}-${Array.from(rnd, (b) => abc[b % abc.length]).join('')}`;
  }
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  /* ---------------- IndexedDB ---------------- */
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('thp-consent', 3);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('forms')) db.createObjectStore('forms', { keyPath: 'consentId' });
          if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs', { keyPath: 'consentId' });
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'sessionId' });
        };
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    },
    put: (rec) => DB.tx('forms', 'readwrite', (s) => s.put(rec)),
    all: () => DB.tx('forms', 'readonly', (s) => s.getAll()),
    del: (id) => DB.tx('forms', 'readwrite', (s) => s.delete(id)),
    putPdf: (rec) => DB.tx('pdfs', 'readwrite', (s) => s.put(rec)),
    allPdfs: () => DB.tx('pdfs', 'readonly', (s) => s.getAll()),
    getPdf: (id) => DB.tx('pdfs', 'readonly', (s) => s.get(id)),
    delPdf: (id) => DB.tx('pdfs', 'readwrite', (s) => s.delete(id)),
    putSession: (rec) => DB.tx('sessions', 'readwrite', (s) => s.put(rec)),
    allSessions: () => DB.tx('sessions', 'readonly', (s) => s.getAll()),
    getSession: (id) => DB.tx('sessions', 'readonly', (s) => s.get(id)),
  };
  // Ask the browser not to clear our storage when space is low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- signature pad ----------------
   * Strokes are stored in the coordinate box of the surface they were drawn on ({w,h} in CSS px),
   * and drawn "contain"-fitted onto any canvas, so a full-screen signature shows correctly inline. */
  class SigPad {
    constructor(host, opts = {}) {
      this.host = host;
      this.box = null;
      this.strokes = [];
      this.fitInk = false; // true = show strokes cropped to the ink (after full-screen signing)
      this.onChange = opts.onChange || (() => {});
      host.innerHTML = '<canvas></canvas><div class="baseline"></div><span class="x">✕</span>' +
        '<div class="placeholder">Sign here</div>' +
        (opts.inline !== false
          ? '<button type="button" class="clear">Clear</button>' +
            '<button type="button" class="expand"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>Full screen</button>'
          : '');
      this.canvas = $('canvas', host);
      this.ctx = this.canvas.getContext('2d');
      $('.clear', host)?.addEventListener('click', () => this.clear());
      $('.expand', host)?.addEventListener('click', () => opts.onExpand && opts.onExpand(this));
      let cur = null;
      const pt = (e) => {
        const r = this.canvas.getBoundingClientRect();
        const f = this.fit(r.width, r.height);
        return [(e.clientX - r.left - f.ox) / f.s, (e.clientY - r.top - f.oy) / f.s];
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* not all pointers can be captured */ }
        const r0 = this.canvas.getBoundingClientRect();
        if (!r0.width || !r0.height) return; // not laid out yet
        if (this.isEmpty()) { this.box = { w: r0.width, h: r0.height }; this.fitInk = false; }
        else if (this.fitInk) {
          // Freeze the current view so new strokes line up with the existing ones.
          const f = this.fit(r0.width, r0.height);
          this.strokes = this.strokes.map((st) => st.map((p) => [f.ox + p[0] * f.s, f.oy + p[1] * f.s]));
          this.box = { w: r0.width, h: r0.height }; this.fitInk = false;
        }
        cur = [pt(e)]; this.strokes.push(cur); this.redraw(); this.changed(false);
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!cur) return; e.preventDefault();
        const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        (co.length ? co : [e]).forEach((ev) => cur.push(pt(ev)));
        this.redraw();
      });
      const end = () => { if (cur) { cur = null; this.changed(true); } };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
    }
    inkBounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      this.strokes.forEach((st) => st.forEach((p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }));
      const pad = Math.max(12, 0.1 * Math.max(x1 - x0, y1 - y0));
      return { x: x0 - pad, y: y0 - pad, w: Math.max(1, x1 - x0 + pad * 2), h: Math.max(1, y1 - y0 + pad * 2) };
    }
    fit(W, H, ink = this.fitInk) {
      const b = this.box && this.box.w > 0 && this.box.h > 0 ? this.box : { w: W || 1, h: H || 1 };
      const base = Math.min(W / b.w, H / b.h) || 1;
      if (ink && !this.isEmpty()) {
        const k = this.inkBounds();
        const s = Math.min(W / k.w, H / k.h, 3 * Math.max(W / b.w, H / b.h)); // don't blow a tiny mark up too much
        return { s, ox: (W - k.w * s) / 2 - k.x * s, oy: (H - k.h * s) / 2 - k.y * s };
      }
      return { s: base, ox: (W - b.w * base) / 2, oy: (H - b.h * base) / 2 };
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.redraw();
    }
    drawOn(ctx, W, H, lw, bg, ink = this.fitInk) {
      ctx.clearRect(0, 0, W, H);
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
      const { s, ox, oy } = this.fit(W, H, ink);
      const X = (p) => ox + p[0] * s, Y = (p) => oy + p[1] * s;
      ctx.strokeStyle = '#141a4d'; ctx.fillStyle = '#141a4d';
      ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const st of this.strokes) {
        if (st.length === 1) { ctx.beginPath(); ctx.arc(X(st[0]), Y(st[0]), lw / 2, 0, 7); ctx.fill(); continue; }
        ctx.beginPath(); ctx.moveTo(X(st[0]), Y(st[0]));
        for (let i = 1; i < st.length - 1; i++) {
          const m = [(st[i][0] + st[i + 1][0]) / 2, (st[i][1] + st[i + 1][1]) / 2];
          ctx.quadraticCurveTo(X(st[i]), Y(st[i]), X(m), Y(m));
        }
        const l = st[st.length - 1]; ctx.lineTo(X(l), Y(l)); ctx.stroke();
      }
    }
    redraw() { this.drawOn(this.ctx, this.canvas.width, this.canvas.height, 2.6 * (window.devicePixelRatio || 1)); }
    isEmpty() { return this.strokes.length === 0; }
    clear() { this.strokes = []; this.box = null; this.fitInk = false; this.redraw(); this.changed(true); }
    getData() { return { box: this.box, strokes: this.strokes, ink: this.fitInk }; }
    setData(d) {
      d = d || {};
      let strokes = d.strokes || [], box = d.box || null;
      // v1.0 format: normalised {x,y} points
      if (strokes.length && strokes[0][0] && typeof strokes[0][0] === 'object' && 'x' in strokes[0][0]) {
        box = { w: 600, h: 210 };
        strokes = strokes.map((st) => st.map((p) => [p.x * 600, p.y * 210]));
      }
      this.strokes = JSON.parse(JSON.stringify(strokes));
      this.box = this.strokes.length ? (box || { w: 600, h: 210 }) : null;
      this.fitInk = !!d.ink && this.strokes.length > 0;
      this.redraw(); this.changed(true);
    }
    changed(final) {
      this.host.classList.toggle('signed', !this.isEmpty());
      if (!this.isEmpty()) { this.host.closest('.field')?.classList.remove('invalid'); this.host.closest('.field')?.querySelector('.err-msg')?.remove(); }
      if (final) this.onChange(this);
    }
    toDataURL() {
      if (this.isEmpty()) return '';
      // Export cropped to the ink so the signature fills its box on the PDF.
      const k = this.inkBounds();
      const w = 800, h = Math.max(200, Math.min(500, Math.round(800 * (k.h / k.w))));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const scale = Math.min(w / k.w, h / k.h);
      // keep line weight similar to what was drawn (2.6 css px on screen)
      this.drawOn(c.getContext('2d'), w, h, Math.max(3, Math.min(9, 2.6 * scale)), '#ffffff', true); // solid white: Google's PDF maker handles transparency poorly
      return c.toDataURL('image/png');
    }
  }

  const pads = {};
  $$('[data-sig]').forEach((el) => (pads[el.dataset.sig] = new SigPad(el, { onChange: () => saveDraftSoon(), onExpand: openFull })));
  const setPad = new SigPad($('#setRepSig'), { onExpand: openFull });   // Settings: my saved signature
  const sesPad = new SigPad($('#sesRepSig'), { onExpand: openFull });   // Group session setup
  const renderPad = new SigPad(document.createElement('div'), { inline: false });
  const sigURL = (d) => { if (!d || !d.strokes || !d.strokes.length) return ''; renderPad.setData(d); return renderPad.toDataURL(); };
  const hasSig = (d) => !!(d && d.strokes && d.strokes.length && d.box && d.box.w > 0);

  /* ---------------- modes: group session / rep details from Settings ---------------- */
  let session = null;     // the active group session record (persisted in IndexedDB)
  let inSession = false;  // is the current form part of the session?
  let forceRep = false;   // user tapped "Change" on the rep details for this form
  const repFromSettings = () => !!(settings.rep && settings.project && hasSig(settings.repSig));
  const skipRep = () => inSession || (!forceRep && repFromSettings());

  /* ---------------- full-screen signing ---------------- */
  const fullEl = $('#sigFull');
  const fullPad = new SigPad($('[data-fullpad]'), { inline: false });
  let fullTarget = null;
  async function openFull(pad) {
    fullTarget = pad;
    const label = pad.host.closest('.field')?.querySelector('.label')?.textContent || 'Signature';
    $('#sigFullTitle').textContent = label.replace(/\s*\(optional\)\s*/i, '');
    fullPad.clear();
    fullEl.hidden = false;
    document.body.classList.add('noscroll');
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch (_) { /* not supported (e.g. iPhone) – the hint asks to rotate */ }
    setTimeout(() => fullPad.resize(), 60);
    setTimeout(() => fullPad.resize(), 400);
  }
  async function closeFull(apply) {
    if (fullEl.hidden) return;
    if (apply && fullTarget && !fullPad.isEmpty()) fullTarget.setData({ ...fullPad.getData(), ink: true });
    fullEl.hidden = true;
    document.body.classList.remove('noscroll');
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (_) {}
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (_) {}
    setTimeout(() => Object.values(pads).forEach((p) => p.resize()), 300);
    fullTarget = null;
  }
  $('#sigFullDone').addEventListener('click', () => {
    if (fullPad.isEmpty()) { toast('Please sign before tapping Done'); return; }
    closeFull(true);
  });
  $('#sigFullCancel').addEventListener('click', () => closeFull(false));
  $('#sigFullClear').addEventListener('click', () => fullPad.clear());
  window.addEventListener('resize', () => {
    Object.values(pads).forEach((p) => p.resize());
    setPad.resize(); sesPad.resize();
    if (!fullEl.hidden) fullPad.resize();
  });

  /* ---------------- chips (single choice buttons) ---------------- */
  const chips = {};
  function selectChip(name, v) {
    const group = $(`.chips[data-name="${name}"]`); if (!group) return;
    $$('button', group).forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    if (v) chips[name] = v; else delete chips[name];
    const other = group.parentElement.querySelector(`input[name="${name}Other"]`);
    if (other) other.hidden = v !== '__other';
    if (name === 'usePreferredName') $('#prefNameWrap').hidden = v !== 'Yes';
  }
  $$('.chips').forEach((group) => {
    const name = group.dataset.name;
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      selectChip(name, b.dataset.v);
      if (b.dataset.v === '__other') group.parentElement.querySelector(`input[name="${name}Other"]`)?.focus();
      const f = group.closest('.field'); f?.classList.remove('invalid'); f?.querySelector('.err-msg')?.remove();
      saveDraftSoon();
    });
  });
  const chipValue = (name) => {
    const v = chips[name] || '';
    if (v === '__other') return (form.elements[name + 'Other']?.value || '').trim() || 'Other';
    return v;
  };

  /* ---------------- photo ---------------- */
  let photoData = '';
  async function shrinkImage(file, max = 1200, q = 0.75) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    } finally { URL.revokeObjectURL(url); }
  }
  $$('[data-photo]').forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; inp.value = '';
    if (!f) return;
    try { setPhoto(await shrinkImage(f)); saveDraftSoon(); } catch { toast('Could not read that image.'); }
  }));
  function setPhoto(d) {
    photoData = d || '';
    $('#photoPreview').hidden = !photoData;
    $('#photoPreview img').src = photoData;
  }
  $('#btnRemovePhoto').addEventListener('click', () => { setPhoto(''); saveDraftSoon(); });

  /* ---------------- steps ---------------- */
  const steps = $$('.step');
  let stepIdx = 0;
  const inForm = () => !$('#stepnav').hidden;
  const val = (n) => (form.elements[n]?.value || '').trim();
  const age = () => { const a = parseInt(val('age'), 10); return Number.isFinite(a) ? a : null; };
  const isMinor = () => age() !== null && age() < 18;
  const activeSteps = () => steps.filter((s) =>
    (s.dataset.if !== 'minor' || isMinor()) &&
    !(s.dataset.step === 'rep' && skipRep()) &&
    !(s.dataset.step === 'review' && inSession));

  function showScreen(id) {
    $$('.screen').forEach((s) => (s.hidden = true));
    const f = id === 'form';
    $('#stepnav').hidden = !f;
    $('#progress').hidden = !f;
    $('#btnHome').hidden = id === 'home';
    if (!f) { $('#screen-' + id).hidden = false; $('#sessionBar').hidden = true; }
    window.scrollTo(0, 0);
  }

  function renderStep() {
    const list = activeSteps();
    stepIdx = Math.max(0, Math.min(stepIdx, list.length - 1));
    $$('.screen').forEach((s) => (s.hidden = true));
    const cur = list[stepIdx];
    cur.hidden = false;
    $('#progressBar').style.width = `${((stepIdx + 1) / list.length) * 100}%`;
    $('#sessionBar').hidden = !inSession;
    if (inSession && session) { $('#sbName').textContent = session.data.sessionName; $('#sbNum').textContent = session.people + 1; }
    $('#btnBack').style.visibility = stepIdx === 0 ? 'hidden' : 'visible';
    const last = stepIdx === list.length - 1;
    $('#btnNext').disabled = false;
    $('#btnNext').innerHTML = last
      ? 'Save <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>'
      : 'Next <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>';
    onEnterStep(cur.dataset.step);
    requestAnimationFrame(() => $$('[data-sig]', cur).forEach((el) => pads[el.dataset.sig].resize()));
    window.scrollTo(0, 0);
    saveDraft();
  }

  function onEnterStep(name) {
    if (name === 'sign') {
      const minor = isMinor();
      $('#partSigLabel').textContent = minor ? "Child's signature or mark (optional)" : 'Participant signature or mark';
      $('#partSigField').classList.toggle('req', !minor);
      $('#photoLabel').innerHTML = inSession ? 'Individual photo <small>(optional – the group photo is already taken)</small>' : 'Photo of participant <small>(optional)</small>';
      const sum = $('#sessionSummary');
      sum.hidden = !inSession;
      if (inSession) {
        sum.innerHTML = `<b>${esc(val('fullName'))}</b>${chips.usePreferredName === 'Yes' && val('preferredName') ? ' (“' + esc(val('preferredName')) + '”)' : ''} · ${esc(val('age'))} yrs${isMinor() ? ' · guardian: ' + esc(val('guardianName')) : ''}<br><small>Check the name with the participant – the form is saved when you tap Save.</small>`;
      }
    }
    if (name === 'rep') {
      if (pads.repSignature.isEmpty() && hasSig(settings.repSig) && (!val('repName') || val('repName') === settings.rep)) pads.repSignature.setData(settings.repSig);
      if (!val('consentDate')) form.elements.consentDate.value = todayISO();
      if (!val('consentTime')) form.elements.consentTime.value = nowHM();
      const last = JSON.parse(localStorage.getItem('thp-rep-sig') || 'null');
      const has = last && ((last.data && last.data.strokes && last.data.strokes.length) || (last.strokes && last.strokes.length));
      $('#btnReuseRepSig').hidden = !has;
      if (has) $('#btnReuseRepSig').textContent = `Use saved signature (${last.name || 'last used'})`;
    }
    if (name === 'review') buildReview();
  }

  function fail(el, msg) {
    const f = el.closest('.field') || el.closest('[data-group]') || el;
    f.classList.add('invalid');
    if (!f.querySelector('.err-msg')) {
      const m = document.createElement('div'); m.className = 'err-msg'; m.textContent = msg; f.appendChild(m);
    }
    return false;
  }
  function clearErrors(scope) {
    $$('.invalid', scope).forEach((e) => e.classList.remove('invalid'));
    $$('.err-msg', scope).forEach((e) => e.remove());
  }
  form.addEventListener('input', (e) => {
    const f = e.target.closest('.field, [data-group]');
    if (f) { f.classList.remove('invalid'); f.querySelector('.err-msg')?.remove(); }
    saveDraftSoon();
  });
  form.addEventListener('change', () => saveDraftSoon());

  function validate(name, scope) {
    clearErrors(scope);
    let ok = true;
    const need = (n, msg = 'This field is required') => { if (!val(n)) ok = fail(form.elements[n], msg) && ok; };
    const needChip = (n, msg = 'Please choose one') => {
      if (!chips[n]) ok = fail($(`.chips[data-name="${n}"]`), msg) && ok;
      else if (chips[n] === '__other' && !val(n + 'Other')) ok = fail(form.elements[n + 'Other'], 'Please describe') && ok;
    };
    const needSig = (n, msg = 'A signature is required') => { if (pads[n].isEmpty()) ok = fail(pads[n].host, msg) && ok; };

    if (name === 'consent') {
      if (!['c1', 'c2', 'c3', 'c4'].every((c) => form.elements[c].checked)) {
        ok = fail($('[data-group="consents"]'), 'All four statements must be ticked to give consent.');
      }
    }
    if (name === 'about') {
      need('fullName'); need('community');
      const a = age();
      if (a === null || a < 0 || a > 120) ok = fail(form.elements.age, 'Enter the age in years') && ok;
      if (chips.gender === '__other' && !val('genderOther')) ok = fail(form.elements.genderOther, 'Please describe') && ok;
    }
    if (name === 'role') {
      needChip('representsCommunity'); needChip('usePreferredName');
      if (chips.usePreferredName === 'Yes') need('preferredName');
    }
    if (name === 'guardian') { need('guardianName'); needChip('guardianRelationship'); needSig('guardianSignature'); }
    if (name === 'sign' && !isMinor()) needSig('participantSignature');
    if (name === 'rep') { need('project'); need('repName'); need('consentDate'); need('consentTime'); needSig('repSignature'); }

    if (!ok) {
      const first = $('.invalid', scope);
      first && first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      navigator.vibrate && navigator.vibrate(60);
    }
    return ok;
  }

  $('#btnNext').addEventListener('click', async () => {
    const list = activeSteps();
    const cur = list[stepIdx];
    if (!validate(cur.dataset.step, cur)) return;
    if (stepIdx === list.length - 1) return saveForm();
    stepIdx++; renderStep();
  });
  function stepBack() {
    if (stepIdx > 0) { stepIdx--; renderStep(); } else leaveForm();
  }
  $('#btnBack').addEventListener('click', stepBack);

  // Android back button / browser back: keep one "trap" history entry while the app is open.
  let trapArmed = false;
  const armTrap = () => { if (!trapArmed) { history.pushState({ trap: 1 }, ''); trapArmed = true; } };
  window.addEventListener('popstate', () => {
    trapArmed = false;
    if (!fullEl.hidden) { closeFull(false); armTrap(); return; }
    if (inForm()) { armTrap(); stepBack(); return; }
    if (!$('#screen-pdfs').hidden || !$('#screen-settings').hidden || !$('#screen-session').hidden) { armTrap(); goHome(); }
  });

  $('#btnAgreeAll').addEventListener('click', () => {
    ['c1', 'c2', 'c3', 'c4'].forEach((c) => (form.elements[c].checked = true));
    clearErrors($('[data-step="consent"]'));
    saveDraftSoon();
  });
  $('#btnReuseRepSig').addEventListener('click', () => {
    const last = JSON.parse(localStorage.getItem('thp-rep-sig') || 'null');
    if (last) pads.repSignature.setData(last.data || last);
  });

  function resetForm(keep = {}) {
    form.reset();
    Object.keys(chips).forEach((k) => delete chips[k]);
    $$('.chips button').forEach((b) => b.classList.remove('on'));
    $$('input[name$="Other"]').forEach((i) => (i.hidden = true));
    $('#prefNameWrap').hidden = true;
    Object.values(pads).forEach((p) => { p.strokes = []; p.box = null; p.redraw(); p.host.classList.remove('signed'); });
    setPhoto('');
    clearErrors(form);
    form.elements.community.value = keep.community || '';
    form.elements.project.value = keep.project || settings.project || '';
    form.elements.repName.value = keep.repName || settings.rep || '';
    fillDatalist('#communityList', 'community');
    fillDatalist('#projectList', 'project');
  }

  function startForm(keep = {}, opts = {}) {
    inSession = !!(opts.session && session);
    forceRep = false;
    if (inSession) keep = { ...keep, community: session.data.community };
    resetForm(keep);
    stepIdx = 0;
    showScreen('form');
    armTrap();
    renderStep();
  }

  function leaveForm() {
    if (confirm('Leave this form? Anything entered will be lost.')) { clearDraft(); goHome(); }
  }

  /* ---------------- draft autosave (survives refresh / app restart) ---------------- */
  const DRAFT_KEY = 'thp-draft';
  let draftTimer;
  function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 250); }
  function saveDraft() {
    clearTimeout(draftTimer);
    if (!inForm()) return;
    const fields = {};
    Array.from(form.elements).forEach((el) => {
      if (!el.name || el.type === 'file' || el.type === 'button') return;
      fields[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    const d = {
      v: 3, stepIdx, fields, chips: { ...chips }, photo: photoData, savedAt: Date.now(),
      inSession, sessionId: inSession && session ? session.sessionId : '', forceRep,
      pads: Object.fromEntries(Object.entries(pads).map(([k, p]) => [k, p.getData()])),
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); }
    catch (_) { d.photo = ''; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (__) { /* storage full */ } }
  }
  function clearDraft() { clearTimeout(draftTimer); localStorage.removeItem(DRAFT_KEY); }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } }
  async function restoreDraft(d) {
    inSession = false; forceRep = !!d.forceRep;
    if (d.inSession && d.sessionId) {
      const s = await DB.getSession(d.sessionId);
      if (s && !s.closed) { session = s; inSession = true; }
    }
    resetForm();
    Object.entries(d.fields || {}).forEach(([k, v]) => {
      const el = form.elements[k]; if (!el || !el.name) return;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    Object.entries(d.chips || {}).forEach(([k, v]) => selectChip(k, v));
    Object.entries(d.pads || {}).forEach(([k, v]) => pads[k] && v && v.strokes && v.strokes.length && pads[k].setData(v));
    setPhoto(d.photo || '');
    stepIdx = d.stepIdx || 0;
    showScreen('form');
    armTrap();
    renderStep();
    toast('Continuing your unfinished form');
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
  window.addEventListener('pagehide', saveDraft);

  /* ---------------- review & save ---------------- */
  function collect() {
    const minor = isMinor();
    return {
      consentId: newConsentId(),
      appVersion: APP_VERSION,
      device: settings.device || '',
      createdAt: new Date().toISOString(),
      timezoneOffsetMin: new Date().getTimezoneOffset(),
      consents: {
        notAffected: form.elements.c1.checked,
        noPayment: form.elements.c2.checked,
        storageAndUse: form.elements.c3.checked,
        canWithdraw: form.elements.c4.checked,
      },
      fullName: val('fullName'),
      community: val('community'),
      age: age(),
      isMinor: minor,
      gender: chipValue('gender'),
      contact: val('contact'),
      representsCommunity: chips.representsCommunity || '',
      usePreferredName: chips.usePreferredName || '',
      preferredName: chips.usePreferredName === 'Yes' ? val('preferredName') : '',
      guardianName: minor ? val('guardianName') : '',
      guardianRelationship: minor ? chipValue('guardianRelationship') : '',
      guardianSignature: minor ? pads.guardianSignature.toDataURL() : '',
      participantSignature: pads.participantSignature.toDataURL(),
      photo: photoData,
      ...repDetails(),
      sessionId: inSession ? session.sessionId : '',
      sessionName: inSession ? session.data.sessionName : '',
    };
  }
  function repDetails() {
    if (inSession) return { project: session.data.project, repName: session.data.repName, repSignature: session.data.repSignature, consentDate: todayISO(), consentTime: nowHM() };
    if (skipRep()) return { project: settings.project, repName: settings.rep, repSignature: sigURL(settings.repSig), consentDate: todayISO(), consentTime: nowHM() };
    return { project: val('project'), repName: val('repName'), repSignature: pads.repSignature.toDataURL(), consentDate: val('consentDate'), consentTime: val('consentTime') };
  }

  function buildReview() {
    const d = collect();
    const rows = [
      ['Consent statements', 'All 4 agreed ✓'],
      ['Full name', d.fullName],
      ['Preferred name', d.preferredName || '—'],
      ['Community', d.community],
      ['Represents community', d.representsCommunity],
      ['Age', d.age + (d.isMinor ? ' (under 18)' : '')],
      ['Gender identity', d.gender || '—'],
      ['Contact', d.contact || '—'],
    ];
    if (d.isMinor) {
      rows.push(['Parent / guardian', `${d.guardianName} (${d.guardianRelationship})`]);
      rows.push(['Guardian signature', img(d.guardianSignature)]);
    }
    rows.push([d.isMinor ? "Child's signature" : 'Participant signature', img(d.participantSignature) || '—']);
    rows.push(['Photo', img(d.photo) || '—']);
    rows.push(['Project / activity', d.project]);
    rows.push(['THP representative', skipRep() ? { html: `${esc(d.repName)} <small>(from Settings)</small> <button type="button" class="link-btn inline" id="btnChangeRep">Change</button>` } : d.repName]);
    rows.push(['Rep. signature', img(d.repSignature)]);
    rows.push(['Date & time', `${d.consentDate} · ${d.consentTime}`]);
    $('#reviewList').innerHTML = rows.map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${typeof v === 'object' ? v.html : esc(v)}</dd></div>`).join('');
    $('#btnChangeRep')?.addEventListener('click', () => {
      forceRep = true;
      stepIdx = activeSteps().findIndex((s) => s.dataset.step === 'rep');
      renderStep();
    });
    function img(src) { return src ? { html: `<img src="${src}" alt="">` } : ''; }
  }

  let lastKeep = {};
  let lastWasSession = false;
  let lastPdf = null; // { consentId, fileName, blob }

  async function saveForm() {
    const btn = $('#btnNext');
    btn.disabled = true; btn.textContent = 'Saving…';
    const data = collect();
    const rec = {
      consentId: data.consentId,
      status: 'pending',
      savedAt: data.createdAt,
      summary: { name: data.fullName, community: data.community, date: data.consentDate, minor: data.isMinor },
      data,
    };
    try { await DB.put(rec); }
    catch (e) { alert('Could not save on this device: ' + e.message); btn.disabled = false; renderStep(); return; }

    // PDF copy on the device
    lastPdf = null;
    try {
      const blob = await window.ConsentPDF.build(inSession ? { ...data, groupPhoto: session.data.groupPhoto } : data);
      const fileName = window.ConsentPDF.fileName(data);
      const meta = { consentId: data.consentId, fileName, name: data.fullName, community: data.community, date: data.consentDate, minor: data.isMinor, createdAt: data.createdAt, size: blob.size };
      try { await DB.putPdf({ ...meta, blob }); }
      catch (_) { await DB.putPdf({ ...meta, bytes: await blob.arrayBuffer() }); } // some browsers can't store Blobs
      lastPdf = { consentId: data.consentId, fileName, blob };
    } catch (e) {
      console.error('PDF failed', e);
      toast('The form is saved, but the PDF copy could not be made on this device.', 4000);
    }

    remember('community', data.community);
    remember('project', data.project);
    if (!skipRep()) {
      localStorage.setItem('thp-rep-sig', JSON.stringify({ name: data.repName, data: pads.repSignature.getData() }));
      settings.rep = data.repName; settings.project = data.project; saveSettings();
    }
    lastWasSession = inSession;
    if (inSession) {
      session.people = (session.people || 0) + 1;
      if (data.isMinor) session.minors = (session.minors || 0) + 1;
      await DB.putSession(session);
    }
    clearDraft();

    lastKeep = { community: data.community, project: data.project, repName: data.repName };
    $('#doneId').textContent = data.consentId;
    $('#donePdf').hidden = !lastPdf;
    $('#btnNextSame').textContent = lastWasSession ? `Next person (#${session.people + 1})` : 'Next person · same community';
    $('#btnNextNew').hidden = lastWasSession;
    $('#btnEndSession').hidden = !lastWasSession;
    $('#doneTitle').textContent = lastWasSession ? `Consent saved · ${session.people} in this session` : 'Consent saved';
    $('#doneMsg').textContent = navigator.onLine
      ? 'Saved on this device. Uploading now…'
      : 'Saved on this device. It will upload automatically when you are back online.';
    showScreen('done');
    if (lastPdf && settings.autoDownload) downloadBlob(lastPdf.blob, lastPdf.fileName);
    syncAll().then(() => {
      DB.all().then((all) => {
        const r = all.find((x) => x.consentId === data.consentId);
        if (r && r.status === 'sent' && !$('#screen-done').hidden) $('#doneMsg').textContent = 'Saved on this device and uploaded to Google Drive ✓';
      });
    });
  }

  /* ---------------- PDF copies on the device ---------------- */
  const pdfBlob = (rec) => rec.blob || new Blob([rec.bytes], { type: 'application/pdf' });
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function openBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) downloadBlob(blob, name);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  async function shareBlob(blob, name) {
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
  }
  $('#btnDoneOpenPdf').addEventListener('click', () => lastPdf && openBlob(lastPdf.blob, lastPdf.fileName));
  $('#btnDoneSharePdf').addEventListener('click', () => lastPdf && shareBlob(lastPdf.blob, lastPdf.fileName));

  async function showPdfs() {
    showScreen('pdfs');
    armTrap();
    const list = (await DB.allPdfs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const q = ($('#pdfSearch').value || '').trim().toLowerCase();
    const shown = q ? list.filter((p) => (p.name + ' ' + p.community + ' ' + p.date + ' ' + p.consentId).toLowerCase().includes(q)) : list;
    const total = list.reduce((s, p) => s + (p.size || 0), 0);
    $('#pdfSummary').textContent = `${list.length} PDF${list.length === 1 ? '' : 's'} on this device · ${fmtSize(total)}`;
    $('#pdfList').innerHTML = shown.map((p) => `
      <li data-id="${esc(p.consentId)}">
        <div class="who"><b>${esc(p.name)}${p.minor ? ' (minor)' : ''}</b>
          <small>${esc(p.community)} · ${esc(p.date)} · ${esc(p.consentId)}</small></div>
        <div class="pdf-actions">
          <button type="button" class="btn small" data-act="open">Open</button>
          <button type="button" class="btn small" data-act="share">Save / Share</button>
          <button type="button" class="icon-del" data-act="del" aria-label="Delete">✕</button>
        </div>
      </li>`).join('') || `<li><div class="who"><small>${q ? 'No matches.' : 'No PDFs yet. Each saved form creates one here.'}</small></div></li>`;
  }
  $('#pdfSearch').addEventListener('input', showPdfs);
  $('#pdfList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('li').dataset.id;
    const rec = await DB.getPdf(id); if (!rec) return;
    const blob = pdfBlob(rec);
    if (b.dataset.act === 'open') openBlob(blob, rec.fileName);
    if (b.dataset.act === 'share') shareBlob(blob, rec.fileName);
    if (b.dataset.act === 'del') {
      const rec2 = (await DB.all()).find((f) => f.consentId === id);
      const warn = rec2 && rec2.status !== 'sent' ? '\n\nThis form has NOT been uploaded yet – the upload will still happen, but this device copy will be gone.' : '';
      if (confirm(`Delete the PDF copy for ${rec.name} from this device? This cannot be undone.${warn}`)) {
        await DB.delPdf(id); showPdfs(); refreshHome();
      }
    }
  });

  /* ---------------- sync ---------------- */
  let syncing = false;
  async function postRecord(data) { return post({ record: data }); }
  async function post(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(settings.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: settings.key, ...payload }),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let j; try { j = JSON.parse(text); } catch { throw new Error('Unexpected reply from server (check the upload link).'); }
      if (!j.ok) throw Object.assign(new Error(j.error || 'Upload refused'), { fatal: true });
      return j;
    } finally { clearTimeout(timer); }
  }

  async function syncAll() {
    if (syncing) return;
    if (!settings.url || !settings.key) { setSyncMsg('Add the upload link and team key in Settings to start uploading.'); return; }
    if (!navigator.onLine) { setSyncMsg('Offline — forms will upload when internet returns.'); return; }
    syncing = true; setSyncMsg('Uploading…');
    let sent = 0, failed = 0;
    try {
      // 1) group sessions first (the forms in a session are filed in the session's folder)
      const sessAll = await DB.allSessions();
      for (const s of sessAll.filter((x) => x.status !== 'sent')) {
        try {
          const { repSignatureData, ...sessionData } = s.data;
          const j = await post({ type: 'session', session: sessionData });
          s.status = 'sent'; s.folderUrl = j.folderUrl || ''; s.error = '';
          if (s.closed) delete s.data.groupPhoto;
          await DB.putSession(s);
        } catch (e) {
          s.status = 'error'; s.error = e.name === 'AbortError' ? 'Timed out' : e.message;
          await DB.putSession(s); failed++;
          if (!e.fatal) throw Object.assign(new Error('offline'), { stop: true });
        }
      }
      const sentSessions = new Set(sessAll.filter((x) => x.status === 'sent').map((x) => x.sessionId));
      // 2) forms
      const pending = (await DB.all()).filter((r) => r.status !== 'sent' && (!r.data || !r.data.sessionId || sentSessions.has(r.data.sessionId)))
        .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      for (const r of pending) {
        try {
          const j = await postRecord(r.data);
          r.status = 'sent'; r.pdfUrl = j.pdfUrl || ''; r.sentAt = new Date().toISOString(); r.error = '';
          delete r.data; // the raw form data is no longer needed; the PDF copy stays on the PDFs screen
          await DB.put(r); sent++;
        } catch (e) {
          r.status = 'error'; r.error = e.name === 'AbortError' ? 'Timed out' : e.message;
          await DB.put(r); failed++;
          if (!e.fatal) break; // network problem: stop and try later
        }
        refreshHome();
      }
      setSyncMsg(failed ? `Some forms could not upload yet (${failed}). They will retry automatically.` : sent ? `Uploaded ${sent} form${sent > 1 ? 's' : ''} ✓` : 'All forms are uploaded.');
    } catch (e) {
      if (!e.stop) throw e;
      setSyncMsg('Could not reach Google – forms will retry automatically.');
    } finally {
      syncing = false; refreshHome(); pruneSent();
    }
  }
  async function pruneSent() {
    const sent = (await DB.all()).filter((r) => r.status === 'sent').sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    for (const r of sent.slice(100)) await DB.del(r.consentId);
  }
  function setSyncMsg(m) { $('#syncMsg').textContent = m; }

  async function refreshHome() {
    const all = (await DB.all()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    const pdfCount = (await DB.allPdfs()).length;
    const pending = all.filter((r) => r.status !== 'sent');
    $('#statPending').textContent = pending.length;
    $('#statSent').textContent = all.length - pending.length;
    $('#statPdfs').textContent = pdfCount;
    $('#sessionBanner').hidden = !session;
    $('#btnStartSession').hidden = !!session;
    if (session) {
      $('#sbHomeName').textContent = session.data.sessionName;
      $('#sbHomeCount').textContent = `${session.people || 0} ${session.people === 1 ? 'person' : 'people'} added${session.minors ? ` (${session.minors} under 18)` : ''} · started ${new Date(session.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    $('#outbox').innerHTML = all.slice(0, 25).map((r) => {
      const badge = r.status === 'sent' ? '<span class="badge sent">Uploaded</span>'
        : r.status === 'error' ? `<span class="badge err" title="${esc(r.error)}">Retry</span>` : '<span class="badge">Waiting</span>';
      const link = r.pdfUrl ? ` · <a href="${esc(r.pdfUrl)}" target="_blank" rel="noopener">Drive PDF</a>` : '';
      return `<li><div class="who"><b>${esc(r.summary.name)}${r.summary.minor ? ' (minor)' : ''}</b>
        <small>${esc(r.summary.community)} · ${esc(r.summary.date)}${link}</small></div>${badge}</li>`;
    }).join('') || '<li><div class="who"><small>No forms yet.</small></div></li>';
  }

  function updateNet() {
    const n = $('#netStatus');
    n.className = 'net ' + (navigator.onLine ? 'on' : 'off');
    n.textContent = navigator.onLine ? 'Online' : 'Offline — saving on device';
  }
  window.addEventListener('online', () => { updateNet(); syncAll(); });
  window.addEventListener('offline', updateNet);
  setInterval(() => navigator.onLine && syncAll(), 5 * 60 * 1000);

  /* ---------------- group sessions ---------------- */
  const ACTIVE_KEY = 'thp-active-session';
  async function loadSession() {
    const id = localStorage.getItem(ACTIVE_KEY); if (!id) return null;
    const s = await DB.getSession(id);
    return s && !s.closed ? s : null;
  }
  let groupPhoto = '';
  function setGroupPhoto(d) { groupPhoto = d || ''; $('#groupPreview').hidden = !groupPhoto; $('#groupPreview img').src = groupPhoto; }
  $$('[data-groupphoto]').forEach((inp) => inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; inp.value = '';
    if (!f) return;
    try { setGroupPhoto(await shrinkImage(f, 1600, 0.78)); } catch { toast('Could not read that image.'); }
  }));
  $('#btnRemoveGroupPhoto').addEventListener('click', () => setGroupPhoto(''));

  function openSessionSetup() {
    const scr = $('#screen-session');
    clearErrors(scr);
    $('#sesCommunity').value = '';
    $('#sesProject').value = settings.project || '';
    $('#sesRep').value = settings.rep || '';
    setGroupPhoto('');
    fillDatalist('#communityList', 'community');
    fillDatalist('#projectList', 'project');
    showScreen('session');
    armTrap();
    requestAnimationFrame(() => { sesPad.resize(); if (hasSig(settings.repSig)) sesPad.setData(settings.repSig); else sesPad.clear(); });
  }
  $('#btnStartSession').addEventListener('click', openSessionSetup);
  $('#btnBeginSession').addEventListener('click', async () => {
    const scr = $('#screen-session'); clearErrors(scr);
    let ok = true;
    [['#sesCommunity', 'Enter the community'], ['#sesProject', 'Enter the project or activity'], ['#sesRep', 'Enter the THP representative name']].forEach(([sel, msg]) => {
      if (!$(sel).value.trim()) ok = fail($(sel), msg) && ok;
    });
    if (sesPad.isEmpty()) ok = fail(sesPad.host, 'A signature is required') && ok;
    if (!ok) { $('.invalid', scr)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (!groupPhoto && !confirm('No group photo yet. Start the session without one?')) return;
    const community = $('#sesCommunity').value.trim(), project = $('#sesProject').value.trim(), repName = $('#sesRep').value.trim();
    const sessionId = newConsentId().replace('THP-', 'GS-');
    const now = new Date().toISOString();
    session = {
      sessionId, status: 'pending', closed: false, people: 0, minors: 0, createdAt: now,
      data: {
        sessionId, sessionName: `${community} – ${project}`, community, project, repName,
        repSignature: sesPad.toDataURL(), groupPhoto, date: todayISO(),
        device: settings.device || '', createdAt: now, appVersion: APP_VERSION,
      },
    };
    await DB.putSession(session);
    localStorage.setItem(ACTIVE_KEY, sessionId);
    remember('community', community); remember('project', project);
    if (!settings.rep) { settings.rep = repName; saveSettings(); }
    syncAll();
    toast('Group session started');
    startForm({}, { session: true });
  });

  async function endSession(force) {
    if (!session) return;
    if (force !== true && !confirm(`End the group session "${session.data.sessionName}"?\n${session.people || 0} people added.`)) return;
    session.closed = true; session.closedAt = new Date().toISOString();
    if (session.status === 'sent') delete session.data.groupPhoto;
    await DB.putSession(session);
    localStorage.removeItem(ACTIVE_KEY);
    const n = session.people || 0;
    session = null; inSession = false;
    if (inForm()) clearDraft();
    goHome();
    toast(`Session ended · ${n} ${n === 1 ? 'person' : 'people'}`);
    syncAll();
  }
  $('#btnEndSession').addEventListener('click', () => endSession());
  $('#btnSessionEnd').addEventListener('click', () => endSession());
  $('#btnSessionNext').addEventListener('click', () => startForm({}, { session: true }));
  $('#btnSessionBarEnd').addEventListener('click', () => {
    if (confirm('Stop this person\'s form and end the session? This person\'s form will not be saved.')) { clearDraft(); endSession(true); }
  });

  /* ---------------- navigation ---------------- */
  function goHome() { showScreen('home'); refreshHome(); }
  $('#btnNew').addEventListener('click', () => {
    if (session && !confirm('A group session is running. Start a single form outside the session?')) return;
    startForm();
  });
  $('#btnPdfs').addEventListener('click', () => { $('#pdfSearch').value = ''; showPdfs(); });
  $('#btnNextSame').addEventListener('click', () => (lastWasSession && session ? startForm({}, { session: true }) : startForm(lastKeep)));
  $('#btnNextNew').addEventListener('click', () => startForm({ project: lastKeep.project, repName: lastKeep.repName }));
  $('#btnDoneHome').addEventListener('click', goHome);
  $('#btnSync').addEventListener('click', syncAll);
  $('#btnHome').addEventListener('click', () => { if (inForm()) leaveForm(); else goHome(); });

  $('#btnSettings').addEventListener('click', () => {
    if (inForm() && !confirm('Leave this form? Anything entered will be lost.')) return;
    clearDraft();
    $('#setUrl').value = settings.url; $('#setKey').value = settings.key;
    $('#setDevice').value = settings.device; $('#setRep').value = settings.rep; $('#setProject').value = settings.project;
    $('#setAutoDownload').checked = !!settings.autoDownload;
    $('#testMsg').textContent = '';
    showScreen('settings');
    armTrap();
    requestAnimationFrame(() => { setPad.resize(); if (hasSig(settings.repSig)) setPad.setData(settings.repSig); else setPad.clear(); });
  });
  function readSettingsForm() {
    settings.url = $('#setUrl').value.trim(); settings.key = $('#setKey').value.trim();
    settings.device = $('#setDevice').value.trim(); settings.rep = $('#setRep').value.trim(); settings.project = $('#setProject').value.trim();
    settings.autoDownload = $('#setAutoDownload').checked;
    settings.repSig = setPad.isEmpty() ? null : setPad.getData();
  }
  $('#btnSaveSettings').addEventListener('click', () => { readSettingsForm(); saveSettings(); toast('Settings saved'); goHome(); syncAll(); });
  $('#btnTest').addEventListener('click', async () => {
    readSettingsForm();
    const m = $('#testMsg'); m.textContent = 'Testing…';
    try {
      const u = new URL(settings.url); u.searchParams.set('key', settings.key);
      const j = await (await fetch(u, { redirect: 'follow' })).json();
      m.textContent = j.ok && j.keyValid ? '✓ Connected. Forms will be saved to Google Drive.' : j.ok ? '✗ Connected, but the team key is wrong.' : '✗ ' + (j.error || 'Failed');
    } catch (e) { m.textContent = '✗ Could not reach the upload link. Check it and your internet.'; }
  });

  /* ---------------- boot ---------------- */
  updateNet();
  history.replaceState({ home: true }, '');
  (async () => {
    session = await loadSession();
    const draft = loadDraft();
    if (draft) await restoreDraft(draft); else goHome();
    refreshHome();
    syncAll();
  })();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
