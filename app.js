// Handwriting test page. Plain JS, no build step.
// Ink is used only to evaluate a recogniser. Nothing leaves the device except
// the submissions sent to SUBMIT_URL (see config.js).
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const DEBUG = params.get('debug') === '1';
  const PREFIX = DEBUG ? 'ww_debug_' : 'ww_';
  const $ = (id) => document.getElementById(id);

  // ---------- storage (every access guarded) ----------
  const store = {
    get(k) {
      try { const v = localStorage.getItem(PREFIX + k); return v == null ? null : JSON.parse(v); }
      catch (e) { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; }
      catch (e) { return false; }
    },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } },
  };
  if (DEBUG && params.get('reset') === '1') { store.del('session'); store.del('queue'); }

  // ---------- ordering (pure) ----------
  function hashSeed(str) { // FNV-1a, 32 bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // Block randomisation: round r holds the r-th (shuffled) prompt of every
  // category, with the category order shuffled within each round.
  function buildOrder(writerId, prompts) {
    const seed = hashSeed(writerId);
    const rnd = mulberry32(seed);
    const cats = [];
    const byCat = {};
    prompts.forEach((p) => {
      if (!byCat[p.category]) { byCat[p.category] = []; cats.push(p.category); }
      byCat[p.category].push(p.id);
    });
    const shuffled = {};
    cats.forEach((c) => { shuffled[c] = shuffle(byCat[c], rnd); });
    const rounds = Math.min.apply(null, cats.map((c) => shuffled[c].length));
    const order = [];
    for (let r = 0; r < rounds; r++) {
      shuffle(cats, rnd).forEach((c) => order.push(shuffled[c][r]));
    }
    return { seed: seed, order: order };
  }
  function selfTestOrder(prompts) {
    const catOf = {};
    prompts.forEach((p) => { catOf[p.id] = p.category; });
    const ncat = new Set(prompts.map((p) => p.category)).size;
    const problems = [];
    for (let n = 0; n < 500; n++) {
      const id = 'test-' + n + '-' + Math.random();
      const o = buildOrder(id, prompts);
      if (new Set(o.order).size !== prompts.length || o.order.length !== prompts.length) problems.push('not a permutation: ' + id);
      for (let b = 0; b + ncat <= o.order.length; b += ncat) {
        if (new Set(o.order.slice(b, b + ncat).map((x) => catOf[x])).size !== ncat) problems.push('block ' + b + ' repeats a category: ' + id);
      }
      if (JSON.stringify(buildOrder(id, prompts).order) !== JSON.stringify(o.order)) problems.push('not deterministic: ' + id);
    }
    return problems;
  }

  // ---------- helpers ----------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  async function sha256Hex(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
    } catch (e) { return 'unavailable'; }
  }
  const POINT_FIELDS = ['x', 'y', 't', 'pressure', 'tiltX', 'tiltY', 'altitudeAngle', 'azimuthAngle'];
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const r3 = (n) => Math.round(n * 1000) / 1000;

  function show(screen) {
    ['screen-welcome', 'screen-write', 'screen-done'].forEach((id) => { $(id).hidden = id !== screen; });
  }
  function confirmDialog(text, yes, no) {
    return new Promise((resolve) => {
      $('modal-text').textContent = text;
      $('modal-yes').textContent = yes;
      $('modal-no').textContent = no;
      $('modal').hidden = false;
      const done = (v) => {
        $('modal').hidden = true;
        $('modal-yes').onclick = $('modal-no').onclick = null;
        resolve(v);
      };
      $('modal-yes').onclick = () => done(true);
      $('modal-no').onclick = () => done(false);
    });
  }

  // ---------- state ----------
  let prompts = [];
  let promptById = {};
  let consentText = '';     // after name substitution
  let consentHash = '';
  let session = null;       // see startSession()
  let queue = [];           // submissions not yet sent
  const allSubs = {};       // prompt_id -> submission, this page load (for "save a file")

  function persistSession() { store.set('session', session); }
  function persistQueue() { store.set('queue', queue); }

  // ---------- welcome ----------
  function renderConsent(text) {
    const box = $('consent');
    box.textContent = '';
    const parts = text.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
    parts.forEach((part, i) => {
      const el = document.createElement(i === 0 ? 'h1' : 'p');
      el.textContent = part.trim();
      box.appendChild(el);
    });
  }

  let handedness = null;
  function setHand(h) {
    handedness = handedness === h ? null : h;
    $('hand-left').setAttribute('aria-pressed', String(handedness === 'left'));
    $('hand-right').setAttribute('aria-pressed', String(handedness === 'right'));
  }
  function applyHand() {
    // Controls go on the side away from the writing hand. Default: right-handed layout.
    $('controls').className = 'controls ' + (session && session.handedness === 'left' ? 'side-right' : 'side-left');
  }

  function startSession() {
    const id = uuid();
    const o = buildOrder(id, prompts);
    session = {
      writer_id: id,
      seed: o.seed,
      order: o.order,
      handedness: handedness,
      share_handedness: true,
      index: 0,
      finished: false,
      consent_version: CONSENT_VERSION,
      consent_sha256: consentHash,
      started_at: new Date().toISOString(),
      hint_seen: false,
    };
    if (!store.set('session', session)) {
      $('load-error').textContent = 'This browser could not save your writer ID. Allow site storage or try another browser.';
      $('load-error').hidden = false;
      session = null;
      return;
    }
    beginWriting();
  }

  // ---------- writing ----------
  const canvas = $('canvas');
  const area = $('area');
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let strokes = [];
  let cur = null;           // stroke being drawn
  let activeId = null;
  let curRect = null;
  let promptReady = false;
  let pendingSave = null;
  let penSeen = false;
  let promptStart = 0;
  let startedAt = '';
  let undoCount = 0;
  let clearCount = 0;
  let areaW0 = 0, areaH0 = 0, areaResized = false;
  let noteTimer = null;
  let penColor = '#111';
  let busy = false;         // keep the ink intact while a failed save is retried

  function readPenColor() {
    penColor = getComputedStyle(document.documentElement).getPropertyValue('--pen').trim() || '#111';
  }
  function sizeCanvas() {
    const w = area.clientWidth, h = area.clientHeight;
    if (!w || !h) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    redraw();
  }
  function styleCtx() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = 2.8; ctx.strokeStyle = penColor; ctx.fillStyle = penColor;
  }
  // A point is [x, y, t, pressure, tiltX, tiltY, altitudeAngle, azimuthAngle] (see POINT_FIELDS).
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  function dot(p) { ctx.beginPath(); ctx.arc(p[0], p[1], 1.6, 0, Math.PI * 2); ctx.fill(); }
  function drawFull(pts) {
    if (pts.length === 1) { dot(pts[0]); return; }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.stroke();
  }
  // Draw only the newest piece of the stroke (smooth through midpoints).
  function drawTail(pts) {
    const n = pts.length;
    if (n === 1) { dot(pts[0]); return; }
    ctx.beginPath();
    if (n === 2) {
      const m = mid(pts[0], pts[1]);
      ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(m[0], m[1]);
    } else {
      const a = mid(pts[n - 3], pts[n - 2]);
      const b = mid(pts[n - 2], pts[n - 1]);
      ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(pts[n - 2][0], pts[n - 2][1], b[0], b[1]);
    }
    ctx.stroke();
  }
  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    styleCtx();
    strokes.forEach((s) => drawFull(s.points));
  }

  function showNote(text) {
    const n = $('note');
    n.textContent = text; n.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { n.hidden = true; }, 3000);
  }
  function timeOf(e) {
    // Event timestamps share performance.now()'s clock in current browsers.
    const ts = e.timeStamp > 1e11 ? performance.now() : e.timeStamp;
    return r1(ts - promptStart);
  }
  // Compact points keep long sessions well inside browser storage limits.
  function makePoint(e) {
    return [
      r2(e.clientX - curRect.left),
      r2(e.clientY - curRect.top),
      timeOf(e),
      r3(e.pressure),
      e.tiltX || 0,
      e.tiltY || 0,
      typeof e.altitudeAngle === 'number' ? r3(e.altitudeAngle) : null,
      typeof e.azimuthAngle === 'number' ? r3(e.azimuthAngle) : null,
    ];
  }
  function accepts(e) { return DEBUG || e.pointerType === 'pen'; }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (!accepts(e)) {
      e.preventDefault();
      if (e.pointerType === 'touch' && !penSeen) showNote('Please use a stylus');
      return;
    }
    if (activeId !== null || busy || !promptReady) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    activeId = e.pointerId;
    curRect = canvas.getBoundingClientRect();
    cur = { pointer_type: e.pointerType, points: [makePoint(e)] };
    strokes.push(cur);
    styleCtx();
    drawTail(cur.points);
    $('hint').hidden = true;
    if (!session.hint_seen) { session.hint_seen = true; persistSession(); }
    updateButtons();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerId !== activeId || !cur) return;
    e.preventDefault();
    const list = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const evs = list.length ? list : [e];
    for (let i = 0; i < evs.length; i++) {
      // iPad Safari repeats coalesced samples already delivered with the previous
      // move event. Keep each sample once, in time order.
      const t = timeOf(evs[i]);
      if (t <= cur.points[cur.points.length - 1][2]) continue;
      cur.points.push(makePoint(evs[i]));
      drawTail(cur.points);
    }
  });
  function endStroke(e) {
    if (e.pointerId !== activeId || !cur) return;
    if (e.type === 'pointerup' && cur.points.length > 1) {
      // Include the final position if it differs from the last coalesced sample.
      const last = cur.points[cur.points.length - 1];
      const p = makePoint(e);
      if ((p[0] !== last[0] || p[1] !== last[1]) && p[2] > last[2]) {
        cur.points.push(p);
        drawTail(cur.points);
      }
      const n = cur.points.length;
      const m = mid(cur.points[n - 2], cur.points[n - 1]);
      ctx.beginPath(); ctx.moveTo(m[0], m[1]);
      ctx.lineTo(p[0], p[1]); ctx.stroke();
    }
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    activeId = null; cur = null; curRect = null;
    updateButtons();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('lostpointercapture', endStroke);

  // Stop browser interference.
  ['contextmenu', 'dragstart', 'gesturestart', 'gesturechange'].forEach((t) => {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  });
  $('screen-write').addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });

  function updateButtons() {
    const has = strokes.length > 0 && !busy && activeId === null && promptReady;
    $('skip').disabled = busy || activeId !== null || !promptReady;
    $('finish').disabled = busy || activeId !== null;
    $('undo').disabled = !has;
    $('clear').disabled = !has;
    $('next').disabled = !has;
  }

  function fitPrompt() {
    const el = $('prompt');
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    const inner = el.firstElementChild;
    if (!inner) return;
    const avail = el.clientWidth - 8;
    let guard = 0;
    while (inner.scrollWidth > avail && size > 14 && guard++ < 60) {
      size -= 1; el.style.fontSize = size + 'px';
    }
  }
  async function renderPrompt(p) {
    promptReady = false;
    $('render-retry').hidden = true;
    const el = $('prompt');
    el.textContent = '';
    const holder = document.createElement('div');
    el.appendChild(holder);
    try {
      window.katex.render(p.latex, holder, { displayMode: true, throwOnError: true });
      if (getComputedStyle(holder.querySelector('.katex-mathml')).position !== 'absolute') {
        throw new Error('KaTeX stylesheet unavailable');
      }
      holder.getBoundingClientRect(); // Trigger font loading before enabling pen input.
      await document.fonts.ready;
      if (Array.from(document.fonts).some((font) => font.family.includes('KaTeX') && font.status === 'error')) {
        throw new Error('KaTeX font unavailable');
      }
      promptReady = true;
    } catch (err) {
      holder.textContent = 'The maths could not be displayed.';
      $('render-retry').hidden = false;
      console.error('Prompt unavailable', p.id, err);
    }
    updateButtons();
    const ins = $('instruction');
    // Always occupy the line so the controls do not jump between prompts.
    ins.textContent = p.instruction || '\u00a0';
    requestAnimationFrame(fitPrompt);
  }

  function loadPrompt() {
    busy = false;
    const p = promptById[session.order[session.index]];
    strokes = []; cur = null; activeId = null;
    undoCount = 0; clearCount = 0; areaResized = false;
    renderPrompt(p);
    $('progress').textContent = (session.index + 1) + ' of ' + session.order.length;
    $('hint').hidden = session.hint_seen || session.index !== 0;
    $('note').hidden = true;
    updateButtons();
    sizeCanvas();
    areaW0 = area.clientWidth; areaH0 = area.clientHeight;
    promptStart = performance.now();
    startedAt = new Date().toISOString();
  }

  function beginWriting() {
    show('screen-write');
    applyHand();
    $('writing-id').textContent = 'Writer ID ' + session.writer_id.slice(0, 8);
    $('mode-note').textContent = (SUBMIT_URL ? '' : 'Test mode: nothing is uploaded') + (DEBUG ? (SUBMIT_URL ? '' : ' · ') + 'debug' : '');
    readPenColor();
    if (session.index >= session.order.length) { finishSession(); return; }
    loadPrompt();
  }

  function orientationName() {
    try { if (screen.orientation && screen.orientation.type) return screen.orientation.type; } catch (e) { /* ignore */ }
    return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
  }
  function buildSubmission(skipped) {
    const p = promptById[session.order[session.index]];
    return {
      writer_id: session.writer_id,
      prompt_id: p.id,
      prompt_latex: p.latex,
      ...(session.share_handedness && { handedness: session.handedness }),
      position: session.index + 1,
      order: session.order,
      seed: session.seed,
      consent_version: session.consent_version,
      consent_sha256: session.consent_sha256,
      page_version: PAGE_VERSION,
      point_fields: POINT_FIELDS,
      debug: DEBUG,
      undo_count: undoCount,
      clear_count: clearCount,
      skipped: skipped,
      started_at: startedAt,
      submitted_at: new Date().toISOString(),
      area_width: areaW0,
      area_height: areaH0,
      area_width_at_submit: area.clientWidth,
      area_height_at_submit: area.clientHeight,
      area_resized: areaResized,
      device_pixel_ratio: window.devicePixelRatio || 1,
      screen_width: screen.width,
      screen_height: screen.height,
      orientation: orientationName(),
      user_agent: navigator.userAgent,
      max_touch_points: navigator.maxTouchPoints || 0,
      strokes: skipped ? [] : strokes,
    };
  }
  // Write the ink before the progress marker. A retry replaces the same
  // writer/position, including after an interrupted progress write.
  function saveAndAdvance(skipped, finish) {
    if (activeId !== null || (!finish && !promptReady)) return;
    const sub = skipped || strokes.length ? buildSubmission(skipped) : null;
    if (sub) {
      const nextQueue = queue.filter((q) => q.writer_id !== sub.writer_id || q.position !== sub.position);
      nextQueue.push(sub);
      if (!store.set('queue', nextQueue)) return saveFailed(skipped, finish);
      queue = nextQueue;
      allSubs[sub.prompt_id] = sub;
    }
    const index = finish ? session.order.length : session.index + 1;
    const nextSession = { ...session, index, finished: index >= session.order.length };
    if (!store.set('session', nextSession)) return saveFailed(skipped, finish);
    session = nextSession;
    pendingSave = null;
    $('save-error').hidden = true;
    if (session.finished) finishSession(); else loadPrompt();
    flush();
  }

  function saveFailed(skipped, finish) {
    busy = true;
    pendingSave = { skipped, finish };
    $('save-error').hidden = false;
    updateButtons();
  }
  $('save-retry').onclick = () => {
    if (pendingSave) saveAndAdvance(pendingSave.skipped, pendingSave.finish);
  };
  $('render-retry').onclick = () => location.reload();
  $('next').onclick = () => { if (!busy && strokes.length) saveAndAdvance(false, false); };
  $('skip').onclick = () => { if (!busy) saveAndAdvance(true, false); };
  $('undo').onclick = () => {
    if (!strokes.length || activeId !== null) return;
    strokes.pop(); undoCount++; redraw(); updateButtons();
  };
  $('clear').onclick = async () => {
    if (!strokes.length || activeId !== null) return;
    if (await confirmDialog('Clear everything you wrote?', 'Clear', 'Keep')) {
      strokes = []; clearCount++; redraw(); updateButtons();
    }
  };
  $('finish').onclick = async () => {
    if (await confirmDialog('Finish now? What you have written is kept.', 'Finish', 'Keep going')) {
      if (!busy) saveAndAdvance(false, true);
    }
  };
  $('hand-left').onclick = () => setHand('left');
  $('hand-right').onclick = () => setHand('right');
  $('agree').onchange = () => { $('start').disabled = !$('agree').checked || !consentHash; };
  $('start').onclick = () => { if ($('agree').checked && consentHash) startSession(); };

  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if ($('screen-write').hidden) return;
      if (area.clientWidth !== areaW0 || area.clientHeight !== areaH0) areaResized = true;
      sizeCanvas();
      fitPrompt();
    }).observe(area);
  } else {
    window.addEventListener('resize', () => { sizeCanvas(); fitPrompt(); });
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { readPenColor(); if (!$('screen-write').hidden) redraw(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
  }

  // ---------- upload ----------
  let flushing = false;
  async function post(sub) {
    const ctl = window.AbortController ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 25000) : null;
    try {
      const res = await fetch(SUBMIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(sub),
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res.ok) return 'retry';
      const j = await res.json();
      return j && j.ok === true ? 'ok' : 'rejected';
    } catch (e) {
      return 'retry'; // offline, timeout, unreadable reply
    } finally { if (timer) clearTimeout(timer); }
  }
  async function flush() {
    if (!SUBMIT_URL || flushing) return;
    flushing = true;
    try {
      const snapshot = queue.slice();
      for (const sub of snapshot) {
        const r = await post(sub);
        if (r === 'ok') { queue = queue.filter((q) => q !== sub); persistQueue(); updateUploadState(); }
        else if (r === 'retry') break; // network trouble: try again later
        // 'rejected' stays queued and is retried later
      }
    } finally { flushing = false; updateUploadState(); }
  }
  setInterval(flush, 20000);
  window.addEventListener('online', flush);

  // ---------- done ----------
  function updateUploadState() {
    if ($('screen-done').hidden) return;
    const el = $('upload-state');
    const pending = queue.filter((q) => q.writer_id === session.writer_id).length;
    if (!SUBMIT_URL) {
      el.textContent = 'Test mode: nothing was uploaded.';
      $('retry').hidden = true;
    } else if (pending === 0) {
      el.textContent = 'All saved';
      $('retry').hidden = true;
    } else {
      el.textContent = pending + ' not sent yet';
      $('retry').hidden = false;
    }
  }
  function finishSession() {
    session.finished = true;
    persistSession();
    show('screen-done');
    $('id-short').textContent = session.writer_id.slice(0, 8);
    $('id-full').textContent = session.writer_id;
    updateUploadState();
    flush();
  }
  $('retry').onclick = () => { $('upload-state').textContent = 'Sending...'; flush(); };
  $('copy-id').onclick = async () => {
    const id = session.writer_id;
    let ok = false;
    try { await navigator.clipboard.writeText(id); ok = true; } catch (e) { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = id; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch (e) { /* ignore */ }
    }
    $('copy-id').textContent = ok ? 'Copied' : 'Select the ID and copy it';
    setTimeout(() => { $('copy-id').textContent = 'Copy'; }, 2500);
  };
  function downloadWriting() {
    const subs = {};
    queue.filter((s) => s.writer_id === session.writer_id).forEach((s) => { subs[s.prompt_id] = s; });
    Object.keys(allSubs).forEach((k) => { subs[k] = allSubs[k]; });
    if (pendingSave && (strokes.length || pendingSave.skipped)) {
      const sub = buildSubmission(pendingSave.skipped);
      subs[sub.prompt_id] = sub;
    }
    const list = Object.keys(subs).map((k) => subs[k]).sort((a, b) => a.position - b.position);
    const out = {
      writer_id: session.writer_id,
      page_version: PAGE_VERSION,
      consent_version: session.consent_version,
      consent_sha256: session.consent_sha256,
      debug: DEBUG,
      saved_at: new Date().toISOString(),
      submissions: list,
    };
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'handwriting-' + session.writer_id.slice(0, 8) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $('save-file').onclick = downloadWriting;
  $('save-backup').onclick = downloadWriting;
  setInterval(updateUploadState, 1500);
  // A shared tablet: start a fresh writer with a new ID. Unsent submissions stay queued and keep retrying.
  $('new-writer').onclick = async () => {
    if (!(await confirmDialog('Start again for a new person? They get their own ID.', 'Start again', 'Cancel'))) return;
    store.del('session');
    session = null;
    Object.keys(allSubs).forEach((k) => { delete allSubs[k]; });
    handedness = null;
    setHand(null);
    $('agree').checked = false;
    $('agree').onchange();
    show('screen-welcome');
  };

  // ---------- boot ----------
  async function boot() {
    show('screen-welcome');
    try {
      const [pr, cr] = await Promise.all([fetch('prompts.json'), fetch('consent.txt')]);
      if (!pr.ok || !cr.ok) throw new Error('fetch failed');
      prompts = (await pr.json()).prompts;
      const raw = await cr.text();
      consentText = raw.split('[NAME]').join(OWNER_NAME);
      consentHash = await sha256Hex(consentText);
    } catch (e) {
      $('load-error').textContent = 'Could not load the page files. Please reload.';
      $('load-error').hidden = false;
      return;
    }
    promptById = {};
    prompts.forEach((p) => { promptById[p.id] = p; });
    renderConsent(consentText);
    $('agree').onchange();

    if (DEBUG) {
      const problems = selfTestOrder(prompts);
      console.log(problems.length ? 'order self-test FAILED' : 'order self-test passed', problems);
    }

    const saved = store.get('session');
    const q = store.get('queue');
    if (Array.isArray(q)) {
      queue = q;
      // Draft clients included the layout preference in queued submissions.
      for (const sub of queue) {
        if (['web-writer-consent-v1-draft', 'web-writer-consent-v2'].includes(sub.consent_version)) delete sub.handedness;
      }
    }
    if (saved && Array.isArray(saved.order) && saved.order.every((id) => promptById[id])) {
      session = saved;
      handedness = session.handedness || null;
      if (session.finished || session.index >= session.order.length) { finishSession(); }
      else { beginWriting(); }
      flush();
    }
  }
  window.WW = { buildOrder: buildOrder, hashSeed: hashSeed, selfTestOrder: selfTestOrder };
  boot();
})();
