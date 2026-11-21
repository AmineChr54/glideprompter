// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { FollowMatcher, tokensOf, lineWords, sim } = require('../shared/follow-match.js');

const SCRIPT = [
  '[WALK TO CENTRE] [PAUSE]',
  'Three years ago, I got **completely lost** in a city I had lived in for a decade. [PAUSE]',
  'My phone had died. No map, no blue dot, no friendly voice telling me to turn left in two hundred metres.',
  'And for the first ten minutes, I was honestly a little scared. [BREATHE]',
  'Then something strange happened. I started to *look*.',
  '[SLIDE 2]',
  'I noticed a bakery I had walked past a hundred times without seeing.',
  'When we follow turn-by-turn directions, the parts of our brain that build mental maps get very quiet.',
  'You might find a bakery. You might find a mural. You might find a chess game.',
  'The key is to leave a little room for the {orange}unexpected{/}.',
];
function build() {
  const words = [], paraOf = [];
  SCRIPT.forEach((l, p) => lineWords(l).forEach(w => { words.push(w); paraOf.push(p); }));
  return { words, paraOf, m: new FollowMatcher(words, paraOf) };
}
const idxOf = (words, para, k) => { let n = 0; for (let p = 0; p < para; p++) n += lineWords(SCRIPT[p]).length; return n + k; };
// Feed a sentence word by word, like a streaming recogniser does.
function speak(m, text, t0 = 0, wps = 2.5, final = true) {
  const ws = text.split(' ');
  let t = t0;
  for (let i = 1; i <= ws.length; i++) { t += 1000 / wps; m.update(ws.slice(0, i).join(' '), t, final && i === ws.length); }
  return t;
}

test('tokens: cues and markup are dropped, hyphens split, numbers spelled out', () => {
  assert.deepStrictEqual(lineWords('[PAUSE] I got **completely lost** [SLIDE 3] {red}here{/}.'), ['I', 'got', 'completely', 'lost', 'here.']);
  assert.deepStrictEqual(tokensOf('turn-by-turn'), ['turn', 'by', 'turn']);
  assert.deepStrictEqual(tokensOf('3'), ['three']);
  assert.deepStrictEqual(tokensOf('2026'), ['twenty', 'twenty', 'six']);
  assert.deepStrictEqual(tokensOf("don't"), ['dont']);
  assert.deepStrictEqual(tokensOf('Café,'), ['cafe']);
});

test('similarity tolerates spelling variants and partial words', () => {
  assert.ok(sim('meters', 'metres') > 0);
  assert.ok(sim('optimize', 'optimise') > 0);
  assert.ok(sim('comp', 'completely', true) > 0);
  assert.strictEqual(sim('comp', 'completely', false), 0);
  assert.strictEqual(sim('a', 'i'), 0);
});

test('follows a verbatim reading word by word', () => {
  const { words, m } = build();
  m.anchor(0);
  speak(m, 'three years ago i got completely lost in a city');
  assert.strictEqual(m.wordIdx, idxOf(words, 1, 9));   // "city"
  assert.strictEqual(m.state, 'locked');
});

test('partial last word moves the cursor early', () => {
  const { words, m } = build();
  m.anchor(0);
  m.update('three years ago i got comp', 2000);
  assert.strictEqual(m.wordIdx, idxOf(words, 1, 5));   // "completely"
});

test('an ad-lib does not move the cursor, and reading continues afterwards', () => {
  const { words, m } = build();
  m.anchor(0);
  let t = speak(m, 'three years ago i got completely lost in a city i had lived in for a decade');
  const before = m.wordIdx;
  t = speak(m, 'and honestly i still remember that afternoon very clearly', t);
  assert.ok(Math.abs(m.wordIdx - before) <= 1, `moved during ad-lib: ${before} -> ${m.wordIdx}`);
  speak(m, 'my phone had died no map no blue dot', t);
  assert.strictEqual(m.wordIdx, idxOf(words, 2, 8));
});

test('hyphenated script words match separate spoken words', () => {
  const { words, m } = build();
  m.anchor(idxOf(words, 7, 0));
  speak(m, 'when we follow turn by turn directions');
  assert.strictEqual(m.wordIdx, idxOf(words, 7, 4));
});

test('skipping ahead re-finds the place after a clear run of words', () => {
  const { words, m } = build();
  m.anchor(0);
  let t = speak(m, 'three years ago i got completely lost');
  t = speak(m, 'the key is to leave a little room', t);
  assert.strictEqual(m.wordIdx, idxOf(words, 9, 7));
});

test('one or two stray words never cause a jump', () => {
  const { words, m } = build();
  m.anchor(0);
  let t = speak(m, 'three years ago i got completely lost');
  const before = m.wordIdx;
  speak(m, 'bakery mural', t);
  assert.strictEqual(m.wordIdx, before);
});

test('repeated phrases resolve to the nearest one ahead', () => {
  const { words, m } = build();
  m.anchor(idxOf(words, 8, 0));
  let t = speak(m, 'you might find a bakery');
  assert.strictEqual(m.wordIdx, idxOf(words, 8, 4));
  t = speak(m, 'you might find a mural', t);
  assert.strictEqual(m.wordIdx, idxOf(words, 8, 9));
});

test('anchor puts the cursor before the given word', () => {
  const { words, m } = build();
  m.anchor(idxOf(words, 4, 0));
  speak(m, 'then something strange happened');
  assert.strictEqual(m.wordIdx, idxOf(words, 4, 3));
});
