// Output window: renders the script, owns scroll position, play state and timer.
// Everything moves via one GPU-composited transform inside a single rAF loop.
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const stage = $('stage'), content = $('content'), guide = $('guide');
  const timerEl = $('timer'), progressEl = $('progress'), fillEl = $('progressFill');

  // ---- CuePrompter speed model: 1 px every (40 - speed) ms (browser timers clamp at 4 ms) ----
  const pxPerSec = (speed) => (speed <= 0 ? 0 : 1000 / Math.max(4, 40 - speed));
  const LIMITS = { fontSize: [30, 180], margin: [0, 40], speed: [1, 50], timerSize: [16, 160], readingLine: [0.05, 0.9], lineHeight: [1, 3] };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Motion tuning
  const SPRING_W = 13;          // critically damped spring (rad/s): taps / jumps settle in ~0.35 s
  const AUTO_EASE = 0.12;       // s, easing of play/pause/speed changes
  const HOLD_DELAY = 170;       // ms before a held arrow starts gliding
  const GLIDE_MIN = 260, GLIDE_MAX = 1500, GLIDE_RAMP = 1400; // px/s, ms

  let file = null;
  let S = {};                   // current speaker settings
  let paras = [], tops = [], heights = [];
  let maxY = 0, lineH = 100, readY = 300;

  // motion state: y = base + s ; spring s -> T
  let base = 0, s = 0, v = 0, T = 0;
  let autoVel = 0, glideVel = 0;
  let playing = false;
  const held = new Map();       // dir -> pressedAt

  // timer
  let timerRunning = false, timerAccum = 0, timerStart = 0, timerShown = '';

  // ---------------- layout ----------------
  function applyVisual() {
    root.style.setProperty('--bg', S.bg);
    root.style.setProperty('--fg', S.fg);
    root.style.setProperty('--font-size', S.fontSize + 'px');
    root.style.setProperty('--line-height', S.lineHeight);
    root.style.setProperty('--margin', S.margin + '%');
    root.style.setProperty('--align', S.align || 'left');
    root.style.setProperty('--timer-size', S.timerSize + 'px');
    root.style.setProperty('--read-y', (S.readingLine * 100) + 'vh');
    stage.classList.toggle('mirror-h', !!S.mirrorH);
    stage.classList.toggle('mirror-v', !!S.mirrorV);
    guide.classList.toggle('hidden', !S.showGuide);
    progressEl.classList.toggle('hidden', !S.showProgress);
    timerEl.classList.toggle('hidden', S.showTimer === false);
  }

  function measure() {
    tops = new Array(paras.length); heights = new Array(paras.length);
    for (let i = 0; i < paras.length; i++) { tops[i] = paras[i].offsetTop; heights[i] = paras[i].offsetHeight; }
    lineH = S.fontSize * S.lineHeight;
    readY = S.readingLine * window.innerHeight;
    const total = content.offsetHeight;
    maxY = Math.max(0, total - lineH);
  }

  function paraAt(y) {
    let lo = 0, hi = tops.length - 1, ans = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tops[m] <= y + 1) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  function posOf(y) {
    if (!tops.length) return { para: 0, within: 0 };
    const i = paraAt(y);
    return { para: i, within: heights[i] ? clamp((y - tops[i]) / heights[i], 0, 1) : 0 };
  }
  function yOf(pos) {
    if (!tops.length || !pos) return 0;
    const i = clamp(pos.para | 0, 0, tops.length - 1);
    return tops[i] + (pos.within || 0) * heights[i];
  }
  const targetY = () => base + T;

  // Re-layout while keeping the same text at the reading line.
  function relayout(keepPos = true) {
    const pos = keepPos ? posOf(targetY()) : null;
    applyVisual();
    measure();
    if (pos) setY(yOf(pos));
    lastRendered = NaN;
  }
  function setY(y) { base = clamp(y, 0, maxY); s = v = T = 0; }

  // ---------------- content ----------------
  function render(text) {
    const lines = TPParse.toLines(text);
    content.innerHTML = lines.map(l => '<p>' + TPParse.lineToHtml(l) + '</p>').join('') || '<p>&nbsp;</p>';
    paras = Array.from(content.children);
  }

  function load(p) {
    const same = p.file === file && p.keepPos;
    if (file && p.file !== file) { forceReport = true; report(performance.now(), targetY()); } // final state of previous speaker
    const keepPos = same ? posOf(targetY()) : p.pos;
    file = p.file;
    S = { ...p.settings };
    render(p.text);
    applyVisual();
    measure();
    setY(yOf(keepPos));
    if (!same) {
      playing = false; autoVel = 0; glideVel = 0; held.clear();
      timerRunning = false; timerAccum = p.timerMs || 0;
    }
    lastRendered = NaN; timerShown = '';
    document.fonts && document.fonts.ready.then(() => relayout(true));
  }

  // ---------------- settings ----------------
  function emitSettings() { tp.settings({ file, settings: S }); }
  const LAYOUT_KEYS = new Set(['fontSize', 'lineHeight', 'margin', 'readingLine', 'align']);
  function set(key, value) {
    if (LIMITS[key]) value = clamp(Number(value), LIMITS[key][0], LIMITS[key][1]);
    if (S[key] === value) return;
    S[key] = value;
    if (LAYOUT_KEYS.has(key)) relayout(true); else applyVisual();
    emitSettings();
  }

  // ---------------- actions ----------------
  function act(a) {
    const now = performance.now();
    switch (a.a) {
      case 'togglePlay':
        if (!playing && targetY() >= maxY - 0.5) break;
        playing = !playing; break;
      case 'pause': playing = false; break;
      case 'pauseAll': playing = false; held.clear(); if (timerRunning) toggleTimer(); break;
      case 'nudgePress':
        T += a.dir * lineH;
        held.set(a.dir, now);
        break;
      case 'nudgeRelease': held.delete(a.dir); break;
      case 'releaseAll': held.clear(); break;
      case 'speedBy': set('speed', S.speed + a.d); break;
      case 'para': jumpPara(a.d); break;
      case 'gotoPara': if (tops.length) glideTo(tops[clamp(a.i, 0, tops.length - 1)]); break;
      case 'findGo': findGo(a.q, a.para, a.nth); break;
      case 'home': glideTo(0); break;
      case 'end': glideTo(maxY); playing = false; break;
      case 'setBy': set(a.key, S[a.key] + a.d); break;
      case 'set': set(a.key, a.value); break;
      case 'toggle': set(a.key, !S[a.key]); break;
      case 'toggleAlign': set('align', S.align === 'center' ? 'left' : 'center'); break;
      case 'timerToggle': toggleTimer(); break;
      case 'timerReset': timerAccum = 0; timerStart = now; timerShown = ''; break;
      case 'applySettings': S = { ...a.settings }; relayout(true); emitSettings(); break;
    }
    forceReport = true;
  }
  function glideTo(y) { T += clamp(y, 0, maxY) - targetY(); }
  // Put the n-th match of query inside paragraph `para` exactly on the reading line.
  function findGo(q, para, nth) {
    const p = paras[para];
    if (!p) return;
    const r = TPParse.findAll(p, q)[nth];
    if (!r) { glideTo(tops[para]); return; }
    const rr = r.getClientRects()[0] || r.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    // distance from paragraph top in layout space (stage may be mirrored vertically)
    const dy = S.mirrorV ? pr.bottom - rr.bottom : rr.top - pr.top;
    glideTo(tops[para] + dy + rr.height / 2 - lineH / 2);
  }
  function jumpPara(d) {
    if (!tops.length) return;
    const y = targetY(), i = paraAt(y);
    if (d > 0) glideTo(i + 1 < tops.length ? tops[i + 1] : maxY);
    else glideTo(y - tops[i] > lineH * 0.3 ? tops[i] : tops[Math.max(0, i - 1)]);
  }
  function toggleTimer() {
    const now = performance.now();
    if (timerRunning) { timerAccum += now - timerStart; timerRunning = false; }
    else { timerStart = now; timerRunning = true; }
  }
  const timerMs = () => timerAccum + (timerRunning ? performance.now() - timerStart : 0);
  function fmt(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
  }

  // ---------------- frame loop ----------------
  let last = performance.now(), lastRendered = NaN, lastProg = -1;
  let lastReport = 0, forceReport = true, lastReportKey = '';

  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    // auto-scroll (eased start/stop and speed changes)
    const autoTarget = playing ? pxPerSec(S.speed) : 0;
    autoVel += (autoTarget - autoVel) * (1 - Math.exp(-dt / AUTO_EASE));
    if (Math.abs(autoVel) < 0.01 && !playing) autoVel = 0;

    // hold-to-glide
    let glideTarget = 0;
    for (const [dir, t0] of held) {
      const h = now - t0 - HOLD_DELAY;
      if (h > 0) { const r = Math.min(1, h / GLIDE_RAMP); glideTarget += dir * (GLIDE_MIN + (GLIDE_MAX - GLIDE_MIN) * r * r); }
    }
    glideVel += (glideTarget - glideVel) * (1 - Math.exp(-dt / (glideTarget ? 0.1 : 0.16)));
    if (!glideTarget && Math.abs(glideVel) < 0.5) glideVel = 0;

    base += (autoVel + glideVel) * dt;

    // critically damped spring for taps / jumps (exact solution, frame-rate independent)
    if (T !== 0 || s !== 0 || v !== 0) {
      const x0 = s - T, e = Math.exp(-SPRING_W * dt), c = v + SPRING_W * x0;
      const x1 = (x0 + c * dt) * e;
      v = (v - SPRING_W * c * dt) * e;
      s = T + x1;
      if (Math.abs(x1) < 0.05 && Math.abs(v) < 0.05) { base += T; s = T = v = 0; }
    }

    // clamp to script bounds
    let y = base + s;
    if (y < 0) { base -= y; y = 0; if (glideVel < 0) glideVel = 0; }
    else if (y > maxY) {
      base -= (y - maxY); y = maxY;
      if (glideVel > 0) glideVel = 0;
      if (playing) { playing = false; forceReport = true; }
    }

    if (y !== lastRendered) {
      content.style.transform = `translate3d(0, ${(readY - lineH / 2 - y).toFixed(2)}px, 0)`;
      lastRendered = y;
      const prog = maxY ? y / maxY : 0;
      if (Math.abs(prog - lastProg) > 0.0005) { fillEl.style.transform = `scaleX(${prog.toFixed(4)})`; lastProg = prog; }
    }

    const tStr = fmt(timerMs());
    if (tStr !== timerShown) { timerEl.textContent = tStr; timerShown = tStr; }

    if (file && (forceReport || now - lastReport > 100)) report(now, y);
    requestAnimationFrame(frame);
  }

  function report(now, y) {
    lastReport = now;
    const pos = posOf(y);
    const r = {
      file, pos, para: pos.para, paraCount: tops.length,
      progress: maxY ? y / maxY : 0,
      timerMs: Math.floor(timerMs()), timerRunning, playing, speed: S.speed,
    };
    const key = [pos.para, pos.within.toFixed(3), Math.floor(r.timerMs / 1000), timerRunning, playing, S.speed].join('|');
    if (key === lastReportKey && !forceReport) return;
    lastReportKey = key; forceReport = false;
    tp.report(r);
  }

  // ---------------- input ----------------
  function dispatch(a) {
    if (!a) return;
    if (TPKeys.MAIN_ACTIONS.has(a.a)) tp.action(a); else act(a);
  }
  window.addEventListener('keydown', (e) => { const a = TPKeys.keyToAction(e, 'down'); if (a) { e.preventDefault(); dispatch(a); } });
  window.addEventListener('keyup', (e) => { const a = TPKeys.keyToAction(e, 'up'); if (a) { e.preventDefault(); dispatch(a); } });
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    T += e.deltaMode === 1 ? e.deltaY * lineH / 3 : e.deltaY;
  }, { passive: false });
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => relayout(true));
  });

  tp.on('load', load);
  tp.on('action', act);

  S = { fontSize: 72, lineHeight: 1.8, margin: 12, readingLine: 0.35, timerSize: 48, bg: '#000000', fg: '#ffffff', speed: 24, align: 'left', showGuide: true, showProgress: true };
  applyVisual(); measure();
  requestAnimationFrame(frame);
  tp.ready('output');
})();
