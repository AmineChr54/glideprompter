// Scores a real app run (TP_FOLLOW_WAV + TP_SNAPSHOT -> follow-log.json) against the talk's ground truth.
// The log holds the Output window's follow position every frame, so this measures the whole chain:
// capture worklet -> speech engine -> matcher -> main -> Output motion.
// Usage: node tools/follow/eval-run.js <follow-log.json> [more logs...]
const fs = require('fs');
const path = require('path');
const { lineWords } = require('../../shared/follow-match.js');

const ROOT = path.join(__dirname, '..', '..');
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function evaluate(file) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run.firstSound) {
    // fake-mic runs: time zero = when the first sound arrived, minus where that sound is in the file
    const b = fs.readFileSync(run.wav); let o = 12;
    while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
    let i = 0; const n = b.readUInt32LE(o + 4) / 2;
    while (i < n && Math.abs(b.readInt16LE(o + 8 + i * 2)) / 32768 <= 1e-3) i++;
    run.wavStart = run.firstSound - i / 16;
  }
  const truth = JSON.parse(fs.readFileSync(run.wav.replace(/\.wav$/i, '.json'), 'utf8'));
  const text = fs.readFileSync(path.join(ROOT, 'default-scripts', truth.script), 'utf8').replace(/^﻿/, '');
  const offset = []; let n = 0;
  text.split(/<br\s*\/?>[ \t]*\r?\n|<br\s*\/?>|\r?\n/i).forEach((l, p) => { offset[p] = n; n += lineWords(l).length; });
  const tw = truth.words.filter(w => w.para != null).map(w => ({ ...w, idx: offset[w.para] + w.k }));
  const disp = run.log.map(([t, pos, sp]) => [(t - run.wavStart) / 1000, pos, sp]).filter(x => x[0] >= 0);
  const end = Math.min(truth.duration, disp.length ? disp[disp.length - 1][0] - 0.5 : 0);
  const words = tw.filter(w => w.end < end);

  // time lag while speaking: how many seconds behind the speaker the shown position is
  const byIdx = new Map(tw.map(w => [w.idx, w]));
  const tlag = [];
  for (let i = 0; i < disp.length; i += 3) {
    const [t, p] = disp[i];
    if (t > end || !tw.some(x => x.start <= t && t <= x.end + 0.05)) continue;
    const w = byIdx.get(Math.floor(p)); if (!w) continue;
    tlag.push((t - (w.start + (p - Math.floor(p)) * (w.end - w.start))) * 1000);
  }
  // per word: when the shown position passes the end of the word, relative to when it was said
  const wlag = [];
  for (const w of words) {
    const d = disp.find(x => x[0] >= w.start - 1 && x[1] >= w.idx + 1 && x[1] <= w.idx + 12);
    if (d) wlag.push((d[0] - w.end) * 1000);
  }
  // position error in words, and wrong jumps (shown position more than 12 words from the truth)
  const truthAt = (t) => { let c = 0; for (const w of tw) { if (w.end > t) break; c = w.idx + 1; } return c; };
  let far = 0, samples = 0;
  for (let i = 0; i < disp.length; i += 6) { const [t, p] = disp[i]; if (t > end) break; samples++; if (Math.abs(p - truthAt(t)) > 12) far++; }
  // pauses
  const stopMs = [], startMs = [], drift = [];
  const vel = (i) => i > 0 ? (disp[i][1] - disp[i - 1][1]) / Math.max(1e-3, disp[i][0] - disp[i - 1][0]) : 0;
  for (let i = 1; i < truth.words.length; i++) {
    const a = truth.words[i - 1], b = truth.words[i];
    if (b.start - a.end < 0.9 || b.start > end) continue;
    const si = disp.findIndex((x, k) => x[0] > a.end && Math.abs(vel(k)) < 0.15 && Math.abs(vel(k + 1)) < 0.15);
    if (si > 0) stopMs.push((disp[si][0] - a.end) * 1000);
    const pA = disp.find(x => x[0] >= a.end + 0.6), pB = disp.find(x => x[0] >= b.start);
    if (pA && pB) drift.push(Math.abs(pB[1] - pA[1]));
    const gi = disp.findIndex((x, k) => x[0] > b.start && vel(k) > 0.8);
    if (gi > 0) startMs.push((disp[gi][0] - b.start) * 1000);
  }
  return {
    run: path.basename(path.dirname(file)), talk: truth.name, seconds: +end.toFixed(1), words: words.length, reached: wlag.length,
    timeLag: { p50: Math.round(pct(tlag, 0.5)), p90: Math.round(pct(tlag, 0.9)), p95: Math.round(pct(tlag, 0.95)), aheadP05: Math.round(pct(tlag, 0.05)) },
    wordLag: { p50: Math.round(pct(wlag, 0.5)), p90: Math.round(pct(wlag, 0.9)), p95: Math.round(pct(wlag, 0.95)) },
    farPct: +(far / Math.max(1, samples) * 100).toFixed(2),
    audioFps: (() => { const f = (run.events || []).filter(e => e[1].type === 'stats' && e[1].fps).map(e => e[1].fps).slice(1); return f.length ? { min: Math.min(...f), slowPct: +(f.filter(x => x < 47).length / f.length * 100).toFixed(1) } : null; })(),
    pauses: { n: stopMs.length, stopP50: Math.round(pct(stopMs, 0.5)), stopMax: Math.round(Math.max(0, ...stopMs)), startP50: Math.round(pct(startMs, 0.5)), driftMax: +Math.max(0, ...drift).toFixed(2) },
  };
}

for (const f of process.argv.slice(2)) console.log(JSON.stringify(evaluate(f)));
