// Replays saved recogniser output (.dev/hyp/*.json from bench.js) through the Follow matcher and
// scores it against the talk's ground truth: how fast the cursor reaches each spoken word, how
// far off it is over time, and how many wrong jumps it makes.
// Usage: node tools/follow/sim.js [hyp-file-or-glob-prefix ...] [-v]
const fs = require('fs');
const path = require('path');
const { FollowMatcher, lineWords } = require('../../shared/follow-match.js');
const { FollowMotion } = require('../../shared/follow-motion.js');
const CAPTURE = Number(process.env.SIM_CAPTURE || 0.03), RENDER = 0.016;   // s: mic -> engine, and one frame on screen
let MOTION = process.env.FOLLOW_MOTION ? JSON.parse(process.env.FOLLOW_MOTION) : {};

const ROOT = path.join(__dirname, '..', '..');
const HYP = path.join(ROOT, '.dev', 'hyp');
const verbose = process.argv.includes('-v');
const pats = process.argv.slice(2).filter(a => a !== '-v');
const files = fs.readdirSync(HYP).filter(f => !pats.length || pats.some(p => f.startsWith(p))).map(f => path.join(HYP, f));

const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function scriptOf(name) {
  const text = fs.readFileSync(path.join(ROOT, 'default-scripts', name), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/<br\s*\/?>[ \t]*\r?\n|<br\s*\/?>|\r?\n/i);
  const words = [], paraOf = [], offset = [];
  lines.forEach((l, p) => { offset[p] = words.length; for (const w of lineWords(l)) { words.push(w); paraOf.push(p); } });
  return { words, paraOf, offset };
}

function simulate(file) {
  const talk = path.basename(file).replace(/^.*?-t\d+-/, '').replace(/\.json$/, '');
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev', 'talks', talk + '.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sc = scriptOf(truth.script);
  const tw = truth.words.filter(w => w.para != null).map(w => ({ ...w, idx: sc.offset[w.para] + w.k }));
  const m = new FollowMatcher(sc.words, sc.paraOf, process.env.SIM_MATCH ? JSON.parse(process.env.SIM_MATCH) : {});
  m.anchor(0);
  const timeline = [];                                      // [t, wordIdx, state]
  const mo = new FollowMotion(MOTION); mo.setWords(sc.words);
  const disp = [];                                          // [t, pos, vel]
  let ei = 0, lastWord = m.wordIdx;
  const DT = 1 / 60;
  for (let t = 0; t < truth.duration + 1; t += DT) {
    while (ei < events.length && events[ei].t + CAPTURE <= t) {
      const e = events[ei++], tm = (e.t + CAPTURE) * 1000;
      if (e.vad != null) { mo.setSpeaking(e.vad, tm); continue; }
      const r = m.update(e.text, tm, e.final);
      if (m.wordIdx !== lastWord) { mo.cursorAt(m.wordIdx, tm, r && r.jump); lastWord = m.wordIdx; }
      mo.setState(m.state, tm); mo.setRate(m.wps);
      const last = timeline[timeline.length - 1];
      if (!last || last[1] !== m.wordIdx || last[2] !== m.state) timeline.push([e.t, m.wordIdx, m.state]);
    }
    mo.step(DT, t * 1000);
    mo.takeJump();
    disp.push([t + RENDER, mo.pos, mo.wordVel]);
  }
  const cursorAt = (t) => { let c = -1; for (const x of timeline) { if (x[0] > t) break; c = x[1]; } return c; };
  const truthAt = (t) => { let c = -1; for (const w of tw) { if (w.end > t) break; c = w.idx; } return c; };

  // latency: first time the cursor reaches the word (without overshooting far past it)
  const lat = [];
  for (const w of tw) {
    const hit = timeline.find(x => x[0] >= w.start && x[1] >= w.idx && x[1] <= w.idx + 12);
    if (hit) lat.push(Math.max(0, (hit[0] - w.end) * 1000));
  }
  // position error over time
  const errs = [];
  for (let t = 1; t < truth.duration; t += 0.05) errs.push(cursorAt(t) - truthAt(t));
  const abs = errs.map(Math.abs);
  // wrong jumps: cursor moves that land > 12 words away from the truth
  let wrong = 0; const wrongAt = [];
  for (let i = 1; i < timeline.length; i++) {
    const [t, c] = timeline[i];
    if (c !== timeline[i - 1][1] && Math.abs(c - truthAt(t + 0.3)) > 12) { wrong++; wrongAt.push(`${t.toFixed(1)}s:${c}vs${truthAt(t + 0.3)}`); }
  }
  const searching = timeline.filter(x => x[2] === 'searching').length;
  // ---- what the speaker sees ----
  const truthPos = (t) => {                                  // words completed, fractional
    let p = 0;
    for (const w of tw) { if (t >= w.end) p = w.idx + 1; else if (t > w.start) return w.idx + (t - w.start) / (w.end - w.start); else break; }
    return p;
  };
  const dlag = [];
  for (const w of tw) {
    const d = disp.find(x => x[0] >= w.start - 1 && x[1] >= w.idx + 1 && x[1] <= w.idx + 12);
    if (d) dlag.push((d[0] - w.end) * 1000);
  }
  const perr = [];                                           // position error while speaking (words)
  for (let i = 0; i < disp.length; i += 3) { const [t, p] = disp[i]; const w = tw.find(x => x.start <= t && t <= x.end); if (w) perr.push(p - truthPos(t)); }
  // pauses: time to stop after the last word, drift while silent, time to start again
  const stopMs = [], startMs = [], drift = [];
  for (let i = 1; i < truth.words.length; i++) {
    const a = truth.words[i - 1], b = truth.words[i];
    if (b.start - a.end < 0.9) continue;
    const s0 = disp.find(x => x[0] > a.end && Math.abs(x[2]) < 0.15);
    if (s0) stopMs.push((s0[0] - a.end) * 1000);
    const pA = disp.find(x => x[0] >= a.end + 0.6), pB = disp.find(x => x[0] >= b.start);
    if (pA && pB) drift.push(Math.abs(pB[1] - pA[1]));
    const g = disp.find(x => x[0] > b.start && x[2] > 0.8);
    if (g) startMs.push((g[0] - b.start) * 1000);
  }
  // time lag: how many seconds behind the speaker the displayed position is, sampled while speaking
  const byIdx = new Map(tw.map(w => [w.idx, w]));
  const tlag = [];
  for (let i = 0; i < disp.length; i += 3) {
    const [t, p] = disp[i];
    if (!tw.some(x => x.start <= t && t <= x.end + 0.05)) continue;
    const w = byIdx.get(Math.floor(p)); if (!w) continue;
    tlag.push((t - (w.start + (p - Math.floor(p)) * (w.end - w.start))) * 1000);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return {
    file: path.basename(file, '.json'), words: tw.length, reached: lat.length,
    p50: Math.round(pct(lat, 0.5)), p90: Math.round(pct(lat, 0.9)), p95: Math.round(pct(lat, 0.95)),
    within2: +(abs.filter(e => e <= 2).length / abs.length * 100).toFixed(1),
    within5: +(abs.filter(e => e <= 5).length / abs.length * 100).toFixed(1),
    maxErr: Math.max(...abs), wrong, searching,
    disp: { lag50: Math.round(pct(tlag, 0.5)), lag95: Math.round(pct(tlag, 0.95)), lag05: Math.round(pct(tlag, 0.05)), p50: Math.round(pct(dlag, 0.5)), p90: Math.round(pct(dlag, 0.9)), p95: Math.round(pct(dlag, 0.95)),
      errMean: +mean(perr).toFixed(2), errAbsP95: +pct(perr.map(Math.abs), 0.95).toFixed(2), ahead2: +(perr.filter(e => e > 2).length / perr.length * 100).toFixed(1), behind2: +(perr.filter(e => e < -2).length / perr.length * 100).toFixed(1),
      stopP50: Math.round(pct(stopMs, 0.5)), stopMax: Math.round(Math.max(...stopMs)), startP50: Math.round(pct(startMs, 0.5)),
      driftMax: +Math.max(0, ...drift).toFixed(2), pauses: stopMs.length, preMove: +Math.max(0, ...disp.filter(x => x[0] < tw[0].start).map(x => x[1])).toFixed(2) },
    ...(verbose ? { wrongAt } : {}),
  };
}

if (require.main === module) for (const f of files) console.log(JSON.stringify(simulate(f)));
module.exports = { simulate, files, setMotion: (o) => { MOTION = o; } };
