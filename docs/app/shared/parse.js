// Script parsing shared by the Output and Control windows (plain browser script).
// File format (CuePrompter paste format): one line per paragraph, each ending in "<br>".
(function () {
  const BR_SPLIT = /<br\s*\/?>[ \t]*\r?\n|<br\s*\/?>|\r?\n/i;

  function toLines(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(BR_SPLIT);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
  }

  // Editor text (one line per paragraph) -> file text in "<br>" format.
  function toFileText(editorText) {
    const lines = String(editorText || '').replace(/\r\n/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('<br>\n');
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cueClass(inner) {
    const u = inner.toUpperCase();
    if (/^SLIDE\b/.test(u)) return 'cue cue-slide';
    if (/^(PAUSE|WAIT|BREATHE|BEAT|SILENCE)\b/.test(u)) return 'cue cue-pause';
    return 'cue cue-action';
  }

  // Inline formatting markup (applied to already-escaped text):
  //   **bold**  *italic*  __underline__  ==highlight==  {red}coloured{/}  {#ff8800}any hex{/}
  const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'gray'];
  function formatHtml(h) {
    return h
      .replace(/\{(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|[a-z]+)\}(.*?)\{\/\}/g, (m, c, t) =>
        c[0] === '#' ? `<span class="fc" style="color:${c}">${t}</span>`
          : COLORS.includes(c) ? `<span class="fc fc-${c}">${t}</span>` : m)
      .replace(/\*\*(?=\S)(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(?=\S)(.+?)__/g, '<u>$1</u>')
      .replace(/==(?=\S)(.+?)==/g, '<mark>$1</mark>')
      .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<i>$1</i>');
  }

  function lineToHtml(line) {
    if (line.trim() === '') return '&nbsp;';
    return formatHtml(esc(line)).replace(/\[([^\]]+)\]/g, (_, inner) =>
      '<span class="' + cueClass(inner) + '">' + inner.trim() + '</span>');
  }

  // Plain words of a line (markup and cues removed), for word counts.
  function plainWords(line) {
    return String(line).replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ')
      .replace(/\*\*|__|==|\*/g, '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
  }

  // ---------- word search (case-, accent- and punctuation-insensitive) ----------
  // "don't KNOW" matches "dont know", "Zürich" matches "zurich".
  function normChar(c) {
    if (/\s/.test(c)) return ' ';
    return c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }
  function normQuery(q) {
    let out = '', prevSpace = true;
    for (const ch of String(q || '')) {
      const n = normChar(ch);
      if (!n) continue;
      if (n === ' ') { if (prevSpace) continue; prevSpace = true; } else prevSpace = false;
      out += n;
    }
    return out.trim();
  }
  // Returns DOM Ranges for every match of query inside element (text nodes only).
  function findAll(el, query) {
    const q = normQuery(query);
    if (!q || !el) return [];
    let s = '', map = [], prevSpace = true;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const t = node.nodeValue;
      for (let i = 0; i < t.length; i++) {
        const n = normChar(t[i]);
        if (!n) continue;
        if (n === ' ') { if (prevSpace) continue; prevSpace = true; } else prevSpace = false;
        for (const ch of n) { s += ch; map.push([node, i]); }
      }
      if (!prevSpace) { s += ' '; map.push([node, t.length - 1]); prevSpace = true; } // text-node boundary = word boundary
    }
    const ranges = [];
    for (let i = s.indexOf(q); i !== -1; i = s.indexOf(q, i + q.length)) {
      const a = map[i], b = map[i + q.length - 1];
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], Math.min(b[1] + 1, b[0].nodeValue.length));
      ranges.push(r);
    }
    return ranges;
  }

  window.TPParse = { toLines, toFileText, lineToHtml, findAll, normQuery, plainWords, COLORS };
})();
