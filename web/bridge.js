// GlidePrompter web bridge: stands in for Electron's preload + main process in the browser.
// The Control page (index.html) acts as the "main process": it owns scripts + profiles
// (stored in localStorage) and talks to the Output popup over a BroadcastChannel.
// output.js and control.js are the exact same files as in the desktop app.
(function () {
  const ROLE = document.documentElement.dataset.role;        // 'control' | 'output'
  const bus = new BroadcastChannel('glideprompter');
  const listeners = {};
  const on = (c, fn) => (listeners[c] = listeners[c] || []).push(fn);
  const emit = (c, d) => (listeners[c] || []).forEach(fn => fn(d));

  // ======================= Output popup =======================
  if (ROLE === 'output') {
    const post = (m) => bus.postMessage({ from: 'output', ...m });
    bus.onmessage = (e) => {
      const m = e.data || {};
      if (m.to !== 'output') return;
      if (m.type === 'hello') post({ type: 'ready' });          // control (re)loaded
      else emit(m.ch, m.data);
    };
    const toggleFs = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', () => post({ type: 'fs', on: !!document.fullscreenElement }));
    document.addEventListener('dblclick', toggleFs);
    // Browsers pause windows that are minimised or fully covered: tell the control page.
    const vis = () => post({ type: 'vis', hidden: document.visibilityState === 'hidden' });
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', () => post({ type: 'bye' }));
    window.tp = {
      ready: () => { post({ type: 'ready' }); vis(); },
      action: (a) => (a && a.a === 'fullscreen' ? toggleFs() : post({ type: 'action', a })),
      report: (r) => post({ type: 'report', r }),
      settings: (s) => post({ type: 'settings', s }),
      on,
    };
    return;
  }

  // ======================= Control page = host =======================
  const DEFAULTS = window.TPDefaults;
  const SETTING_KEYS = Object.keys(DEFAULTS);
  const MAIN_ACTIONS = new Set(['speaker', 'speakerFile', 'fullscreen', 'onTop', 'display', 'size1080', 'showOutput', 'saveDefault', 'resetDefault', 'focusSearch', 'searchNav']);
  const KEY = 'glideprompter.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (err) { console.error('storage', err); } },
  };

  let scripts = {};            // file name -> text
  let profiles = null;
  let speakers = [];
  let current = null;
  let outReady = false, outFs = false, outWin = null;

  const sendCtl = (c, d) => Promise.resolve().then(() => emit(c, d));       // async, like IPC
  const sendOut = (c, d) => bus.postMessage({ to: 'output', ch: c, data: d });

  // ---------- persistence ----------
  function loadAll() {
    scripts = store.get('scripts', null);
    if (!scripts || !Object.keys(scripts).length) scripts = { ...(window.GP_DEFAULT_SCRIPTS || {}) };
    const p = store.get('profiles', {});
    profiles = { defaults: { ...DEFAULTS, ...(p.defaults || {}) }, speakers: p.speakers || {}, lastSpeaker: p.lastSpeaker || null };
    store.set('scripts', scripts);
  }
  let saveT = 0;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(saveNow, 800); };
  const saveNow = () => { clearTimeout(saveT); if (profiles) store.set('profiles', profiles); };
  window.addEventListener('pagehide', saveNow);
  const sp = (file) => (profiles.speakers[file] = profiles.speakers[file] || { settings: {}, pos: { para: 0, within: 0 }, timerMs: 0 });
  const settingsFor = (file) => ({ ...profiles.defaults, ...(file ? sp(file).settings : {}) });

  // ---------- speakers (same rules as the desktop app) ----------
  function displayName(file) {
    const base = file.replace(/\.txt$/i, '');
    const m = base.match(/^(\d+)[_\s-]*(.*)$/);
    const num = m ? Number(m[1]) : null;
    let rest = (m ? m[2] : base).split(/[_\s]+/);
    const vIdx = rest.findIndex(t => /^v\d+$/i.test(t));
    if (vIdx > 0) rest = rest.slice(0, vIdx);
    return { num, name: rest.join(' ').trim() || base };
  }
  function scan() {
    speakers = Object.keys(scripts).map(file => ({ file, ...displayName(file) }))
      .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.file.localeCompare(b.file));
  }
  function speakerList() {
    return speakers.map(s => {
      const p = profiles.speakers[s.file] || {}, st = settingsFor(s.file);
      return { ...s, progress: p.progress || 0, timerMs: p.timerMs || 0,
        timer: { timerMode: st.timerMode, timerTarget: st.timerTarget, timerWarn: st.timerWarn, timerOvertime: st.timerOvertime } };
    });
  }
  function payloadFor(file, keepPos) {
    const s = speakers.find(x => x.file === file), prof = sp(file);
    return { file, name: s.name, num: s.num, text: scripts[file] || '', settings: settingsFor(file),
      pos: prof.pos || { para: 0, within: 0 }, timerMs: prof.timerMs || 0, keepPos };
  }
  function loadSpeaker(file, { keepPos = false } = {}) {
    if (!file || !speakers.some(x => x.file === file)) return;
    current = file; profiles.lastSpeaker = file;
    const p = payloadFor(file, keepPos);
    sendOut('load', p); sendCtl('load', p);
    sendCtl('speakers', { list: speakerList(), current });
    saveSoon();
  }
  function loadFirst() {
    const first = (profiles.lastSpeaker && scripts[profiles.lastSpeaker] != null) ? profiles.lastSpeaker : speakers[0] && speakers[0].file;
    if (first) loadSpeaker(first); else { current = null; sendCtl('speakers', { list: [], current: null }); }
  }

  // ---------- output popup ----------
  function outputState() { return { fullscreen: outFs, onTop: false, displays: [], display: null }; }
  function openOutput() {
    let w = null;
    try { w = window.open('', 'glideprompter-output', 'popup,width=1100,height=640'); } catch {}
    if (!w) { setBanner('blocked'); return false; }
    try { if (w.location.href === 'about:blank') w.location.href = new URL('output.html', location.href).href; } catch {}
    outWin = w;
    try { w.focus(); } catch {}
    return true;
  }
  bus.onmessage = (e) => {
    const m = e.data || {};
    if (m.from !== 'output') return;
    switch (m.type) {
      case 'ready':
        outReady = true; setBanner(null);
        sendCtl('outputState', outputState());
        if (current) sendOut('load', payloadFor(current, false));
        break;
      case 'bye': outReady = false; outFs = false; setTimeout(() => { if (!outReady) setBanner('closed'); }, 400); break;
      case 'fs': outFs = m.on; sendCtl('outputState', outputState()); break;
      case 'vis': setBanner(m.hidden ? 'hidden' : null); break;
      case 'action': if (m.a && m.a.a !== 'noop') act(m.a); break;
      case 'report': {
        const r = m.r;
        if (!r || !r.file || scripts[r.file] == null) return;
        const p = sp(r.file);
        p.pos = r.pos; p.timerMs = r.timerMs; p.progress = r.progress;
        if (r.file === current) sendCtl('report', r); else sendCtl('speakers', { list: speakerList(), current });
        saveSoon();
        break;
      }
      case 'settings': {
        const { file, settings } = m.s || {};
        if (!file || file !== current) return;
        const own = {};
        for (const k of SETTING_KEYS) if (settings[k] !== profiles.defaults[k]) own[k] = settings[k];
        sp(file).settings = own;
        sendCtl('settings', settings);
        saveSoon();
        break;
      }
    }
  };

  // ---------- actions ----------
  function act(a) {
    if (!a || !a.a || a.a === 'noop') return;
    if (!MAIN_ACTIONS.has(a.a)) {
      if (!outReady) { setBanner('closed', true); }
      sendOut('action', a);
      return;
    }
    switch (a.a) {
      case 'speaker': {
        const s = speakers.find(x => x.num === a.index + 1) || (speakers.some(x => x.num != null) ? null : speakers[a.index]);
        if (s && s.file !== current) { sendOut('action', { a: 'pauseAll' }); loadSpeaker(s.file); }
        break;
      }
      case 'speakerFile': if (a.file !== current) { sendOut('action', { a: 'pauseAll' }); loadSpeaker(a.file); } break;
      case 'fullscreen':
        if (!outReady) openOutput();
        else sendCtl('toast', 'Browsers only allow fullscreen from inside the prompter window: click it and press F (or double-click it).');
        break;
      case 'showOutput': openOutput(); break;
      case 'focusSearch': sendCtl('focusSearch'); break;
      case 'searchNav': sendCtl('searchNav', a.d); break;
      case 'saveDefault':
        if (current) { profiles.defaults = settingsFor(current); sp(current).settings = {}; saveNow(); sendCtl('toast', 'Saved as default for all speakers without own settings'); }
        break;
      case 'resetDefault':
        if (current) { sp(current).settings = {}; sendOut('action', { a: 'applySettings', settings: settingsFor(current) }); sendCtl('settings', settingsFor(current)); saveSoon(); }
        break;
    }
  }

  // ---------- scripts ----------
  function putScript(file, text) {
    scripts[file] = text; store.set('scripts', scripts);
  }
  function pickTxtFiles() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.txt,text/plain'; inp.multiple = true;
      inp.onchange = async () => {
        const files = Array.from(inp.files || []);
        for (const f of files) putScript(f.name.replace(/[\\/:*?"<>|]/g, ''), await f.text());
        resolve(files.length);
      };
      inp.click();
    });
  }

  window.tp = {
    ready() {
      loadAll(); scan();
      sendCtl('outputState', outputState());
      loadFirst();
      bus.postMessage({ to: 'output', type: 'hello' });
      setTimeout(() => { if (!outReady) setBanner('closed'); }, 700);
    },
    action: act,
    report() {}, settings() {},
    saveScript(file, text) {
      putScript(file, text);
      if (file === current) loadSpeaker(file, { keepPos: true });
      return Promise.resolve(true);
    },
    newSpeaker(name) {
      const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
      if (!clean) return Promise.resolve(null);
      const n = speakers.reduce((m, s) => Math.max(m, s.num || 0), 0) + 1;
      const file = `${n}_${clean}.txt`;
      putScript(file, ''); scan(); loadSpeaker(file);
      return Promise.resolve(file);
    },
    async changeFolder() {            // web: "Import .txt scripts…"
      const n = await pickTxtFiles();
      if (!n) return null;
      scan();
      if (current && scripts[current] != null) loadSpeaker(current, { keepPos: true }); else loadFirst();
      sendCtl('toast', `Imported ${n} script${n === 1 ? '' : 's'}`);
      return storageLabel();
    },
    info: () => Promise.resolve({ scriptsDir: storageLabel() }),
    on,
  };
  const storageLabel = () => `Scripts are stored in this browser (${Object.keys(scripts).length}).`;

  // ---------- web-only UI ----------
  let bannerEl = null;
  function setBanner(kind, flash) {
    if (!bannerEl) return;
    bannerEl.hidden = !kind;
    if (!kind) return;
    bannerEl.querySelector('span').textContent = {
      blocked: 'Your browser blocked the prompter window. Allow pop-ups for this site, then click the button.',
      closed: 'The prompter window is not open. It is the window you put on the screen or capture in OBS.',
      hidden: 'The prompter window is minimised or covered, so the browser paused it. Keep it visible: on a second screen or next to this window.',
    }[kind];
    bannerEl.querySelector('button').textContent = kind === 'hidden' ? 'Show prompter window' : 'Open prompter window';
    if (flash) { bannerEl.classList.remove('flash'); void bannerEl.offsetWidth; bannerEl.classList.add('flash'); }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('web');
    const css = document.createElement('style');
    css.textContent = `
      body.web #btn1080, body.web #display, body.web label.check:has(#onTop) { display: none !important; }
      #webBanner { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: #2a1210; border-bottom: 1px solid var(--accent); font-size: 13px; }
      #webBanner[hidden] { display: none; }
      #webBanner span { flex: 1; }
      #webBanner.flash { animation: gpflash .6s ease 2; }
      @keyframes gpflash { 50% { background: #5a1a14; } }
      .weblinks { font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
      .weblinks a { color: #9ab8ff; }`;
    document.head.appendChild(css);

    bannerEl = document.createElement('div');
    bannerEl.id = 'webBanner'; bannerEl.hidden = true;
    bannerEl.innerHTML = '<span></span><button class="pill primary" id="btnOpenOut">Open prompter window</button>';
    document.getElementById('main').prepend(bannerEl);
    bannerEl.querySelector('button').onclick = openOutput;

    document.getElementById('btnShowOut').textContent = 'Open / show prompter window';
    const folderBtn = document.getElementById('btnFolder');
    folderBtn.textContent = 'Import .txt scripts…';
    folderBtn.title = 'Add .txt scripts from your computer (one line = one paragraph)';
    const dl = document.createElement('button');
    dl.className = 'pill wide'; dl.textContent = 'Download this script';
    dl.onclick = () => { if (current) download(current, scripts[current] || ''); };
    const del = document.createElement('button');
    del.className = 'pill wide'; del.textContent = 'Delete this speaker';
    del.onclick = () => {
      if (!current || !confirm(`Delete "${current}" from this browser? Download it first if you want to keep it.`)) return;
      delete scripts[current]; delete profiles.speakers[current];
      store.set('scripts', scripts); saveNow();
      current = null; scan(); loadFirst();
      document.getElementById('folder').textContent = storageLabel();
    };
    folderBtn.after(dl, del);
    const links = document.createElement('div');
    links.className = 'weblinks';
    links.innerHTML = '<a href="../" target="_blank">GlidePrompter website</a><a href="https://github.com/AmineChr54/glideprompter/releases/latest" target="_blank">Get the desktop app (Windows)</a>';
    document.getElementById('folder').after(links);
  });
})();
