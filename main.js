// GlidePrompter – main process.
// Two windows: "GlidePrompter Output" (captured by OBS) and "GlidePrompter Control".
const { app, BrowserWindow, ipcMain, dialog, screen, powerSaveBlocker, Menu, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Never throttle / pause rendering when unfocused, covered or in background ----
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Test hook: TP_FOLLOW_WAV + TP_FOLLOW_FAKEMIC=1 presents the WAV as a real microphone (Chromium's fake capture device),
// so the whole microphone path (getUserMedia, audio service, worklet) runs in real time.
if (process.env.TP_FOLLOW_WAV && process.env.TP_FOLLOW_FAKEMIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.TP_FOLLOW_WAV + '%noloop');
}

const DEFAULTS = require('./shared/defaults.js');   // also used by the web version
const { createFollowHost, ACTIONS: FOLLOW_ACTIONS } = require('./follow/host.js');
const SETTING_KEYS = Object.keys(DEFAULTS);

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

// Where speaker scripts + profiles.json live.
//  - Dev (npm start): <repo>/scripts (gitignored).
//  - Packaged portable .exe (Windows): "GlidePrompter Scripts" next to the .exe.
//  - Packaged on Linux / macOS (AppImage, .deb, .app are read-only or system folders): Documents/GlidePrompter Scripts.
// Both are seeded on first run with the sample script(s) in default-scripts/.
function defaultScriptsDir() {
  const exeDir = app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)) : null;
  const docs = path.join(app.getPath('documents'), 'GlidePrompter Scripts');
  let dir = !app.isPackaged ? path.join(__dirname, 'scripts') : process.platform === 'win32' ? path.join(exeDir, 'GlidePrompter Scripts') : docs;
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); }
  catch { dir = docs; fs.mkdirSync(dir, { recursive: true }); }
  const hasTxt = fs.readdirSync(dir).some(f => /\.txt$/i.test(f));
  if (!hasTxt) {
    const src = path.join(__dirname, 'default-scripts');
    for (const f of fs.readdirSync(src)) fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(src, f)));
  }
  return dir;
}
let config = { scriptsDir: null };
let profiles = null;      // contents of <scriptsDir>/profiles.json
let speakers = [];        // [{file, name, num}]
let current = null;       // current speaker file name
let outputWin = null, controlWin = null;
let outputReady = false, controlReady = false;
let lastWritten = new Map(); // file -> text we wrote (ignore our own fs.watch events)
let watcher = null;
let quitting = false;
let follow = null;        // Follow mode host (speech engine + voice pack), see follow/host.js

// ---------------- persistence ----------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
const profilesPath = () => path.join(config.scriptsDir, 'profiles.json');

function loadProfiles() {
  const p = readJson(profilesPath(), {});
  profiles = {
    defaults: { ...DEFAULTS, ...(p.defaults || {}) },
    speakers: p.speakers || {},
    lastSpeaker: p.lastSpeaker || null,
    output: p.output || {},
    control: p.control || {},
  };
}
let saveTimer = null;
function saveProfilesSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveProfilesNow, 2000);
}
function saveProfilesNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!profiles) return;
  try { writeJsonAtomic(profilesPath(), profiles); } catch (err) { console.error('save profiles', err); }
}
function sp(file) {
  if (!profiles.speakers[file]) profiles.speakers[file] = { settings: {}, pos: { para: 0, within: 0 }, timerMs: 0 };
  return profiles.speakers[file];
}
function settingsFor(file) {
  return { ...profiles.defaults, ...(file ? sp(file).settings : {}) };
}

// ---------------- speakers ----------------
function displayName(file) {
  const base = file.replace(/\.txt$/i, '');
  const m = base.match(/^(\d+)[_\s-]*(.*)$/);
  const num = m ? Number(m[1]) : null;
  let rest = (m ? m[2] : base).split(/[_\s]+/);
  const vIdx = rest.findIndex(t => /^v\d+$/i.test(t));
  if (vIdx > 0) rest = rest.slice(0, vIdx);
  return { num, name: rest.join(' ').trim() || base };
}
function scanSpeakers() {
  let files = [];
  try { files = fs.readdirSync(config.scriptsDir).filter(f => /\.txt$/i.test(f)); } catch {}
  speakers = files.map(file => ({ file, ...displayName(file) }))
    .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.file.localeCompare(b.file));
  return speakers;
}
function readScript(file) {
  try { return fs.readFileSync(path.join(config.scriptsDir, file), 'utf8'); } catch { return ''; }
}
function speakerList() {
  return speakers.map(s => {
    const p = profiles.speakers[s.file] || {};
    const st = settingsFor(s.file);
    return { ...s, progress: p.progress || 0, timerMs: p.timerMs || 0,
      timer: { timerMode: st.timerMode, timerTarget: st.timerTarget, timerWarn: st.timerWarn, timerOvertime: st.timerOvertime } };
  });
}

function loadSpeaker(file, { keepPos = false } = {}) {
  if (!file) return;
  const s = speakers.find(x => x.file === file);
  if (!s) return;
  current = file;
  profiles.lastSpeaker = file;
  const prof = sp(file);
  const payload = {
    file, name: s.name, num: s.num,
    text: readScript(file),
    settings: settingsFor(file),
    pos: prof.pos || { para: 0, within: 0 },
    timerMs: prof.timerMs || 0,
    keepPos,
  };
  sendOut('load', payload);
  sendCtl('load', payload);
  sendCtl('speakers', { list: speakerList(), current });
  saveProfilesSoon();
}

function startWatcher() {
  try { watcher && watcher.close(); } catch {}
  let t = null;
  try {
    watcher = fs.watch(config.scriptsDir, (ev, fname) => {
      if (fname && !/\.txt$/i.test(fname)) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const before = speakers.map(s => s.file).join('|');
        scanSpeakers();
        if (speakers.map(s => s.file).join('|') !== before) sendCtl('speakers', { list: speakerList(), current });
        if (current && (!fname || fname === current)) {
          const text = readScript(current);
          if (lastWritten.get(current) !== text) {
            lastWritten.set(current, text);
            loadSpeaker(current, { keepPos: true });
          }
        }
      }, 250);
    });
  } catch (err) { console.error('watch', err); }
}

// ---------------- windows ----------------
function sendOut(ch, data) { if (outputWin && !outputWin.isDestroyed()) outputWin.webContents.send(ch, data); }
function sendCtl(ch, data) { if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(ch, data); }

const ICON = path.join(__dirname, 'build', 'icon.png');
const WEB_PREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: false,   // keep rAF + timers at full rate when unfocused/hidden
  spellcheck: false,
};

function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + b.height > a.y + 30;
  });
}

function createWindows() {
  const wa = screen.getPrimaryDisplay().workArea;
  const outDef = { width: Math.round(wa.width * 0.62), height: Math.round(wa.width * 0.62 * 9 / 16) };
  const ob = boundsVisible(profiles.output.bounds) ? profiles.output.bounds
    : { x: wa.x + wa.width - outDef.width - 10, y: wa.y + 10, ...outDef };

  outputWin = new BrowserWindow({
    ...ob, title: 'GlidePrompter Output', backgroundColor: '#000000', icon: ICON,
    minimizable: false, autoHideMenuBar: true, show: false,
    alwaysOnTop: !!profiles.output.onTop,
    webPreferences: WEB_PREFS,
  });
  outputWin.setMenuBarVisibility(false);
  outputWin.loadFile('output.html');
  outputWin.once('ready-to-show', () => outputWin.show());
  outputWin.on('page-title-updated', e => e.preventDefault());

  const cb = boundsVisible(profiles.control.bounds) ? profiles.control.bounds
    : { x: wa.x + 10, y: wa.y + Math.round(wa.height * 0.3), width: Math.min(1400, Math.round(wa.width * 0.7)), height: Math.round(wa.height * 0.65) };
  controlWin = new BrowserWindow({
    ...cb, minWidth: 900, minHeight: 500, title: 'GlidePrompter Control', backgroundColor: '#111111', icon: ICON,
    autoHideMenuBar: true, show: false, webPreferences: WEB_PREFS,
  });
  controlWin.setMenuBarVisibility(false);
  controlWin.loadFile('control.html');
  controlWin.once('ready-to-show', () => { controlWin.show(); controlWin.focus(); });
  controlWin.on('page-title-updated', e => e.preventDefault());

  const remember = (win, key) => {
    const store = () => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
      profiles[key].bounds = win.getBounds(); saveProfilesSoon();
    };
    win.on('moved', store); win.on('resized', store);
  };
  remember(outputWin, 'output'); remember(controlWin, 'control');

  outputWin.on('enter-full-screen', () => sendCtl('outputState', outputState()));
  outputWin.on('leave-full-screen', () => sendCtl('outputState', outputState()));
  outputWin.on('blur', () => sendOut('action', { a: 'releaseAll' }));
  controlWin.on('blur', () => sendOut('action', { a: 'releaseAll' }));

  // Closing either window quits the whole app (state is saved first).
  const quit = () => { if (!quitting) { quitting = true; app.quit(); } };
  outputWin.on('close', quit);
  controlWin.on('close', quit);
}

function outputState() {
  if (!outputWin || outputWin.isDestroyed()) return {};
  const d = screen.getDisplayMatching(outputWin.getBounds());
  return {
    fullscreen: outputWin.isFullScreen(), onTop: outputWin.isAlwaysOnTop(), display: d.id,
    displays: screen.getAllDisplays().map((x, i) => ({ id: x.id, label: `Monitor ${i + 1} (${Math.round(x.size.width * x.scaleFactor)}×${Math.round(x.size.height * x.scaleFactor)})` })),
  };
}

function maybeStart() {
  if (!outputReady || !controlReady) return;
  sendCtl('outputState', outputState());
  sendCtl('help', null);
  const first = (profiles.lastSpeaker && speakers.find(s => s.file === profiles.lastSpeaker)) ? profiles.lastSpeaker
    : speakers[0] && speakers[0].file;
  if (first) loadSpeaker(first); else sendCtl('speakers', { list: [], current: null });
}

// ---------------- main-level actions ----------------
function handleMainAction(a) {
  if (FOLLOW_ACTIONS.includes(a.a)) { follow.onAction(a); return; }
  switch (a.a) {
    case 'speaker': {
      const s = speakers.find(x => x.num === a.index + 1) || (speakers.some(x => x.num != null) ? null : speakers[a.index]);
      if (s && s.file !== current) { sendOut('action', { a: 'pauseAll' }); loadSpeaker(s.file); }
      break;
    }
    case 'speakerFile':
      if (a.file !== current) { sendOut('action', { a: 'pauseAll' }); loadSpeaker(a.file); }
      break;
    case 'fullscreen': setFullscreen(a.value ?? !outputWin.isFullScreen(), a.display); break;
    case 'onTop':
      outputWin.setAlwaysOnTop(a.value ?? !outputWin.isAlwaysOnTop());
      profiles.output.onTop = outputWin.isAlwaysOnTop(); saveProfilesSoon();
      sendCtl('outputState', outputState());
      break;
    case 'display': {
      const d = screen.getAllDisplays().find(x => x.id === a.id);
      if (!d) break;
      const wasFs = outputWin.isFullScreen();
      if (wasFs) outputWin.setFullScreen(false);
      const b = outputWin.getBounds();
      const w = Math.min(b.width, d.workArea.width), h = Math.min(b.height, d.workArea.height);
      outputWin.setBounds({ x: d.workArea.x + Math.round((d.workArea.width - w) / 2), y: d.workArea.y + Math.round((d.workArea.height - h) / 2), width: w, height: h });
      if (wasFs) setTimeout(() => outputWin.setFullScreen(true), 150);
      setTimeout(() => sendCtl('outputState', outputState()), 300);
      break;
    }
    case 'size1080': {
      if (outputWin.isFullScreen()) outputWin.setFullScreen(false);
      const d = screen.getDisplayMatching(outputWin.getBounds());
      const f = d.scaleFactor || 1;
      outputWin.setContentSize(Math.round(1920 / f), Math.round(1080 / f));
      break;
    }
    case 'showOutput': outputWin.show(); outputWin.moveTop(); break;
    case 'focusSearch': controlWin.show(); controlWin.focus(); sendCtl('focusSearch'); break;
    case 'searchNav': sendCtl('searchNav', a.d); break;
    case 'saveDefault':
      if (current) {
        profiles.defaults = settingsFor(current);
        sp(current).settings = {};
        saveProfilesNow();
        sendCtl('toast', 'Saved as default for all speakers without own settings');
      }
      break;
    case 'resetDefault':
      if (current) {
        sp(current).settings = {};
        sendOut('action', { a: 'applySettings', settings: settingsFor(current) });
        saveProfilesSoon();
      }
      break;
  }
}

function setFullscreen(on, displayId) {
  if (on) {
    const d = (displayId && screen.getAllDisplays().find(x => x.id === displayId)) || screen.getDisplayMatching(outputWin.getBounds());
    outputWin.setBounds(d.bounds);
    outputWin.setFullScreen(true);
  } else {
    outputWin.setFullScreen(false);
  }
}

// ---------------- IPC ----------------
ipcMain.on('ready', (e, who) => {
  if (who === 'output') outputReady = true;
  if (who === 'control') controlReady = true;
  maybeStart();
});

ipcMain.on('action', (e, a) => {
  if (!a || !a.a || a.a === 'noop') return;
  if (globalThis.TP_MAIN_ACTIONS.has(a.a)) handleMainAction(a);
  else sendOut('action', a);
});

// Output reports runtime state (~10 Hz): position, progress, timer, play state.
ipcMain.on('report', (e, r) => {
  if (!r || !r.file || !speakers.some(s => s.file === r.file)) return;
  const p = sp(r.file);
  p.pos = r.pos; p.timerMs = r.timerMs; p.progress = r.progress;
  if (r.file === current) { sendCtl('report', r); follow.onReport(r); }
  else sendCtl('speakers', { list: speakerList(), current });
  saveProfilesSoon();
});

// Output reports a settings change (from a shortcut or a Control slider).
ipcMain.on('settings', (e, { file, settings }) => {
  if (!file || file !== current) return;
  const own = {};
  for (const k of SETTING_KEYS) if (settings[k] !== profiles.defaults[k]) own[k] = settings[k];
  sp(file).settings = own;
  sendCtl('settings', settings);
  saveProfilesSoon();
});

ipcMain.handle('saveScript', (e, { file, text }) => {
  const full = path.join(config.scriptsDir, file);
  const tmp = full + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, full);
  lastWritten.set(file, text);
  if (file === current) loadSpeaker(file, { keepPos: true });
  return true;
});

ipcMain.handle('newSpeaker', (e, name) => {
  const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
  if (!clean) return null;
  const n = speakers.reduce((m, s) => Math.max(m, s.num || 0), 0) + 1;
  const file = `${n}_${clean}.txt`;
  fs.writeFileSync(path.join(config.scriptsDir, file), '', 'utf8');
  lastWritten.set(file, '');
  scanSpeakers();
  loadSpeaker(file);
  return file;
});

ipcMain.handle('changeFolder', async () => {
  const r = await dialog.showOpenDialog(controlWin, { properties: ['openDirectory'], defaultPath: config.scriptsDir });
  if (r.canceled || !r.filePaths[0]) return null;
  saveProfilesNow();
  config = { scriptsDir: r.filePaths[0], packaged: app.isPackaged, custom: true };
  writeJsonAtomic(CONFIG_FILE(), config);
  loadProfiles(); scanSpeakers(); startWatcher();
  current = null;
  maybeStart();
  return config.scriptsDir;
});

ipcMain.handle('info', () => ({ scriptsDir: config.scriptsDir }));

// ---------------- lifecycle ----------------
app.whenReady().then(() => {
  globalThis.TP_MAIN_ACTIONS = new Set(['speaker', 'speakerFile', 'fullscreen', 'onTop', 'display', 'size1080', 'showOutput', 'saveDefault', 'resetDefault', 'focusSearch', 'searchNav', ...FOLLOW_ACTIONS]);
  // No menu bar on Windows / Linux. macOS needs an app menu for Cmd+Q and copy / paste in the editor.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const saved = readJson(CONFIG_FILE(), null);
  // Only a folder the user explicitly picked ("Change scripts folder…") is remembered.
  if (saved && saved.custom && saved.scriptsDir && fs.existsSync(saved.scriptsDir) && saved.packaged === app.isPackaged) config = saved;
  else config = { scriptsDir: defaultScriptsDir(), packaged: app.isPackaged };
  loadProfiles();
  scanSpeakers();
  startWatcher();
  powerSaveBlocker.start('prevent-display-sleep');
  createWindows();
  // Microphone: only the Control window may use it (Follow mode).
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    const ok = perm === 'media' && !!controlWin && wc === controlWin.webContents;
    // macOS also asks the user once, at system level (Privacy & Security > Microphone).
    if (ok && process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').then(cb, () => cb(false));
    else cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!controlWin && wc === controlWin.webContents);
  const prefs = () => profiles.control;
  prefs.save = saveProfilesSoon;
  follow = createFollowHost({ app, sendOut, sendCtl, controlWin: () => controlWin, outputWin: () => outputWin, prefs });

  // Debug helper: TP_SNAPSHOT=<dir> captures both windows to PNG and quits.
  if (process.env.TP_SNAPSHOT) {
    setTimeout(async () => {
      const dir = process.env.TP_SNAPSHOT;
      if (process.env.TP_OUT_SIZE) { const [w, h] = process.env.TP_OUT_SIZE.split('x').map(Number); outputWin.setContentSize(w, h); }
      if (process.env.TP_CTL_SIZE) { const [w, h] = process.env.TP_CTL_SIZE.split('x').map(Number); controlWin.setContentSize(w, h); }
      if (process.env.TP_FOLLOW_WAV) await outputWin.webContents.executeJavaScript('window.__followLog = []; 1');
      if (process.env.TP_ACTIONS) for (const a of JSON.parse(process.env.TP_ACTIONS)) { ipcMain.emit('action', {}, a); await new Promise(r => setTimeout(r, 400)); }
      if (process.env.TP_EVAL_CONTROL) {
        const out = await controlWin.webContents.executeJavaScript(process.env.TP_EVAL_CONTROL);
        fs.writeFileSync(path.join(dir, 'eval.txt'), String(out));
      }
      await new Promise(r => setTimeout(r, Number(process.env.TP_WAIT || 1500)));
      if (process.env.TP_FOLLOW_WAV) {
        const log = await outputWin.webContents.executeJavaScript('JSON.stringify(window.__followLog)');
        const wavStart = await controlWin.webContents.executeJavaScript('window.__wavStart || 0');
        const ctxClock = await controlWin.webContents.executeJavaScript('window.__ctxClock || []');
        const firstSound = await controlWin.webContents.executeJavaScript('window.__firstSound || 0');
        fs.writeFileSync(path.join(dir, 'follow-log.json'), JSON.stringify({ wav: process.env.TP_FOLLOW_WAV, wavStart, firstSound, ctxClock, log: JSON.parse(log), events: follow.events() }));
      }
      if (process.env.TP_FRAMES) {
        // Cover the output window completely with the control window, focus control, then measure rAF cadence.
        controlWin.setBounds(outputWin.getBounds()); controlWin.focus();
        await new Promise(r => setTimeout(r, 500));
        const stats = await outputWin.webContents.executeJavaScript(`new Promise(res => { const d = []; let l = performance.now(); const t0 = l;
          function f(n) { d.push(n - l); l = n; if (n - t0 < 6000) requestAnimationFrame(f); else { d.sort((a,b)=>a-b);
            const slow = d.filter(x => x > 12).length; res({ slow, frames: d.length, median: d[d.length>>1].toFixed(2), p99: d[Math.floor(d.length*0.99)].toFixed(2), max: d[d.length-1].toFixed(2) }); } }
          requestAnimationFrame(f); })`);
        fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(stats));
      }
      if (process.env.TP_RECORD) {
        // TP_RECORD=<frames>x<ms>: capture the output window repeatedly (for the README / website clip).
        const [n, ms] = process.env.TP_RECORD.split('x').map(Number);
        fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          const img = await outputWin.webContents.capturePage();
          fs.writeFileSync(path.join(dir, 'frames', String(i).padStart(4, '0') + '.png'), img.toPNG());
          await new Promise(r => setTimeout(r, Math.max(0, ms - (Date.now() - t0))));
        }
      }
      fs.writeFileSync(path.join(dir, 'output.png'), (await outputWin.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(dir, 'control.png'), (await controlWin.webContents.capturePage()).toPNG());
      quitting = true; saveProfilesNow(); app.exit(0);
    }, 2500);
  }
});

app.on('before-quit', () => { quitting = true; saveProfilesNow(); follow && follow.quit(); });
app.on('window-all-closed', () => app.quit());
