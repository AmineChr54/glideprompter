// Follow mode: aligns recognised speech to the script and decides where the speaker is.
// Pure JS with no DOM. It runs in the speech engine process and is unit-tested in Node.
//
// Script words are the whitespace-separated words of the rendered text, without cues
// (see TPParse.domWords). Each word becomes one or more matcher tokens: "turn-by-turn" gives
// turn/by/turn, and "3" gives "three". A cursor is the index of the last spoken script word.
(function (root) {
  // ---------- normalisation ----------
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]/gu, '');

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function numWords(n) {
    if (n < 20) return [ONES[n]];
    if (n < 100) return n % 10 ? [TENS[n / 10 | 0], ONES[n % 10]] : [TENS[n / 10]];
    if (n < 1000) return [ONES[n / 100 | 0], 'hundred', ...(n % 100 ? numWords(n % 100) : [])];
    if (n >= 1100 && n < 2100 && n % 100 && !(n >= 2000 && n < 2010)) return [...numWords(n / 100 | 0), ...numWords(n % 100)]; // years
    if (n < 10000) return [...numWords(n / 1000 | 0), 'thousand', ...(n % 1000 ? numWords(n % 1000) : [])];
    return [String(n)];
  }

  // One script word -> normalised tokens.
  function tokensOf(word) {
    const out = [];
    for (const part of String(word).split(/[-‐-―/]+/)) {
      const n = norm(part);
      if (!n) continue;
      if (/^\d+$/.test(n)) out.push(...numWords(Number(n)));
      else out.push(n);
    }
    return out;
  }

  // Raw script line -> rendered words, matching TPParse.domWords: cues become a word break,
  // and formatting markers disappear without one.
  function lineWords(line) {
    const t = String(line).replace(/\[[^\]]*\]/g, ' ').replace(/\{(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|[a-z]+|\/)\}/g, '')
      .replace(/\*\*|__|==|\*/g, '');
    return t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  }

  // ---------- word similarity ----------
  function lev(a, b) {
    if (a === b) return 0;
    const m = b.length; let prev = new Array(m + 1), cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[m];
  }
  // 0..1. `partial`: h may be the unfinished last word of the hypothesis.
  function sim(h, s, partial) {
    if (h === s) return 1;
    if (partial && h.length >= 3 && s.startsWith(h)) return 0.9;
    const L = Math.max(h.length, s.length);
    if (L < 4) return 0;
    const r = 1 - lev(h, s) / L;
    return r >= (L >= 6 ? 0.66 : 0.74) ? r : 0;
  }
  // Short function words carry little evidence on their own.
  const weight = (w) => (w.length <= 2 ? 0.45 : w.length === 3 ? 0.75 : 1);

  // ---------- local alignment ----------
  // Aligns hyp (all of it, ending at its last word) against script tokens [lo, hi).
  // Returns the best end position in the script plus its score and number of matched words.
  const GAP_S = 0.6, GAP_H = 0.8, SUB = 0.9;
  function alignEnd(hyp, toks, lo, hi, lastPartial) {
    const n = hyp.length, m = hi - lo;
    if (!n || m <= 0) return null;
    let prevS = new Float32Array(m + 1), curS = new Float32Array(m + 1);
    let prevC = new Uint16Array(m + 1), curC = new Uint16Array(m + 1);    // matched words on the best path
    let prevR = new Uint16Array(m + 1), curR = new Uint16Array(m + 1);    // trailing run of consecutive matches
    let best = null;
    for (let i = 1; i <= n; i++) {
      const h = hyp[i - 1], partial = lastPartial && i === n;
      curS[0] = 0; curC[0] = 0; curR[0] = 0;
      for (let j = 1; j <= m; j++) {
        const s = toks[lo + j - 1].w;
        const q = sim(h, s, partial);
        let sc = 0, c = 0, r = 0;
        const diag = q ? prevS[j - 1] + 2 * q * weight(s) : prevS[j - 1] - SUB;
        if (diag > sc) { sc = diag; c = prevC[j - 1] + (q ? 1 : 0); r = q ? prevR[j - 1] + 1 : 0; }
        const up = prevS[j] - GAP_H;          // extra hypothesis word (ad-lib / misrecognition)
        if (up > sc) { sc = up; c = prevC[j]; r = 0; }
        const left = curS[j - 1] - GAP_S;     // skipped script word
        if (left > sc) { sc = left; c = curC[j - 1]; r = 0; }
        curS[j] = sc; curC[j] = c; curR[j] = r;
      }
      // The path must end at the last hypothesis word, or the one before it (that word may still change).
      if (i >= n - 1) {
        for (let j = 1; j <= m; j++) {
          if (curR[j] === 0 && i === n) continue;
          const sc = curS[j] - (i === n ? 0 : 0.5);
          if (!best || sc > best.score + 1e-6) best = { end: lo + j - 1, score: sc, matched: curC[j], run: curR[j], tail: n - i };
        }
      }
      [prevS, curS] = [curS, prevS]; [prevC, curC] = [curC, prevC]; [prevR, curR] = [curR, prevR];
    }
    return best;
  }

  // ---------- matcher ----------
  class FollowMatcher {
    constructor(words = [], paraOf = [], opts = {}) {
      this.opts = { back: 10, ahead: 40, ctx: 14, lostMs: 1500, minScore: 3, ...opts };
      this.setWords(words, paraOf);
    }
    setWords(words, paraOf = []) {
      this.toks = [];               // {w, wi}
      words.forEach((word, wi) => { for (const w of tokensOf(word)) this.toks.push({ w, wi }); });
      this.paraOf = paraOf;
      this.nWords = words.length;
      this.reset();
    }
    reset(wordIdx = -1) {
      this.cur = -1;                // token index of the last spoken token
      this.hist = [];               // finished hypothesis words of earlier segments
      this.seg = [];                // current segment
      this.lastAcceptT = 0; this.lastWordsT = 0; this.sinceAccept = 0;
      this.wps = 2.4; this.lastMoveT = 0; this.lastMoveCur = -1;
      this.state = 'listening';
      if (wordIdx >= 0) this.anchor(wordIdx);
    }
    // Operator moved the prompter: wordIdx is the word now on the reading line.
    anchor(wordIdx) {
      const wi = Math.max(0, Math.min(this.nWords - 1, wordIdx | 0));
      let t = this.toks.findIndex(x => x.wi >= wi);
      if (t < 0) t = this.toks.length;
      this.cur = t - 1;
      this.hist = []; this.seg = [];
      this.state = 'listening'; this.sinceAccept = 0;
    }
    get wordIdx() { return this.cur < 0 ? -1 : this.toks[this.cur].wi; }
    paraOfTok(t) { return t < 0 ? 0 : this.paraOf[this.toks[t].wi] || 0; }

    // hypText: the recogniser's current partial text for this segment. Returns what changed.
    update(hypText, nowMs, isFinal = false) {
      const ws = String(hypText || '').split(/\s+/).map(norm).filter(Boolean);
      const grew = ws.length > this.seg.length || ws.some((w, i) => w !== this.seg[i]);
      this.seg = ws;
      if (grew) this.lastWordsT = nowMs;
      const res = grew ? this.step(nowMs, !isFinal) : null;
      if (isFinal) { this.hist = this.hist.concat(ws).slice(-this.opts.ctx); this.seg = []; }
      // lost: speech keeps coming but nothing lines up
      if (this.state !== 'searching' && this.sinceAccept >= 4 && nowMs - this.lastAcceptT > this.opts.lostMs) this.state = 'searching';
      return res;
    }

    step(nowMs, lastPartial) {
      const hyp = this.hist.concat(this.seg).slice(-this.opts.ctx);
      if (!hyp.length || !this.toks.length) return null;
      const O = this.opts, cur = this.cur;
      const lo = Math.max(0, cur - O.back), hi = Math.min(this.toks.length, cur + 1 + O.ahead);
      const local = alignEnd(hyp, this.toks, lo, hi, lastPartial);
      let pick = null;
      if (local && local.tail <= 1) {
        const d = local.end - cur;
        // Inside the window: two matched words in a row, or one long word right after the cursor.
        const longNext = local.run >= 1 && d >= 1 && d <= 3 && this.toks[local.end].w.length >= 5 && local.score >= 2;
        // Two matched words in a row are needed, and real evidence: a pair of tiny words like "i had" is not enough.
        const ok = d >= 0 ? ((local.run >= 2 && local.score >= O.minScore) || longNext) : (local.run >= 3 && local.score >= 5);
        if (ok && d !== 0) pick = local;
        if (ok) this.accepted(nowMs, d);
      }
      if (!pick) {
        // Re-find: the speaker may have skipped ahead or gone back. Needs a clear run of exact words.
        const g = this.findGlobal(hyp, lastPartial);
        if (g && (g.end < lo || g.end >= hi)) {
          const paraJump = Math.abs(this.paraOfTok(g.end) - this.paraOfTok(cur));
          const need = (g.end < cur ? 1 : 0) + (paraJump > 3 ? 6 : 4);
          if (g.run >= need) { pick = g; this.accepted(nowMs, g.end - cur); pick.jump = true; }
        }
      }
      if (!pick) { this.sinceAccept++; return null; }
      this.moveTo(pick.end, nowMs);
      return { word: this.wordIdx, jump: !!pick.jump, score: pick.score };
    }
    findGlobal(hyp, lastPartial) {
      const tail = hyp.slice(-8);
      const g = alignEnd(tail, this.toks, 0, this.toks.length, lastPartial);
      return g && g.tail <= 1 ? g : null;
    }
    accepted(nowMs) { this.lastAcceptT = nowMs; this.sinceAccept = 0; this.state = 'locked'; }
    moveTo(t, nowMs) {
      if (t > this.cur && this.lastMoveT && nowMs > this.lastMoveT) {
        const dt = (nowMs - this.lastMoveT) / 1000, dw = t - this.lastMoveCur;
        if (dt > 0.15 && dt < 4 && dw > 0 && dw < 25) {
          const r = Math.min(6, dw / dt);
          this.wps += (r - this.wps) * Math.min(1, dt / 3);
        }
      }
      if (t !== this.cur) { this.lastMoveT = nowMs; this.lastMoveCur = t; }
      this.cur = t;
    }
  }

  const API = { FollowMatcher, tokensOf, lineWords, norm, numWords, sim, alignEnd };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.TPFollowMatch = API;
})(this);
