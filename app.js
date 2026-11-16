/* THP Ghana – offline consent form
 * Forms are saved on the device (IndexedDB) and uploaded to the Google Apps Script
 * backend when there is internet. The backend creates the PDF and logs it in Google Sheets.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const form = $('#consentForm');
  const APP_VERSION = '1.0.0';

  /* ---------------- settings ---------------- */
  const SETTINGS_KEY = 'thp-settings';
  const settings = Object.assign(
    { url: '', key: '', device: '', rep: '', project: '' },
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
        const r = indexedDB.open('thp-consent', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('forms', { keyPath: 'consentId' });
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('forms', mode);
        const out = fn(t.objectStore('forms'));
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      });
    },
    put: (rec) => DB.tx('readwrite', (s) => s.put(rec)),
    all: () => DB.tx('readonly', (s) => s.getAll()),
    del: (id) => DB.tx('readwrite', (s) => s.delete(id)),
  };
  // Ask the browser not to clear our storage when space is low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- signature pad ---------------- */
  class SigPad {
    constructor(host) {
      this.host = host;
      this.name = host.dataset.sig;
      this.strokes = []; // normalised points [{x,y}] in 0..1
      host.innerHTML = '<canvas></canvas><div class="baseline"></div><span class="x">✕</span>' +
        '<div class="placeholder">Sign here</div><button type="button" class="clear">Clear</button>';
      this.canvas = $('canvas', host);
      this.ctx = this.canvas.getContext('2d');
      $('.clear', host).addEventListener('click', () => this.clear());
      let cur = null;
      const pt = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      };
      this.canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* not all pointers can be captured */ }
        cur = [pt(e)]; this.strokes.push(cur); this.redraw(); this.changed();
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!cur) return; e.preventDefault();
        const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        const evs = co.length ? co : [e];
        evs.forEach((ev) => cur.push(pt(ev)));
        this.redraw();
      });
      const end = () => { cur = null; };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.redraw();
    }
    drawOn(ctx, w, h, lw, bg) {
      ctx.clearRect(0, 0, w, h);
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
      ctx.strokeStyle = '#141a4d'; ctx.fillStyle = '#141a4d';
      ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of this.strokes) {
        if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x * w, s[0].y * h, lw / 2, 0, 7); ctx.fill(); continue; }
        ctx.beginPath(); ctx.moveTo(s[0].x * w, s[0].y * h);
        for (let i = 1; i < s.length - 1; i++) {
          const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
          ctx.quadraticCurveTo(s[i].x * w, s[i].y * h, mx * w, my * h);
        }
        const l = s[s.length - 1]; ctx.lineTo(l.x * w, l.y * h); ctx.stroke();
      }
    }
    redraw() { this.drawOn(this.ctx, this.canvas.width, this.canvas.height, 2.6 * (window.devicePixelRatio || 1)); }
    isEmpty() { return this.strokes.length === 0; }
    clear() { this.strokes = []; this.redraw(); this.changed(); }
    setStrokes(s) { this.strokes = JSON.parse(JSON.stringify(s || [])); this.redraw(); this.changed(); }
    changed() {
      this.host.classList.toggle('signed', !this.isEmpty());
      this.host.closest('.field')?.classList.remove('invalid');
    }
    toDataURL() {
      if (this.isEmpty()) return '';
      const r = this.canvas.getBoundingClientRect();
      const w = 700, h = Math.round(700 * ((r.height || 210) / (r.width || 600)));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      this.drawOn(c.getContext('2d'), w, h, 4, '#ffffff'); // solid white: Google's PDF maker handles transparency poorly
      return c.toDataURL('image/png');
    }
  }
  const pads = {};
  $$('[data-sig]').forEach((el) => (pads[el.dataset.sig] = new SigPad(el)));
  window.addEventListener('resize', () => Object.values(pads).forEach((p) => p.resize()));

  /* ---------------- chips (single choice buttons) ---------------- */
  const chips = {};
  $$('.chips').forEach((group) => {
    const name = group.dataset.name;
    const other = group.parentElement.querySelector(`input[name="${name}Other"]`);
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('button', group).forEach((x) => x.classList.toggle('on', x === b));
      chips[name] = b.dataset.v;
      if (other) { other.hidden = b.dataset.v !== '__other'; if (!other.hidden) other.focus(); }
      group.closest('.field')?.classList.remove('invalid');
      if (name === 'usePreferredName') $('#prefNameWrap').hidden = b.dataset.v !== 'Yes';
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
    try { setPhoto(await shrinkImage(f)); } catch { toast('Could not read that image.'); }
  }));
  function setPhoto(d) {
    photoData = d;
    $('#photoPreview').hidden = !d;
    $('#photoPreview img').src = d || '';
  }
  $('#btnRemovePhoto').addEventListener('click', () => setPhoto(''));

  /* ---------------- steps ---------------- */
  const steps = $$('.step');
  let stepIdx = 0;
  const val = (n) => (form.elements[n]?.value || '').trim();
  const age = () => { const a = parseInt(val('age'), 10); return Number.isFinite(a) ? a : null; };
  const isMinor = () => age() !== null && age() < 18;
  const activeSteps = () => steps.filter((s) => s.dataset.if !== 'minor' || isMinor());

  function showScreen(id) {
    $$('.screen').forEach((s) => (s.hidden = true));
    const inForm = id === 'form';
    $('#stepnav').hidden = !inForm;
    $('#progress').hidden = !inForm;
    $('#btnHome').hidden = id === 'home';
    if (!inForm) $('#screen-' + id).hidden = false;
    window.scrollTo(0, 0);
  }

  function renderStep() {
    const list = activeSteps();
    stepIdx = Math.max(0, Math.min(stepIdx, list.length - 1));
    $$('.screen').forEach((s) => (s.hidden = true));
    const cur = list[stepIdx];
    cur.hidden = false;
    $('#progressBar').style.width = `${((stepIdx + 1) / list.length) * 100}%`;
    $('#btnBack').style.visibility = stepIdx === 0 ? 'hidden' : 'visible';
    const last = stepIdx === list.length - 1;
    $('#btnNext').innerHTML = last
      ? 'Save <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>'
      : 'Next <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>';
    onEnterStep(cur.dataset.step);
    requestAnimationFrame(() => $$('[data-sig]', cur).forEach((el) => pads[el.dataset.sig].resize()));
    window.scrollTo(0, 0);
  }

  function onEnterStep(name) {
    if (name === 'sign') {
      const minor = isMinor();
      $('#partSigLabel').textContent = minor ? "Child's signature or mark (optional)" : 'Participant signature or mark';
      $('#partSigField').classList.toggle('req', !minor);
    }
    if (name === 'rep') {
      if (!val('consentDate')) form.elements.consentDate.value = todayISO();
      if (!val('consentTime')) form.elements.consentTime.value = nowHM();
      const last = JSON.parse(localStorage.getItem('thp-rep-sig') || 'null');
      $('#btnReuseRepSig').hidden = !(last && last.strokes && last.strokes.length);
      if (last) $('#btnReuseRepSig').textContent = `Use saved signature (${last.name || 'last used'})`;
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
  });

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
    stepIdx++; history.pushState({ s: stepIdx }, ''); renderStep();
  });
  $('#btnBack').addEventListener('click', () => history.back());
  window.addEventListener('popstate', () => {
    if ($('#stepnav').hidden) return;
    if (stepIdx > 0) { stepIdx--; renderStep(); }
    else { history.pushState({ s: 0 }, ''); leaveForm(); }
  });

  $('#btnAgreeAll').addEventListener('click', () => {
    ['c1', 'c2', 'c3', 'c4'].forEach((c) => (form.elements[c].checked = true));
    clearErrors($('[data-step="consent"]'));
  });
  $('#btnReuseRepSig').addEventListener('click', () => {
    const last = JSON.parse(localStorage.getItem('thp-rep-sig') || 'null');
    if (last) pads.repSignature.setStrokes(last.strokes);
  });

  function resetForm(keep = {}) {
    form.reset();
    Object.keys(chips).forEach((k) => delete chips[k]);
    $$('.chips button').forEach((b) => b.classList.remove('on'));
    $$('input[name$="Other"]').forEach((i) => (i.hidden = true));
    $('#prefNameWrap').hidden = true;
    Object.values(pads).forEach((p) => p.clear());
    setPhoto('');
    clearErrors(form);
    form.elements.community.value = keep.community || '';
    form.elements.project.value = keep.project || settings.project || '';
    form.elements.repName.value = keep.repName || settings.rep || '';
    fillDatalist('#communityList', 'community');
    fillDatalist('#projectList', 'project');
  }

  function startForm(keep) {
    resetForm(keep);
    stepIdx = 0;
    showScreen('form');
    history.pushState({ s: 0 }, '');
    renderStep();
  }

  function leaveForm() {
    if (confirm('Leave this form? Anything entered will be lost.')) goHome();
  }

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
      project: val('project'),
      repName: val('repName'),
      repSignature: pads.repSignature.toDataURL(),
      consentDate: val('consentDate'),
      consentTime: val('consentTime'),
    };
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
    rows.push(['THP representative', d.repName]);
    rows.push(['Rep. signature', img(d.repSignature)]);
    rows.push(['Date & time', `${d.consentDate} · ${d.consentTime}`]);
    $('#reviewList').innerHTML = rows.map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${typeof v === 'object' ? v.html : esc(v)}</dd></div>`).join('');
    function img(src) { return src ? { html: `<img src="${src}" alt="">` } : ''; }
  }

  async function saveForm() {
    const data = collect();
    const rec = {
      consentId: data.consentId,
      status: 'pending',
      savedAt: data.createdAt,
      summary: { name: data.fullName, community: data.community, date: data.consentDate, minor: data.isMinor },
      data,
    };
    try { await DB.put(rec); }
    catch (e) { alert('Could not save on this device: ' + e.message); return; }

    remember('community', data.community);
    remember('project', data.project);
    localStorage.setItem('thp-rep-sig', JSON.stringify({ name: data.repName, strokes: pads.repSignature.strokes }));
    settings.rep = data.repName; settings.project = data.project; saveSettings();

    lastKeep = { community: data.community, project: data.project, repName: data.repName };
    $('#doneId').textContent = data.consentId;
    $('#doneMsg').textContent = navigator.onLine
      ? 'Saved on this device. Uploading now…'
      : 'Saved on this device. It will upload automatically when you are back online.';
    showScreen('done');
    syncAll().then(() => {
      DB.all().then((all) => {
        const r = all.find((x) => x.consentId === data.consentId);
        if (r && r.status === 'sent' && !$('#screen-done').hidden) $('#doneMsg').textContent = 'Uploaded to Google Drive ✓';
      });
    });
  }
  let lastKeep = {};

  /* ---------------- sync ---------------- */
  let syncing = false;
  async function postRecord(data) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch(settings.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: settings.key, record: data }),
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
      const pending = (await DB.all()).filter((r) => r.status !== 'sent').sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      for (const r of pending) {
        try {
          const j = await postRecord(r.data);
          r.status = 'sent'; r.pdfUrl = j.pdfUrl || ''; r.sentAt = new Date().toISOString(); r.error = '';
          delete r.data; // remove signatures/photo from the device once safely stored in Drive
          await DB.put(r); sent++;
        } catch (e) {
          r.status = 'error'; r.error = e.name === 'AbortError' ? 'Timed out' : e.message;
          await DB.put(r); failed++;
          if (!e.fatal) break; // network problem: stop and try later
        }
        refreshHome();
      }
      setSyncMsg(failed ? `Some forms could not upload yet (${failed}). They will retry automatically.` : sent ? `Uploaded ${sent} form${sent > 1 ? 's' : ''} ✓` : 'All forms are uploaded.');
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
    const pending = all.filter((r) => r.status !== 'sent');
    $('#statPending').textContent = pending.length;
    $('#statSent').textContent = all.length - pending.length;
    $('#outbox').innerHTML = all.slice(0, 25).map((r) => {
      const badge = r.status === 'sent' ? '<span class="badge sent">Uploaded</span>'
        : r.status === 'error' ? `<span class="badge err" title="${esc(r.error)}">Retry</span>` : '<span class="badge">Waiting</span>';
      const link = r.pdfUrl ? ` · <a href="${esc(r.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : '';
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

  /* ---------------- navigation ---------------- */
  function goHome() { showScreen('home'); refreshHome(); }
  $('#btnNew').addEventListener('click', () => startForm());
  $('#btnNextSame').addEventListener('click', () => startForm(lastKeep));
  $('#btnNextNew').addEventListener('click', () => startForm({ project: lastKeep.project, repName: lastKeep.repName }));
  $('#btnDoneHome').addEventListener('click', goHome);
  $('#btnSync').addEventListener('click', syncAll);
  $('#btnHome').addEventListener('click', () => {
    if (!$('#stepnav').hidden) leaveForm(); else goHome();
  });

  $('#btnSettings').addEventListener('click', () => {
    if (!$('#stepnav').hidden && !confirm('Leave this form? Anything entered will be lost.')) return;
    $('#setUrl').value = settings.url; $('#setKey').value = settings.key;
    $('#setDevice').value = settings.device; $('#setRep').value = settings.rep; $('#setProject').value = settings.project;
    $('#testMsg').textContent = '';
    showScreen('settings');
  });
  function readSettingsForm() {
    settings.url = $('#setUrl').value.trim(); settings.key = $('#setKey').value.trim();
    settings.device = $('#setDevice').value.trim(); settings.rep = $('#setRep').value.trim(); settings.project = $('#setProject').value.trim();
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
  goHome();
  history.replaceState({ home: true }, '');
  syncAll();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
