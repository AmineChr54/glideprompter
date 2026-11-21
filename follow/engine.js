// Follow mode speech engine. Runs in an Electron utilityProcess, so decoding never blocks the main
// process or a window. Audio arrives as 16 kHz Float32 frames on a MessagePort straight from the
// Control window's AudioWorklet. Decisions (which script word was just spoken, whether the speaker
// is talking) go to the main process, which forwards them to the Output window.
//
// Messages from main:
//   {type:'init', runtime, model:{kind, model|encoder/decoder/joiner, tokens}, vad, threads}
//   {type:'audio'} + ports[0]      the Control window's capture port
//   {type:'words', words, paraOf}  the current script, as rendered (TPParse.domWords)
//   {type:'anchor', word}          the operator moved the prompter; word is on the reading line
//   {type:'listen', on}            start / stop following
const path = require('path');
const { FollowMatcher } = require('../shared/follow-match.js');

const post = (m) => process.parentPort.postMessage(m);
let addon = null, rec = null, stream = null, vad = null;
let listening = false, speaking = false, port = null;
let lastText = '', lastWord = -1, lastState = '';
const matcher = new FollowMatcher();
const stats = { frames: 0, decodeMs: 0, decodes: 0, maxMs: 0, since: Date.now() };

process.on('uncaughtException', (e) => post({ type: 'error', message: String(e && e.stack || e) }));

function init(cfg) {
  const t0 = Date.now();
  addon = require(path.join(cfg.runtime, 'sherpa-onnx.node'));
  const m = cfg.model, modelConfig = { tokens: m.tokens, numThreads: cfg.threads || 2, provider: 'cpu', debug: 0 };
  if (m.kind === 'nemoCtc') modelConfig.nemoCtc = { model: m.model };
  else modelConfig.transducer = { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner };
  rec = addon.createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig, decodingMethod: 'greedy_search',
    enableEndpoint: 1, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 0.8, rule3MinUtteranceLength: 20,
  });
  stream = addon.createOnlineStream(rec);
  vad = addon.createVoiceActivityDetector({
    sileroVad: { model: cfg.vad, threshold: 0.5, minSpeechDuration: 0.02, minSilenceDuration: 0.25, windowSize: 512 },
    sampleRate: 16000, numThreads: 1, debug: 0,
  }, 30);
  post({ type: 'ready', loadMs: Date.now() - t0 });
}

function resetStream() {
  if (!rec) return;
  addon.reset(rec, stream);
  addon.voiceActivityDetectorReset(vad);
  lastText = ''; speaking = false;
}

function onFrame(samples) {
  if (!listening || !rec) return;
  const t0 = performance.now();
  addon.acceptWaveformOnline(stream, { samples, sampleRate: 16000 });
  addon.voiceActivityDetectorAcceptWaveform(vad, samples);
  const on = addon.voiceActivityDetectorIsDetected(vad);
  while (!addon.voiceActivityDetectorIsEmpty(vad)) addon.voiceActivityDetectorPop(vad);
  if (on !== speaking) { speaking = on; post({ type: 'speaking', on }); }

  let decoded = false;
  while (addon.isOnlineStreamReady(rec, stream)) { addon.decodeOnlineStream(rec, stream); decoded = true; stats.decodes++; }
  const endpoint = addon.isEndpoint(rec, stream);
  if (decoded || endpoint) {
    const r = JSON.parse(addon.getOnlineStreamResultAsJson(rec, stream));
    if (r.text !== lastText || endpoint) {
      lastText = r.text;
      const res = matcher.update(r.text, Date.now(), endpoint);
      emit(res);
    }
    if (endpoint) { addon.reset(rec, stream); lastText = ''; }
  }
  const dt = performance.now() - t0;
  stats.frames++; stats.decodeMs += dt; stats.maxMs = Math.max(stats.maxMs, dt);
  if (Date.now() - stats.since > 2000) {
    post({ type: 'stats', avgMs: +(stats.decodeMs / stats.frames).toFixed(2), maxMs: +stats.maxMs.toFixed(1), rtf: +(stats.decodeMs / (stats.frames * 20)).toFixed(3),
      fps: +(stats.frames / ((Date.now() - stats.since) / 1000)).toFixed(1) });   // audio frames per second: 50 = real time
    stats.frames = stats.decodeMs = stats.decodes = stats.maxMs = 0; stats.since = Date.now();
  }
}

function emit(res) {
  const word = matcher.wordIdx, state = matcher.state;
  if (word !== lastWord || state !== lastState || (res && res.jump)) {
    post({ type: 'cursor', word, state, jump: !!(res && res.jump), text: lastText.split(' ').slice(-4).join(' ') });
    lastWord = word; lastState = state;
  }
}

process.parentPort.on('message', (e) => {
  const m = e.data || {};
  switch (m.type) {
    case 'init':
      try { init(m); } catch (err) { post({ type: 'error', message: String(err && err.message || err) }); }
      break;
    case 'audio':
      if (process.env.TP_FOLLOW_DEBUG) post({ type: 'debug', msg: 'audio port ' + (e.ports && e.ports.length) });
      if (port) port.close();
      port = e.ports[0];
      let seen = 0, nFrames = 0;
      port.on('message', (ev) => { const d = ev.data; if (process.env.TP_FOLLOW_DEBUG && seen++ < 3) post({ type: 'debug', msg: 'frame ' + Object.prototype.toString.call(d) + ' ' + (d && d.byteLength) }); if (process.env.TP_FOLLOW_DEBUG && nFrames++ % 50 === 0) post({ type: 'debug', msg: 'frameTime ' + nFrames + ' ' + (performance.timeOrigin + performance.now()).toFixed(1) }); if (d && d.byteLength) onFrame(d instanceof Float32Array ? d : new Float32Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d)); });
      port.start();
      break;
    case 'words':
      matcher.setWords(m.words || [], m.paraOf || []);
      lastWord = -1; lastState = '';
      if (m.anchor != null) matcher.anchor(m.anchor);
      break;
    case 'anchor':
      matcher.anchor(m.word);
      lastWord = matcher.wordIdx; lastState = matcher.state;
      break;
    case 'listen':
      listening = !!m.on;
      if (listening && m.anchor != null) { matcher.anchor(m.anchor); lastWord = matcher.wordIdx; }
      if (!listening) { resetStream(); post({ type: 'speaking', on: false }); }
      break;
  }
});
