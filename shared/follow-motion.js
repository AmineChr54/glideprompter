// Follow mode: turns matcher updates into smooth motion.
// Used by the Output window and by tools/follow/sim.js, so the simulation scores the same motion
// the speaker sees.
//
// Positions are "words already spoken" (fractional): pos = 12.5 means half of word 12 is said.
// Internally it works in estimated speaking time. Every script word gets a nominal duration
// from its syllables, letters and punctuation, so short words like "a" or "to" pass quickly,
// and a full stop takes a breath.
//
// The recogniser reports a word about 0.3 s after it is said. To hide that delay, the target keeps
// moving at the speaker's measured pace while they talk (capped a little ahead of the last
// confirmed word), and the recogniser only corrects it. Silence (VAD) stops the prediction.
(function (root) {
  const DEF = {
    lag: 0.38,         // s: typical recogniser delay that the prediction makes up for
    maxLead: 0.55,     // s of speech the prediction may run ahead of the last confirmed word
    k: 5,              // 1/s: how fast position errors are closed
    tau: 0.07,         // s: velocity smoothing (start / stop easing)
    holdBack: 0.8,     // s: a smaller overshoot is waited out instead of scrolling back (> maxLead)
    jump: 7,           // words: larger corrections are a jump (the Output glides there)
    creep: 0.2,        // fraction of the speaking rate while searching
    creepDecay: 4,     // s: creeping fades out over this time
    onsetLead: 0.35,   // s: after a pause, how far the prediction may go before the recogniser confirms a word
    onsetHead: 0.15,   // s: the voice detector notices speech about this late
    freshMax: 1.5,     // s: voice without any matching script word for this long is not the speaker
  };
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function syllables(n) {
    n = n.replace(/\d/g, 'aa');
    let c = (n.match(/[aeiouy]+/g) || []).length;
    if (/[^aeiou]e$/.test(n) && c > 1) c--;
    return Math.max(1, c);
  }
  // Nominal seconds from the start of this word to the start of the next (fitted on test talks).
  function wordDur(word) {
    const n = norm(word);
    return 0.015 + 0.037 * syllables(n) + 0.047 * n.length + (/[.!?]["')\]]*$/.test(word) ? 0.48 : /[,;:–—]["')\]]*$/.test(word) ? 0.3 : 0);
  }

  class FollowMotion {
    constructor(opts = {}) { this.o = { ...DEF, ...opts }; this.setWords([]); }
    setWords(words) {
      this.W = new Float64Array(words.length + 1);
      for (let i = 0; i < words.length; i++) this.W[i + 1] = this.W[i] + wordDur(words[i]);
      this.n = words.length;
      this.reset(0);
    }
    // word space <-> time space
    tOf(pos) {
      if (!this.n) return pos * 0.3;
      const i = Math.max(0, Math.min(this.n - 1, Math.floor(pos)));
      return this.W[i] + (pos - i) * (this.W[i + 1] - this.W[i]);
    }
    posOf(w) {
      if (!this.n) return w / 0.3;
      let lo = 0, hi = this.n - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.W[m] <= w) lo = m; else hi = m - 1; }
      const d = this.W[lo + 1] - this.W[lo];
      return Math.min(this.n, lo + (d > 0 ? (w - this.W[lo]) / d : 0));
    }
    get pos() { return this.posOf(this.w); }

    reset(pos = 0) {
      this.w = this.tOf(pos); this.vel = 0;
      this.cursor = pos - 1; this.tCursor = -Infinity;
      this.speaking = false; this.tSpeak = 0;
      this.state = 'listening'; this.tState = 0;
      this.rate = 1; this.hist = [];
      this.frozen = this.w; this.pendingJump = null;
      this.fresh = false; this.tQuiet = -Infinity;
    }
    // Matcher: `word` (index of the last spoken word) was just recognised.
    cursorAt(word, tMs, isJump = false) {
      const wT = this.tOf(word + 1), pos = this.pos;
      if (isJump || Math.abs(word + 1 - pos) > this.o.jump) {
        this.pendingJump = { from: pos, to: word + 1 };
        this.w = wT; this.vel = 0; this.frozen = wT; this.hist = [];
      } else if (word > this.cursor && this.speaking) {
        // pace: confirmed progress over the last ~2 s of continuous speech
        this.hist.push([tMs, wT]);
        while (this.hist.length > 2 && tMs - this.hist[1][0] > 2000) this.hist.shift();
        const [t0, w0] = this.hist[0];
        if (tMs - t0 > 900) this.rate += (Math.max(0.55, Math.min(2, (wT - w0) / ((tMs - t0) / 1000))) - this.rate) * 0.35;
      }
      if (word > this.cursor) this.fresh = false;
      this.cursor = word; this.tCursor = tMs;
      if (!this.speaking) this.frozen = Math.max(this.frozen, wT);
    }
    setSpeaking(on, tMs) {
      if (on === this.speaking) return;
      this.speaking = on; this.tSpeak = tMs;
      const base = this.tOf(this.cursor + 1);
      if (!on) { this.frozen = Math.max(base, Math.min(this.w, base + 0.25)); this.tQuiet = tMs; }
      else {
        this.hist = [[tMs, base]];
        // After a real pause, a cough or a click must not run the text ahead: limit the lead until a word is confirmed.
        if (tMs - this.tQuiet > 700 && !this.fresh) { this.fresh = true; this.tFresh = tMs; }
      }
    }
    setState(s, tMs) { if (s !== this.state) { this.state = s; this.tState = tMs; } }
    setRate() {}                           // kept for API compatibility: the pace is measured here
    // Returns a jump {from, to} once, if one happened since the last call.
    takeJump() { const j = this.pendingJump; this.pendingJump = null; return j; }

    target(tMs) {
      const o = this.o;
      if (!this.speaking) return this.frozen;
      if (this.state === 'searching') return null;
      let lead = Math.min(o.maxLead * this.rate, this.rate * (o.lag + Math.max(0, tMs - this.tCursor) / 1000));
      if (this.fresh) {
        // talking for a while and still not one script word: not the speaker reading (TV, chatter), so hold
        const since = (tMs - this.tFresh) / 1000;
        lead = since > o.freshMax ? 0 : Math.min(lead, this.rate * Math.min(o.onsetLead, o.onsetHead + since));
      }
      return this.tOf(this.cursor + 1) + lead;
    }

    step(dt, tMs) {
      const o = this.o;
      if (dt <= 0) return this.pos;
      const tgt = this.target(tMs);
      let want;
      if (tgt == null) {
        // searching: creep forward slowly, fading out (but never stay behind a confirmed word)
        const age = (tMs - this.tState) / 1000, behind = this.tOf(this.cursor + 1) - this.w;
        // only creep if the speaker was really on the script a moment ago (not for a TV or chatter in the room)
        const recent = !this.fresh && tMs - this.tCursor < 5000;
        want = (recent ? this.rate * o.creep * Math.exp(-age / o.creepDecay) : 0) + (behind > 0 ? o.k * behind : 0);
      } else {
        const err = tgt - this.w;
        if (err < 0 && err > -o.holdBack) want = 0;          // ran a bit ahead: wait for the speaker
        else want = (this.speaking && err > -0.2 ? this.rate * 0.6 : 0) + o.k * err;
        if (!this.speaking && err < 0) want = Math.max(want, -0.5 * o.k);
        want = Math.max(-3, Math.min(4, want));
      }
      this.vel += (want - this.vel) * (1 - Math.exp(-dt / o.tau));
      if (tgt != null && !this.speaking && this.vel > 0 && this.w + this.vel * dt > tgt) this.vel = Math.max(0, (tgt - this.w) / dt);
      this.w = Math.max(0, this.w + this.vel * dt);
      return this.pos;
    }
    // Speed in words per second, for display / tests.
    get wordVel() { const p = this.pos, i = Math.max(0, Math.min(this.n - 1, Math.floor(p))); const d = this.n ? this.W[i + 1] - this.W[i] : 0.3; return this.vel / (d || 0.3); }
  }

  const API = { FollowMotion, DEF, wordDur };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.TPFollowMotion = API;
})(this);
