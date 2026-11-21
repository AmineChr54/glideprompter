// Smoke test for a voice pack runtime on the current system: loads <pack>/<runtime dir>/sherpa-onnx.node
// the same way follow/engine.js does, decodes a 16 kHz WAV and prints the text and the speed.
//   node tools/follow/pack-smoke.js .dev/pack/en-1 .dev/talks/t1-verbatim.wav
const fs = require('fs');
const path = require('path');

function readWav(file) {            // 16-bit PCM mono
  const b = fs.readFileSync(file);
  let o = 12, rate = 16000;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(o + 12);
    if (id === 'data') { const s = new Float32Array(n / 2); for (let i = 0; i < s.length; i++) s[i] = b.readInt16LE(o + 8 + 2 * i) / 32768; return { samples: s, sampleRate: rate }; }
    o += 8 + n + (n & 1);
  }
  throw new Error('no data chunk');
}
const { PACK } = require('../../follow/pack.js');

const [packDir = '.dev/pack/en-1', wav = '.dev/talks/t1-verbatim.wav'] = process.argv.slice(2);
if (!PACK.runtime) { console.error(`no runtime for ${PACK.platform}`); process.exit(2); }
const t0 = Date.now();
const addon = require(path.resolve(packDir, PACK.runtime.dir, 'sherpa-onnx.node'));
const rec = addon.createOnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { tokens: path.resolve(packDir, PACK.model.tokens), numThreads: 2, provider: 'cpu', debug: 0,
    nemoCtc: { model: path.resolve(packDir, PACK.model.model) } },
  decodingMethod: 'greedy_search',
});
const vad = addon.createVoiceActivityDetector({ sileroVad: { model: path.resolve(packDir, PACK.model.vad), threshold: 0.5,
  minSpeechDuration: 0.02, minSilenceDuration: 0.25, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: 0 }, 30);
const loadMs = Date.now() - t0;
const { samples, sampleRate } = readWav(path.resolve(wav));
const stream = addon.createOnlineStream(rec);
const t1 = Date.now();
let speech = 0;
for (let i = 0; i < samples.length; i += 320) {
  const chunk = samples.subarray(i, i + 320);
  addon.acceptWaveformOnline(stream, { samples: chunk, sampleRate });
  while (addon.isOnlineStreamReady(rec, stream)) addon.decodeOnlineStream(rec, stream);
  if (chunk.length === 320) { addon.voiceActivityDetectorAcceptWaveform(vad, chunk); if (addon.voiceActivityDetectorIsDetected(vad)) speech++;
    while (!addon.voiceActivityDetectorIsEmpty(vad)) addon.voiceActivityDetectorPop(vad); }
}
addon.inputFinished(stream);
while (addon.isOnlineStreamReady(rec, stream)) addon.decodeOnlineStream(rec, stream);
const text = JSON.parse(addon.getOnlineStreamResultAsJson(rec, stream)).text;
const audioS = samples.length / sampleRate, cpuS = (Date.now() - t1) / 1000;
console.log(`${PACK.platform}: load ${loadMs} ms, ${audioS.toFixed(1)} s audio in ${cpuS.toFixed(1)} s (RTF ${(cpuS / audioS).toFixed(2)}), voice frames ${speech}`);
console.log(`text: ${text.slice(0, 160)}…`);
process.exit(text.split(/\s+/).length > 20 ? 0 : 1);
