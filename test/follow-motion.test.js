// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { FollowMotion, wordDur } = require('../shared/follow-motion.js');

const WORDS = 'three years ago, i got completely lost in a city i had lived in for a decade. my phone had died. no map, no blue dot, no friendly voice telling me to turn left'.split(' ');
function run(mo, fromMs, toMs, fn) { for (let t = fromMs; t < toMs; t += 1000 / 60) { fn && fn(t); mo.step(1 / 60, t); } return toMs; }

test('word durations: short words pass quickly, punctuation takes a breath', () => {
  assert.ok(wordDur('a') < wordDur('completely'));
  assert.ok(wordDur('ago,') > wordDur('ago') + 0.2);
  assert.ok(wordDur('decade.') > wordDur('decade') + 0.4);
});

test('moves while speaking and keeps moving between recogniser updates', () => {
  const mo = new FollowMotion(); mo.setWords(WORDS);
  mo.setSpeaking(true, 0);
  let t = 0;
  for (let w = 0; w < 6; w++) { mo.cursorAt(w, t); const p0 = mo.pos; t = run(mo, t, t + 300); assert.ok(mo.pos > p0 - 1e-9, 'never moves back while speaking'); }
  const leadS = mo.tOf(mo.pos) - mo.tOf(6);
  assert.ok(mo.pos >= 6 && leadS <= 0.7 * mo.rate + 0.05, `at most ~0.7 s of speech ahead of the last confirmed word (${leadS.toFixed(2)} s)`);
});

test('stops quickly on silence and does not drift', () => {
  const mo = new FollowMotion(); mo.setWords(WORDS);
  mo.setSpeaking(true, 0);
  let t = 0;
  for (let w = 0; w < 8; w++) { mo.cursorAt(w, t); t = run(mo, t, t + 280); }
  mo.setSpeaking(false, t);
  t = run(mo, t, t + 300);
  const p = mo.pos;
  t = run(mo, t, t + 3000);
  assert.ok(Math.abs(mo.pos - p) < 0.3, `drifted ${mo.pos - p} words during silence`);
});

test('a small overshoot is waited out, not scrolled back', () => {
  const mo = new FollowMotion(); mo.setWords(WORDS);
  mo.setSpeaking(true, 0);
  mo.cursorAt(5, 0);
  let t = run(mo, 0, 1500);               // prediction runs ahead without new words
  const ahead = mo.pos;
  mo.setSpeaking(false, t); mo.cursorAt(5, t);
  run(mo, t, t + 1000);
  assert.ok(mo.pos >= ahead - 0.05, 'scrolled back');
});

test('large corrections are reported as a jump', () => {
  const mo = new FollowMotion(); mo.setWords(WORDS);
  mo.cursorAt(2, 0);
  mo.cursorAt(25, 100);
  const j = mo.takeJump();
  assert.ok(j && j.to === 26);
  assert.strictEqual(mo.takeJump(), null);
});

test('searching creeps forward slowly and fades out', () => {
  const mo = new FollowMotion(); mo.setWords(WORDS);
  mo.setSpeaking(true, 0); mo.cursorAt(4, 0);
  mo.setState('searching', 0);
  let t = run(mo, 0, 2000);
  const p2 = mo.pos;
  assert.ok(p2 > 5 && p2 < 8, 'creeps, but slowly: ' + p2);
  t = run(mo, t, 20000);
  const p20 = mo.pos;
  run(mo, t, 25000);
  assert.ok(mo.pos - p20 < 0.1, 'creeping fades out');
});
