// PLAYTEST-LINK — engine-agnostic player↔BMO debugging bridge for canvas games.
//
//   PlaytestLink.init({
//     canvas,                          // the game's render canvas (2D or WebGL)
//     endpoint: '/sxs-assets/api',     // relay base (POST {endpoint}/invoke)
//     game: 'hullrot',                 // bundle tag
//     getState: () => ({...}),         // small JSON snapshot, sampled 4x/sec
//     getAim: () => 'door(12,7) 3.1m', // optional: what's under the crosshair
//     keys: { mark: 'KeyM', invoke: 'KeyT' },
//     onOverlay: (open) => {},         // optional: pause input handling etc.
//   });
//   PlaytestLink.event('husk_bite', { hp: 42 });   // games push gameplay facts
//
// What the player gets: M drops a timestamped mark, T (or the 📣 button) opens
// a one-line report box. On send, BMO receives: the last ~15-30s of video, the
// state timeline, the event log, all marks, the crosshair target, and the words.
window.PlaytestLink = (() => {
  let cfg = null;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const states = [];   // {t, ...state} @4Hz, 30s window
  const events = [];   // {t, name, data}, last 80
  const marks = [];    // {t, state, aim}
  const errors = [];   // {t, type, msg, stack} — automatic, zero game cooperation
  let recA = null, recB = null, chunksA = [], chunksB = [], liveIsA = true;
  let stream = null, ui = {}, busy = false;

  function startRec(useA) {
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: cfg.bitrate || 900000 });
    const bucket = useA ? chunksA : chunksB;
    bucket.length = 0;
    rec.ondataavailable = (e) => { if (e.data.size) bucket.push(e.data); };
    rec.start(1000);
    return rec;
  }
  function cycleRecorders() { // double-buffer: always ≥15s of playable webm available
    liveIsA = !liveIsA;
    const old = liveIsA ? recB : recA;
    if (liveIsA) recA = startRec(true); else recB = startRec(false);
    setTimeout(() => { try { old && old.state !== 'inactive' && old.stop(); } catch {} }, 5500);
  }

  function pushError(entry) {
    errors.push(entry);
    if (errors.length > 20) errors.shift();
    if (cfg && cfg.autoReportCrashes && entry.type !== 'console.error' && !busy) {
      // one automatic bundle per session on the first real crash
      cfg.autoReportCrashes = false;
      setTimeout(() => { ui.input.value = '(automatic crash report)'; send(); }, 400);
    }
  }
  function hookErrors() {
    addEventListener('error', (e) => pushError({
      t: now(), type: 'error', msg: String(e.message || '').slice(0, 300),
      src: `${e.filename || ''}:${e.lineno || 0}`,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1500) : null,
    }));
    addEventListener('unhandledrejection', (e) => pushError({
      t: now(), type: 'unhandledrejection',
      msg: String((e.reason && e.reason.message) || e.reason || '').slice(0, 300),
      stack: e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 1500) : null,
    }));
    const orig = console.error.bind(console);
    console.error = (...args) => {
      pushError({ t: now(), type: 'console.error',
        msg: args.map((a) => String((a && a.stack) || a)).join(' ').slice(0, 500) });
      orig(...args);
    };
  }

  // Standardized __game adapter: if the game exposes window.__game (the hook
  // contract in AGENT-INSTRUCTIONS.md) and no getState was supplied, derive
  // one automatically from its scalar/array getters.
  function adaptGameHook() {
    const KEYS = ['phase', 'hp', 'ammo', 'zone', 'room', 'x', 'y', 'pos', 'yaw', 'frags', 'level', 'score'];
    return () => {
      const g = window.__game;
      if (!g) return null;
      const s = {};
      for (const k of KEYS) {
        try {
          const v = g[k];
          if (v === undefined || v === null) continue;
          if (typeof v === 'function' || (typeof v === 'object' && !Array.isArray(v))) continue;
          s[k] = Array.isArray(v) && v.length > 8 ? v.length : v;
        } catch {}
      }
      return Object.keys(s).length ? s : null;
    };
  }

  function toast(msg, ms = 1800, action) {
    ui.toast.textContent = msg;
    ui.toast.style.display = 'block';
    ui.toast.onclick = action || null;
    ui.toast.style.cursor = action ? 'pointer' : 'default';
    if (ms) setTimeout(() => { ui.toast.style.display = 'none'; }, ms);
  }

  function mark() {
    marks.push({ t: now(), state: safeState(), aim: safeAim() });
    toast(`◈ marked (${marks.length}) — T to report`);
  }

  const safeState = () => { try { return cfg.getState ? cfg.getState() : null; } catch { return null; } };
  const safeAim = () => { try { return cfg.getAim ? cfg.getAim() : null; } catch { return null; } };

  function openBox() {
    if (busy) return;
    ui.box.style.display = 'flex';
    setTimeout(() => ui.input.focus(), 0); // after the opening keystroke resolves
    cfg.onOverlay && cfg.onOverlay(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closeBox() {
    ui.box.style.display = 'none';
    ui.input.value = '';
    cfg.onOverlay && cfg.onOverlay(false);
  }

  async function send() {
    if (busy) return;
    busy = true;
    ui.send.disabled = true;
    toast('sending to BMO…', 0);
    try {
      // freeze both recorders' current footage
      const blobs = [];
      for (const [rec, bucket] of [[recA, chunksA], [recB, chunksB]]) {
        if (!rec) continue;
        if (rec.state !== 'inactive') { rec.requestData(); await new Promise((r) => setTimeout(r, 120)); }
        if (bucket.length) blobs.push(new Blob(bucket, { type: 'video/webm' }));
      }
      const meta = {
        game: cfg.game, t: now(), url: location.href, ua: navigator.userAgent.slice(0, 80),
        complaint: ui.input.value.trim() || '(no text — see marks/clip)',
        aim: safeAim(), snapshot: safeState(),
        marks, events: events.slice(-80), states: states.slice(-120), errors: errors.slice(-20),
      };
      const clips = await Promise.all(blobs.map((b) => new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(',')[1]);
        fr.readAsDataURL(b);
      })));
      const r = await fetch(cfg.endpoint + '/invoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta, clips }),
      });
      if (!r.ok) throw new Error('relay ' + r.status);
      toast('✓ delivered — BMO is on it', 3200);
      marks.length = 0;
      closeBox();
    } catch (e) {
      toast('✗ send failed — tell BMO in discord', 4000);
    }
    ui.send.disabled = false;
    busy = false;
  }

  function buildUI() {
    const css = document.createElement('style');
    css.textContent = `
      #ptl-btn { position:absolute; top:8px; right:8px; z-index:40; width:34px; height:34px;
        border-radius:50%; border:1px solid #7a5a28; background:rgba(20,17,12,0.75); color:#ffb03a;
        font-size:16px; cursor:pointer; }
      #ptl-toast { position:absolute; top:50px; right:8px; z-index:40; display:none; max-width:70%;
        background:rgba(20,17,12,0.92); border:1px solid #7a5a28; color:#ffb03a; padding:8px 12px;
        font:11px 'Courier New',monospace; letter-spacing:1px; }
      #ptl-box { position:absolute; inset:auto 8px 8px 8px; z-index:41; display:none; gap:6px;
        background:rgba(10,9,7,0.95); border:1px solid #ffb03a; padding:10px; }
      #ptl-box input { flex:1; background:#0e0c08; border:1px solid #33291a; color:#ffb03a;
        font:12px 'Courier New',monospace; padding:9px; }
      #ptl-box button { background:#2b1f0d; border:1px solid #ffb03a; color:#ffb03a;
        font:11px 'Courier New',monospace; letter-spacing:1px; padding:9px 12px; cursor:pointer; }`;
    document.head.appendChild(css);
    const host = cfg.canvas.parentElement || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    ui.btn = document.createElement('button');
    ui.btn.id = 'ptl-btn'; ui.btn.textContent = '📣'; ui.btn.title = 'report to BMO (T) · mark (M)';
    ui.btn.onclick = openBox;
    ui.toast = document.createElement('div'); ui.toast.id = 'ptl-toast';
    ui.box = document.createElement('div'); ui.box.id = 'ptl-box';
    ui.input = document.createElement('input');
    ui.input.placeholder = "what's wrong? BMO gets your last 15s + game state…";
    ui.send = document.createElement('button'); ui.send.textContent = 'SEND';
    ui.send.onclick = send;
    const cancel = document.createElement('button'); cancel.textContent = '✕';
    cancel.onclick = closeBox;
    ui.box.append(ui.input, ui.send, cancel);
    host.append(ui.btn, ui.toast, ui.box);
    ui.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') send();
      if (e.key === 'Escape') closeBox();
    });
  }

  function watchVersion() {
    let base = null;
    setInterval(async () => {
      try {
        const v = await (await fetch(cfg.version + '?t=' + Date.now(), { cache: 'no-store' })).text();
        if (base === null) base = v;
        else if (v !== base) {
          base = v;
          toast('⟳ BMO patched the game — tap to reload', 0, () => location.reload());
        }
      } catch {}
    }, 20000);
  }

  return {
    init(c) {
      cfg = c;
      cfg.keys = c.keys || { mark: 'KeyM', invoke: 'KeyT' };
      if (!cfg.getState) cfg.getState = adaptGameHook(); // standardized __game shape
      hookErrors();
      stream = cfg.canvas.captureStream(cfg.fps || 15);
      recA = startRec(true);
      liveIsA = true;
      setInterval(cycleRecorders, (cfg.clipSec || 6) * 1000); // window = clipSec..2x clipSec
      setInterval(() => {
        const s = safeState();
        if (s) { states.push({ t: now(), ...s }); if (states.length > 130) states.shift(); }
      }, 250);
      buildUI();
      if (cfg.version) watchVersion();
      addEventListener('keydown', (e) => {
        if (ui.box.style.display === 'flex') return;
        if (e.code === cfg.keys.mark) mark();
        if (e.code === cfg.keys.invoke) { e.preventDefault(); openBox(); }
      });
    },
    // one-line setup for generated projects: PlaytestLink.auto({ endpoint, game })
    // — largest canvas, __game adapter, defaults for everything else.
    auto(overrides = {}) {
      const canvases = [...document.querySelectorAll('canvas')];
      const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!canvas) return setTimeout(() => this.auto(overrides), 800);
      const big = canvas.width * canvas.height > 600000;
      this.init({
        canvas,
        endpoint: overrides.endpoint || 'playtest-api',
        game: overrides.game || (document.title || 'game').toLowerCase().replace(/\W+/g, '-').slice(0, 24),
        fps: big ? 8 : 15, bitrate: big ? 550000 : 900000, clipSec: 6,
        autoReportCrashes: true,
        ...overrides,
      });
    },
    event(name, data) {
      events.push({ t: now(), name, data });
      if (events.length > 90) events.shift();
    },
    mark, // programmatic
  };
})();
