// Follow mode, main-process side: owns the voice pack, the speech engine (utilityProcess) and the
// audio port between the Control window and the engine. The Output window owns the on/off state
// (Play, Home or End there switch Follow mode off), and reports it like every other runtime state.
const path = require('path');
const { utilityProcess, MessageChannelMain } = require('electron');
const Pack = require('./pack.js');
const { setHighQoS } = require('./qos.js');
const fs = require('fs');

// Test hook: TP_FOLLOW_WAV=<16 kHz mono 16-bit wav> plays that file into the capture path instead of the microphone.
function readWav16(file) {
  const b = fs.readFileSync(file);
  let o = 12;
  while (o + 8 <= b.length && b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  const n = b.readUInt32LE(o + 4) / 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
  return out;
}

function createFollowHost({ app, sendOut, sendCtl, controlWin, outputWin, prefs }) {
  const pack = Pack.create(app);
  let engine = null, engineReady = false, engineError = null, starting = null;
  let words = null;                 // last {words, paraOf} from the Output window
  let listening = false;            // engine + capture running
  let wantOn = false;               // the operator asked for Follow mode and we are bringing it up
  let lastStats = null, progress = null;
  const events = [];                // test hook (TP_FOLLOW_WAV): engine messages with arrival times
  let outSeen = false;              // the Output has confirmed following since the last start()

  const status = () => ({
    pack: pack.status(), engineReady, engineError, listening, progress, stats: lastStats,
    mic: prefs().followMic || '',
  });
  const pushStatus = () => sendCtl('followStatus', status());

  // Processes that must keep real-time speed while listening: main, both windows, the speech engine
  // and Chromium's audio service (which delivers the microphone).
  let qosPids = [];
  function qos(on) {
    const pids = on ? [process.pid,
      ...[controlWin(), outputWin()].filter(w => w && !w.isDestroyed()).map(w => w.webContents.getOSProcessId()),
      engine && engine.pid,
      ...app.getAppMetrics().filter(m => m.type === 'Utility' && /audio/i.test(m.serviceName || m.name || '')).map(m => m.pid),
    ].filter(Boolean) : qosPids;
    qosPids = on ? pids : [];
    setHighQoS(pids, on).then(r => { if (process.env.TP_FOLLOW_DEBUG) console.log('[follow] qos', on, pids, r); });
  }

  function startEngine() {
    if (engineReady) return Promise.resolve();
    if (starting) return starting;
    const paths = pack.paths();
    if (!paths) return Promise.reject(new Error('needPack'));
    engineError = null;
    starting = new Promise((resolve, reject) => {
      engine = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], { serviceName: 'GlidePrompter speech', stdio: process.env.TP_FOLLOW_DEBUG ? 'inherit' : 'ignore' });
      engine.on('message', (m) => {
        if (process.env.TP_FOLLOW_DEBUG) console.log('[engine]', (performance.timeOrigin + performance.now()).toFixed(1), JSON.stringify(m).slice(0, 160));
        if (process.env.TP_FOLLOW_WAV && m.type !== 'debug') events.push([+(performance.timeOrigin + performance.now()).toFixed(1), m]);
        switch (m.type) {
          case 'ready': engineReady = true; starting = null; if (words) engine.postMessage({ type: 'words', ...words }); resolve(); pushStatus(); break;
          case 'error':
            engineError = m.message; console.error('[follow engine]', m.message);
            if (!engineReady) { starting = null; reject(new Error(m.message)); }
            pushStatus();
            break;
          case 'cursor': sendOut('action', { a: 'follow', word: m.word, state: m.state, jump: m.jump }); sendCtl('followCursor', m); break;
          case 'speaking': sendOut('action', { a: 'followSpeaking', on: m.on }); sendCtl('followSpeaking', m.on); break;
          case 'stats': lastStats = m; sendCtl('followStats', m); break;
        }
      });
      engine.on('exit', (code) => {
        const was = engineReady;
        engine = null; engineReady = false;
        if (starting) { starting = null; reject(new Error('The speech engine stopped (code ' + code + ').')); }
        if (was && listening) { engineError = 'The speech engine stopped unexpectedly.'; stop(); }
        pushStatus();
      });
      engine.postMessage({ type: 'init', runtime: paths.runtime, model: paths.model, vad: paths.vad, threads: 2 });
    });
    pushStatus();
    return starting;
  }

  // Turn Follow mode on: engine up, fresh audio port to the Control window, then tell the Output.
  async function start() {
    if (listening || wantOn) return;
    wantOn = true;
    try { await startEngine(); }
    catch (err) {
      wantOn = false;
      if (err.message === 'needPack') sendCtl('followNeedPack', status());
      else sendCtl('toast', 'Follow mode could not start: ' + err.message);
      pushStatus();
      return;
    }
    if (!wantOn) return;                     // switched off again while loading
    const { port1, port2 } = new MessageChannelMain();
    engine.postMessage({ type: 'audio' }, [port1]);
    const win = controlWin();
    const fakeMic = !!(process.env.TP_FOLLOW_WAV && process.env.TP_FOLLOW_FAKEMIC);
    const wav = process.env.TP_FOLLOW_WAV && !fakeMic ? readWav16(process.env.TP_FOLLOW_WAV) : null;
    if (win && !win.isDestroyed()) win.webContents.postMessage('followPort', { deviceId: fakeMic ? '' : prefs().followMic || '', wav, fakeMic }, [port2]);
    engine.postMessage({ type: 'listen', on: true });
    listening = true; wantOn = false; outSeen = false;
    qos(true);
    sendOut('action', { a: 'followSet', on: true });
    pushStatus();
  }
  function stop() {
    wantOn = false;
    if (!listening) return;
    listening = false;
    qos(false);
    if (engine) engine.postMessage({ type: 'listen', on: false });
    sendCtl('followCapture', { on: false });
    sendOut('action', { a: 'followSet', on: false });
    pushStatus();
  }

  function onAction(a) {
    switch (a.a) {
      case 'followToggle': if (listening || wantOn) stop(); else start(); break;
      case 'followOn': start(); break;
      case 'followOff': stop(); break;
      case 'followWords':
        words = { words: a.words || [], paraOf: a.paraOf || [], anchor: a.anchor };
        if (engineReady) engine.postMessage({ type: 'words', ...words });
        break;
      case 'followAnchor': if (engineReady) engine.postMessage({ type: 'anchor', word: a.word }); break;
      case 'followMic': prefs().followMic = a.deviceId || ''; prefs.save(); if (listening) { stop(); start(); } break;
      case 'followStatus': pushStatus(); break;
      case 'followDownload':
        if (progress) break;
        progress = { done: 0, total: pack.status().size };
        pushStatus();
        pack.download((done, total) => {
          const now = Date.now();
          if (!progress || now - (progress.at || 0) > 150 || done === total) { progress = { done, total, at: now }; pushStatus(); }
        }).then(() => { progress = null; sendCtl('toast', 'Voice pack installed'); pushStatus(); })
          .catch((err) => { progress = null; if (err.message !== 'cancelled') sendCtl('toast', 'Download failed: ' + err.message); pushStatus(); });
        break;
      case 'followCancel': pack.cancel(); break;
      case 'followRemove':
        stop();
        if (engine) { engine.kill(); engine = null; engineReady = false; }
        setTimeout(() => { try { pack.remove(); } catch (err) { sendCtl('toast', 'Could not remove the voice pack: ' + err.message); } pushStatus(); }, 300);
        break;
    }
  }
  // The Output reports `following`; if it switched off by itself (Play, Home, End, speaker change), stop listening.
  function onReport(r) {
    if (!listening || !r) return;
    if (r.following) outSeen = true; else if (outSeen) stop();
  }
  function quit() { try { engine && engine.kill(); } catch {} }

  return { onAction, onReport, quit, status, events: () => events };
}

const ACTIONS = ['followToggle', 'followOn', 'followOff', 'followWords', 'followAnchor', 'followMic', 'followStatus', 'followDownload', 'followCancel', 'followRemove'];
module.exports = { createFollowHost, ACTIONS };
