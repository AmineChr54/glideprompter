// Benchmarks streaming speech models for Follow mode on generated test talks.
// Feeds each WAV in 20 ms frames on a simulated real-time clock (decode time is queued like it
// would be live) and measures, per spoken word, how long after the word ends in the audio it
// shows up in the recognizer's partial result.
//
// Usage: node tools/follow/bench.js [--models a,b] [--threads 1,2] [talk.wav ...]
//   Defaults: every model in MODELS, 1 and 2 threads, all .dev/talks/*.wav
const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');

const ROOT = path.join(__dirname, '..', '..');
const MD = path.join(ROOT, '.dev', 'models');
const MODELS = {
  'nemo-tdt-80': (d = path.join(MD, 'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8')) => ({
    transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` }, tokens: `${d}/tokens.txt` }),
  'cc-ctc-80': (d = path.join(MD, 'glideprompter-fastconformer-ctc-en-80ms')) => ({
    nemoCtc: { model: `${d}/model.int8.onnx` }, tokens: `${d}/tokens.txt` }),
  'nemo-ctc-80': (d = path.join(MD, 'sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms-int8')) => ({
    nemoCtc: { model: `${d}/model.int8.onnx` }, tokens: `${d}/tokens.txt` }),
  'nemotron-80': (d = path.join(MD, 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11')) => ({
    transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` }, tokens: `${d}/tokens.txt` }),
  'zipformer-20M': (d = path.join(MD, 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17')) => ({
    transducer: { encoder: `${d}/encoder-epoch-99-avg-1.int8.onnx`, decoder: `${d}/decoder-epoch-99-avg-1.int8.onnx`, joiner: `${d}/joiner-epoch-99-avg-1.int8.onnx` }, tokens: `${d}/tokens.txt` }),
};

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const models = opt('--models', Object.keys(MODELS).join(',')).split(',');
const threads = opt('--threads', '1,2').split(',').map(Number);
const VAD_SILENCE = Number(opt('--vad-silence', '0.25'));
const VAD_MINSPEECH = Number(opt('--vad-min-speech', '0.02'));
const wavs = args.length ? args : fs.readdirSync(path.join(ROOT, '.dev', 'talks')).filter(f => f.endsWith('.wav')).map(f => path.join(ROOT, '.dev', 'talks', f));

const norm = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '').replace(/'/g, '');
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function readWav(file) {
  const w = sherpa.readWave(file);
  if (w.sampleRate !== 16000) throw new Error(file + ': expected 16 kHz');
  return w.samples;
}

// Levenshtein alignment of two word arrays -> pairs [i, j] of equal words.
function alignWords(a, b) {
  const n = a.length, m = b.length, D = new Array(n + 1);
  for (let i = 0; i <= n; i++) { D[i] = new Int32Array(m + 1); D[i][0] = i; }
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const pairs = [];
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { if (a[i - 1] === b[j - 1]) pairs.push([i - 1, j - 1]); i--; j--; }
    else if (D[i][j] === D[i - 1][j] + 1) i--; else j--;
  }
  return { pairs: pairs.reverse(), dist: D[n][m] };
}

function run(modelName, nThreads, wav) {
  const truth = JSON.parse(fs.readFileSync(wav.replace(/\.wav$/, '.json'), 'utf8'));
  const samples = readWav(wav);
  const t0 = performance.now();
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...MODELS[modelName](), numThreads: nThreads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 0.8, rule3MinUtteranceLength: 20,
  });
  const loadMs = performance.now() - t0;
  const stream = rec.createStream();
  const vad = new sherpa.Vad({ sileroVad: { model: path.join(MD, 'silero_vad.onnx'), threshold: 0.5, minSpeechDuration: VAD_MINSPEECH,
    minSilenceDuration: VAD_SILENCE, windowSize: 512 }, sampleRate: 16000, debug: 0, numThreads: 1 }, 30);
  let vadOn = false;
  const FRAME = 320;                      // 20 ms
  let clock = 0, busy = 0, maxQueue = 0;
  const words = [];                       // {w, tFirst, tFinal}
  let seg = [];                           // current segment: [{w, tFirst, tFinal}]
  const events = [];                     // {t, text, final}: replayed by sim.js to tune the matcher
  const commit = () => { words.push(...seg); seg = []; };
  const update = (t, final = false) => {
    const r = rec.getResult(stream);
    if (!events.length || events[events.length - 1].text !== r.text || final) events.push({ t: +t.toFixed(3), text: r.text, final });
    const ws = r.text.trim().split(/\s+/).map(norm).filter(Boolean);
    for (let j = 0; j < ws.length; j++) {
      if (!seg[j]) seg[j] = { w: ws[j], tFirst: t, tFinal: t };
      else if (seg[j].w !== ws[j]) { seg[j].w = ws[j]; seg[j].tFinal = t; }
    }
    if (ws.length < seg.length) seg.length = ws.length;
  };
  for (let i = 0; i < samples.length; i += FRAME) {
    const audioT = Math.min(samples.length, i + FRAME) / 16000;
    stream.acceptWaveform({ samples: samples.subarray(i, i + FRAME), sampleRate: 16000 });
    clock = Math.max(clock, audioT);
    let decoded = false;
    while (rec.isReady(stream)) {
      const d0 = performance.now(); rec.decode(stream); const dt = (performance.now() - d0) / 1000;
      busy += dt; clock += dt; decoded = true;
    }
    { const v0 = performance.now(); vad.acceptWaveform(samples.subarray(i, i + FRAME)); const on = vad.isDetected();
      while (!vad.isEmpty()) vad.pop();
      const dv = (performance.now() - v0) / 1000; busy += dv; clock += dv;
      if (on !== vadOn) { vadOn = on; events.push({ t: +clock.toFixed(3), vad: on }); } }
    maxQueue = Math.max(maxQueue, clock - audioT);
    if (decoded) update(clock);
    if (rec.isEndpoint(stream)) { update(clock, true); commit(); rec.reset(stream); }
  }
  stream.inputFinished();
  while (rec.isReady(stream)) rec.decode(stream);
  update(clock, true); commit();
  fs.mkdirSync(path.join(ROOT, '.dev', 'hyp'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.dev', 'hyp', `${modelName}-t${nThreads}-${path.basename(wav, '.wav')}.json`), JSON.stringify(events));

  const tw = truth.words.map(x => norm(x.w));
  const { pairs, dist } = alignWords(tw, words.map(x => x.w));
  const latFinal = [], latFirst = [];
  for (const [i, j] of pairs) { latFinal.push((words[j].tFinal - truth.words[i].end) * 1000); latFirst.push((words[j].tFirst - truth.words[i].end) * 1000); }
  return {
    model: modelName, threads: nThreads, talk: path.basename(wav, '.wav'), loadMs: Math.round(loadMs),
    rtf: +(busy / (samples.length / 16000)).toFixed(3), maxQueueMs: Math.round(maxQueue * 1000),
    wer: +(dist / tw.length * 100).toFixed(1), matched: pairs.length + '/' + tw.length,
    firstP50: Math.round(pct(latFirst, 0.5)), firstP95: Math.round(pct(latFirst, 0.95)),
    finalP50: Math.round(pct(latFinal, 0.5)), finalP95: Math.round(pct(latFinal, 0.95)),
  };
}

const rows = [];
for (const m of models) for (const th of threads) for (const w of wavs) {
  const r = run(m, th, w); rows.push(r);
  console.log(JSON.stringify(r));
}
console.log('\nsummary (mean over talks)');
const keys = ['rtf', 'wer', 'firstP50', 'firstP95', 'finalP50', 'finalP95', 'maxQueueMs'];
for (const m of models) for (const th of threads) {
  const rs = rows.filter(r => r.model === m && r.threads === th);
  const avg = Object.fromEntries(keys.map(k => [k, +(rs.reduce((s, r) => s + r[k], 0) / rs.length).toFixed(k === 'rtf' ? 3 : 0)]));
  console.log(`${m.padEnd(14)} t${th}  ` + keys.map(k => `${k}=${avg[k]}`).join('  '));
}
