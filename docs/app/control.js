// Control window: toolbar, speakers, script overview, editor. Sends actions; Output owns state.
(() => {
  const $ = (id) => document.getElementById(id);
  const act = (a) => tp.action(a);

  let current = null;          // current load payload
  let S = {};                  // current settings
  let speakers = [];
  let lastPara = -1, paraEls = [], listEls = [], miniEls = [], userScrolledAt = 0;
  let view = 'mini';
  try { view = localStorage.getItem('glideprompter.scriptView') === 'list' ? 'list' : 'mini'; } catch {}
  let dirty = false;
  let lastReport = null;       // last runtime report from Output

  const pxPerSec = (speed) => (speed <= 0 ? 0 : 1000 / Math.max(4, 40 - speed));
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------------- settings UI ----------------
  const SLIDERS = {
    fontSize: (v) => v, margin: (v) => v, speed: (v) => v,
    readingLine: (v) => Math.round(v * 100), lineHeight: (v) => Number(v).toFixed(2), timerSize: (v) => v,
    letterSpacing: (v) => Number(v).toFixed(2),
  };
  function showSettings(s) {
    S = { ...s };
    for (const k of Object.keys(SLIDERS)) {
      const el = $(k);
      if (document.activeElement !== el || !el.matches(':active')) el.value = S[k];
      $(k + 'V').textContent = SLIDERS[k](S[k]);
    }
    $('bg').value = S.bg; $('fg').value = S.fg;
    $('btnMirrorH').classList.toggle('on', !!S.mirrorH);
    $('btnMirrorV').classList.toggle('on', !!S.mirrorV);
    $('btnGuide').classList.toggle('on', !!S.showGuide);
    $('alignPath').setAttribute('d', S.align === 'center' ? 'M6 9h28M10 16h20M6 23h28M10 30h20' : 'M6 9h28M6 16h20M6 23h28M6 30h20');
    $('showTimer').checked = S.showTimer !== false;
    $('showProgress').checked = !!S.showProgress;
    // text
    $('fontFamily').value = S.fontFamily || 'Arial';
    $('fontWeight').value = String(S.fontWeight || 400);
    $('editor').style.fontFamily = `"${S.fontFamily || 'Arial'}", Arial, sans-serif`;
    // timer
    $('timerMode').value = S.timerMode || 'up';
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === (S.timerMode || 'up')));
    if (document.activeElement !== $('timerTarget')) $('timerTarget').value = TPTimer.clock(S.timerTarget || 0);
    if (document.activeElement !== $('timerWarn')) $('timerWarn').value = S.timerWarn ?? 60;
    $('timerOvertime').checked = S.timerOvertime !== false;
    $('timerPos').value = S.timerPos || 'tr';
    $('timerFg').value = S.timerFg || '#ffffff';
    $('timerBg').value = S.timerBg || '#000000';
    renderTimer();
    renderStats();
    styleMini();
  }
  for (const k of Object.keys(SLIDERS)) {
    $(k).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $(k + 'V').textContent = SLIDERS[k](v);
      act({ a: 'set', key: k, value: v });
    });
    $(k).addEventListener('pointerup', (e) => e.target.blur());
  }
  $('bg').addEventListener('input', (e) => act({ a: 'set', key: 'bg', value: e.target.value }));
  $('fg').addEventListener('input', (e) => act({ a: 'set', key: 'fg', value: e.target.value }));
  $('showTimer').addEventListener('change', (e) => { act({ a: 'set', key: 'showTimer', value: e.target.checked }); e.target.blur(); });
  $('showProgress').addEventListener('change', (e) => { act({ a: 'set', key: 'showProgress', value: e.target.checked }); e.target.blur(); });
  const onSelect = (id, conv = (v) => v) => $(id).addEventListener('change', (e) => { act({ a: 'set', key: id, value: conv(e.target.value) }); e.target.blur(); });
  onSelect('fontFamily'); onSelect('fontWeight', Number); onSelect('timerMode'); onSelect('timerPos');
  $('timerOvertime').addEventListener('change', (e) => { act({ a: 'set', key: 'timerOvertime', value: e.target.checked }); e.target.blur(); });
  $('timerFg').addEventListener('input', (e) => act({ a: 'set', key: 'timerFg', value: e.target.value }));
  $('timerBg').addEventListener('input', (e) => act({ a: 'set', key: 'timerBg', value: e.target.value }));
  document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => act({ a: 'set', key: 'timerMode', value: b.dataset.mode }));
  function commitTarget() {
    const sec = TPTimer.parse($('timerTarget').value);
    if (sec == null) { $('timerTarget').value = TPTimer.clock(S.timerTarget || 0); toast('Type the target as mm:ss, e.g. 10:00'); return; }
    act({ a: 'set', key: 'timerTarget', value: sec });
    $('timerTarget').value = TPTimer.clock(sec);
  }
  $('timerTarget').addEventListener('change', commitTarget);
  $('timerTarget').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('timerTarget').blur(); } });
  $('timerWarn').addEventListener('change', (e) => act({ a: 'set', key: 'timerWarn', value: Math.max(0, Number(e.target.value) || 0) }));
  $('timerWarn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  $('btnPlay').onclick = () => act({ a: 'togglePlay' });
  $('btnAlign').onclick = () => act({ a: 'toggleAlign' });
  $('btnMirrorH').onclick = () => act({ a: 'toggle', key: 'mirrorH' });
  $('btnMirrorV').onclick = () => act({ a: 'toggle', key: 'mirrorV' });
  $('btnGuide').onclick = () => act({ a: 'toggle', key: 'showGuide' });
  $('btnTimer').onclick = () => act({ a: 'timerToggle' });
  $('btnTimerReset').onclick = () => act({ a: 'timerReset' });
  // +/-30s always change the *shown* number (in count-down mode that means less / more elapsed time).
  const bump = (sign) => act({ a: 'timerAdd', ms: sign * 30000 * (S.timerMode === 'down' ? -1 : 1) });
  $('btnTimerPlus').onclick = () => bump(+1);
  $('btnTimerMinus').onclick = () => bump(-1);
  $('btnFull').onclick = () => act({ a: 'fullscreen', display: Number($('display').value) });
  $('btn1080').onclick = () => act({ a: 'size1080' });
  $('btnShowOut').onclick = () => act({ a: 'showOutput' });
  $('onTop').addEventListener('change', (e) => { act({ a: 'onTop', value: e.target.checked }); e.target.blur(); });
  $('display').addEventListener('change', (e) => { act({ a: 'display', id: Number(e.target.value) }); e.target.blur(); });
  $('btnSaveDefault').onclick = () => act({ a: 'saveDefault' });
  $('btnResetDefault').onclick = () => act({ a: 'resetDefault' });
  $('btnFolder').onclick = async () => { const d = await tp.changeFolder(); if (d) $('folder').textContent = d; };

  // Buttons never take keyboard focus, so Space always means Play/Pause.
  document.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  // ---------------- speakers ----------------
  function renderSpeakers() {
    const ul = $('speakers'); ul.innerHTML = '';
    speakers.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = s.file === (current && current.file) ? 'active' : '';
      li.dataset.file = s.file;
      li.title = s.file + (s.num >= 1 && s.num <= 9 ? `  (Ctrl+${s.num})` : '');
      li.innerHTML = `<span class="num"></span><span class="nm"></span><span class="tm"></span><span class="bar"><i></i></span>`;
      li.querySelector('.num').textContent = s.num ?? '•';
      li.querySelector('.nm').textContent = s.name;
      li.querySelector('.tm').textContent = TPTimer.view(s.timerMs, s.timer).text;
      li.querySelector('.bar i').style.width = Math.round((s.progress || 0) * 100) + '%';
      li.onclick = () => { if (!confirmLeaveEditor()) return; act({ a: 'speakerFile', file: s.file }); };
      ul.appendChild(li);
    });
  }
  function confirmLeaveEditor() {
    if (!dirty) return true;
    return window.confirm('The script has unsaved changes. Discard them?');
  }
  $('newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('newName').value.trim();
    if (!name || !confirmLeaveEditor()) return;
    const f = await tp.newSpeaker(name);
    if (f) { $('newName').value = ''; $('newName').blur(); switchTab('edit'); $('editor').focus(); }
  });

  // ---------------- overview + editor ----------------
  function renderOverview(text) {
    const lines = TPParse.toLines(text);
    const html = lines.map((l, i) => `<p data-i="${i}">${TPParse.lineToHtml(l)}</p>`).join('');
    $('overview').innerHTML = html;
    $('miniContent').innerHTML = html || '<p>&nbsp;</p>';
    listEls = Array.from($('overview').children);
    miniEls = Array.from($('miniContent').children);
    paraEls = view === 'mini' ? miniEls : listEls;
    lastPara = -1;
  }
  const clickPara = (e) => { const p = e.target.closest('p[data-i]'); if (p) act({ a: 'gotoPara', i: Number(p.dataset.i) }); };
  $('overview').addEventListener('click', clickPara);
  $('miniContent').addEventListener('click', clickPara);
  $('overview').addEventListener('wheel', () => { userScrolledAt = performance.now(); }, { passive: true });

  function markPara(i) {
    if (i === lastPara || !listEls.length) return;
    const prev = lastPara; lastPara = i;
    for (const els of [listEls, miniEls]) {
      if (prev < 0 || Math.abs(prev - i) > 1) els.forEach((p, k) => { p.classList.toggle('past', k < i); p.classList.toggle('cur', k === i); });
      else { els[prev] && els[prev].classList.remove('cur'); els[prev] && els[prev].classList.toggle('past', prev < i);
             els[i] && els[i].classList.add('cur'); els[i] && els[i].classList.remove('past'); }
    }
    if (view === 'list' && listEls[i] && $('tab-script').classList.contains('active') && performance.now() - userScrolledAt > 2500) {
      listEls[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // ---------------- prompter view: a scaled replica of the Output window ----------------
  // Laid out at the output's real width with the same font settings (so lines wrap identically),
  // then scaled to the panel width. The frame marks what the speaker currently sees.
  const mini = { y: 0, shown: 0, at: 0, vw: 1280, vh: 720, k: 0.5, raf: 0, last: 0 };
  function setView(v) {
    view = v;
    try { localStorage.setItem('glideprompter.scriptView', v); } catch {}
    $('tab-script').dataset.view = v;
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    paraEls = v === 'mini' ? miniEls : listEls;
    if ($('q').value) runSearch();
    if (v === 'list' && listEls[lastPara]) listEls[lastPara].scrollIntoView({ block: 'center' });
    styleMini();
  }
  document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.view));
  function styleMini() {
    const c = $('miniContent'), st = c.style;
    st.width = mini.vw + 'px';
    st.padding = `0 ${(S.margin / 100) * mini.vw}px`;   // % would resolve against the panel, not the output
    st.fontFamily = `"${S.fontFamily || 'Arial'}", Arial, sans-serif`;
    st.fontWeight = S.fontWeight || 400;
    st.letterSpacing = (S.letterSpacing || 0) + 'em';
    st.fontSize = S.fontSize + 'px';
    st.lineHeight = S.lineHeight;
    st.textAlign = S.align || 'left';
    st.color = S.fg || '#fff';
    $('mini').style.background = S.bg || '#000';
    const t = $('miniTimer');
    t.hidden = S.showTimer === false;
    t.dataset.pos = S.timerPos || 'tr';
    t.style.color = S.timerFg || '#fff';
    t.style.background = (S.timerBg || '#000000') + 'bf';
    $('miniGuide').hidden = !S.showGuide;
    mini.dirty = true;
  }
  function frameMini(now) {
    mini.raf = 0;
    const box = $('mini');
    if (view !== 'mini' || !$('tab-script').classList.contains('active') || !box.clientWidth) return;
    const dt = Math.min(0.1, (now - (mini.last || now)) / 1000); mini.last = now;
    // follow the reported position; extrapolate while playing so the motion stays smooth between reports
    const r = lastReport;
    let target = mini.y;
    if (r && r.playing) target = mini.y + Math.min(0.3, (now - mini.at) / 1000) * pxPerSec(r.speed);
    mini.shown = Math.abs(target - mini.shown) > 4000 ? target : mini.shown + (target - mini.shown) * (1 - Math.exp(-dt / 0.07));
    // The speaker's screen takes about half the panel height, so there is script before and after it.
    const W = box.clientWidth, H = box.clientHeight;
    const k = Math.min(W / mini.vw, (H * 0.5) / mini.vh);
    const lineH = S.fontSize * S.lineHeight, readY = S.readingLine * mini.vh;
    const frameW = mini.vw * k, frameH = mini.vh * k;
    const frameTop = Math.max(0, (H - frameH) * 0.45), frameLeft = (W - frameW) / 2;
    const ty = frameTop + (readY - lineH / 2 - mini.shown) * k;
    $('miniContent').style.transform = `translate3d(${frameLeft.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${k.toFixed(5)})`;
    if (mini.dirty || mini.k !== k || mini.H !== H || mini.W !== W) {
      mini.k = k; mini.H = H; mini.W = W; mini.dirty = false;
      const f = $('miniFrame').style; f.top = frameTop + 'px'; f.height = frameH + 'px'; f.left = frameLeft + 'px'; f.width = frameW + 'px';
      $('miniTimer').style.fontSize = (S.timerSize * k) + 'px';
      const g = $('miniGuide').style; g.top = (frameTop + readY * k) + 'px'; g.left = frameLeft + 'px'; g.width = frameW + 'px';
    }
    // keep animating only while something is moving
    if ((r && r.playing) || Math.abs(target - mini.shown) > 0.05) mini.raf = requestAnimationFrame(frameMini);
    else mini.last = 0;
  }
  function kickMini() { if (!mini.raf) mini.raf = requestAnimationFrame(frameMini); }
  $('mini').addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = (e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY) / (mini.k || 1);
    act({ a: 'scrollBy', px });
  }, { passive: false });
  new ResizeObserver(kickMini).observe($('mini'));

  function setDirty(d) { dirty = d; $('dirty').textContent = d ? '● unsaved changes' : ''; }
  let statsTimer = 0;
  $('editor').addEventListener('input', () => { setDirty(true); clearTimeout(statsTimer); statsTimer = setTimeout(renderStats, 300); });

  // Replace the editor selection through execCommand so native undo / redo (Ctrl+Z / Ctrl+Y) keeps working.
  function replaceSel(text, selFrom, selTo) {
    const ed = $('editor');
    ed.focus();
    if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, 'end');
    if (selFrom != null) { const st = ed.selectionEnd - text.length; ed.setSelectionRange(st + selFrom, st + selTo); }
  }
  // Wrap the selection in markers, or remove them if it is already wrapped.
  function wrapSel(open, close = open) {
    const ed = $('editor'); ed.focus();
    let a = ed.selectionStart, b = ed.selectionEnd;
    const v = ed.value, sel = v.slice(a, b);
    if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
      const inner = sel.slice(open.length, sel.length - close.length);
      replaceSel(inner, 0, inner.length); return;
    }
    if (v.slice(a - open.length, a) === open && v.slice(b, b + close.length) === close &&
        !(open === '*' && (v[a - 2] === '*' || v[b + 1] === '*'))) {
      ed.setSelectionRange(a - open.length, b + close.length);
      replaceSel(sel, 0, sel.length); return;
    }
    // keep surrounding spaces outside the markers
    const lead = sel.match(/^\s*/)[0], trail = sel.slice(lead.length).match(/\s*$/)[0];
    const core = sel.slice(lead.length, sel.length - trail.length);
    replaceSel(lead + open + core + close + trail, lead.length + open.length, lead.length + open.length + core.length);
  }
  document.querySelectorAll('.fmt').forEach(b => b.onclick = () => wrapSel(b.dataset.wrap));
  $('fmtColor').addEventListener('change', (e) => {
    const c = e.target.value; e.target.value = '';
    if (c) wrapSel('{' + c + '}', '{/}'); else $('editor').focus();
  });
  $('fmtCue').addEventListener('change', (e) => {
    const c = e.target.value; e.target.value = '';
    if (!c) return;
    const ed = $('editor'), before = ed.value.slice(0, ed.selectionStart);
    replaceSel((before && !/\s$/.test(before) ? ' ' : '') + c + ' ');
  });

  function renderStats() {
    const text = $('editor').value;
    if (!current) { $('stats').textContent = ''; return; }
    const lines = text.split('\n');
    const words = lines.reduce((n, l) => n + TPParse.plainWords(l), 0);
    const parts = [`${words} words`, `${lines.filter(l => l.trim()).length} paragraphs`];
    if (words) parts.push(`≈ ${TPTimer.clock(words / 130 * 60)} spoken at 130 wpm`);
    if (lastReport && lastReport.scrollPx && S.speed) {
      parts.push(`≈ ${TPTimer.clock(lastReport.scrollPx / pxPerSec(S.speed))} to scroll through at speed ${S.speed}${dirty ? ' (saved text)' : ''}`);
    }
    $('stats').textContent = parts.join('  ·  ');
  }
  async function save() {
    if (!current) return;
    await tp.saveScript(current.file, TPParse.toFileText($('editor').value));
    setDirty(false); renderStats(); toast('Script saved');
  }
  $('btnSave').onclick = save;
  $('btnRevert').onclick = () => { if (current) { $('editor').value = TPParse.toLines(current.text).join('\n'); setDirty(false); renderStats(); } };

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'script' && view === 'list' && listEls[lastPara]) listEls[lastPara].scrollIntoView({ block: 'center' });
    if (name === 'script') kickMini();
  }
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

  // ---------------- word search ----------------
  // Typing only highlights + scrolls this overview; Enter moves the prompter (Output) to the match.
  let qMatches = [], qCur = -1, qTimer = 0;
  const hasHL = typeof Highlight !== 'undefined' && CSS.highlights;
  function runSearch() {
    const q = $('q').value;
    qMatches = []; qCur = -1;
    const all = hasHL ? new Highlight() : null;
    if (TPParse.normQuery(q)) {
      paraEls.forEach((p, i) => TPParse.findAll(p, q).forEach((r, k) => { qMatches.push({ para: i, nth: k, range: r }); all && all.add(r); }));
    }
    if (hasHL) { CSS.highlights.set('tp-search', all); CSS.highlights.delete('tp-search-cur'); }
    const c = candidate();
    if (c >= 0) showMatch(c); else setCount();
  }
  // First match at/after the speaker's current paragraph (they are usually ahead of you).
  function candidate() {
    if (!qMatches.length) return -1;
    const i = qMatches.findIndex(m => m.para >= Math.max(lastPara, 0));
    return i === -1 ? 0 : i;
  }
  function setCount(i) {
    const el = $('qCount'), q = TPParse.normQuery($('q').value);
    el.classList.toggle('none', !!q && !qMatches.length);
    el.textContent = !q ? '' : !qMatches.length ? 'no match' : (i == null ? '' : (i + 1) + ' / ') + qMatches.length;
  }
  function showMatch(i) {
    const m = qMatches[i];
    if (hasHL) CSS.highlights.set('tp-search-cur', new Highlight(m.range));
    userScrolledAt = performance.now();
    if (view === 'list' && $('tab-script').classList.contains('active')) paraEls[m.para].scrollIntoView({ block: 'center' });
    setCount(i);
  }
  function searchNav(d) {
    if (!qMatches.length) return;
    const n = qMatches.length;
    if (qCur === -1) { const c = candidate(); qCur = d > 0 ? c : (c - 1 + n) % n; }
    else qCur = (qCur + d + n) % n;
    showMatch(qCur);
    const m = qMatches[qCur];
    act({ a: 'findGo', q: $('q').value, para: m.para, nth: m.nth });
  }
  function clearSearch() {
    $('q').value = ''; qMatches = []; qCur = -1; setCount();
    if (hasHL) { CSS.highlights.delete('tp-search'); CSS.highlights.delete('tp-search-cur'); }
  }
  function focusSearch() {
    switchTab('script');
    $('q').focus(); $('q').select();
  }
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 120); });
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(qTimer); if (qCur === -1 && !qMatches.length) runSearch();
      searchNav(e.shiftKey ? -1 : 1);
      if (qMatches.length) $('q').blur();   // hand the keyboard back to the prompter shortcuts
    } else if (e.key === 'Escape') { clearSearch(); $('q').blur(); }
  });
  $('qNext').onclick = () => searchNav(1);
  $('qPrev').onclick = () => searchNav(-1);
  $('qClear').onclick = clearSearch;

  // ---------------- timer display + manual edit ----------------
  function renderTimer() {
    if (!lastReport) return;
    const v = TPTimer.view(lastReport.timerMs, S);
    for (const el of [$('timer'), $('miniTimer')]) {
      el.textContent = v.text;
      el.classList.toggle('warn', v.state === 'warn');
      el.classList.toggle('over', v.state === 'over');
    }
  }
  function editTimer() {
    const inp = $('timerEdit');
    inp.value = $('timer').textContent;
    $('timer').hidden = true; inp.hidden = false;
    inp.focus(); inp.select();
  }
  function endEditTimer(apply) {
    const inp = $('timerEdit');
    if (inp.hidden) return;
    if (apply) {
      const raw = inp.value.trim(), sec = TPTimer.parse(raw);
      if (sec == null) toast('Type a time like 05:30');
      else act({ a: 'timerSet', ms: TPTimer.elapsedFor(raw.startsWith('-') ? -sec : sec, S) });
    }
    inp.hidden = true; $('timer').hidden = false;
  }
  $('timer').addEventListener('click', editTimer);
  $('timerEdit').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); endEditTimer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endEditTimer(false); }
  });
  $('timerEdit').addEventListener('blur', () => endEditTimer(true));

  // ---------------- help ----------------
  $('helpTable').innerHTML = TPKeys.HELP.filter(([k]) => k !== 'M' || tp.follow).map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('');
  const toggleHelp = (show) => { $('help').hidden = show === undefined ? !$('help').hidden : !show; };
  $('btnHelp').onclick = () => toggleHelp();
  $('btnHelpClose').onclick = () => toggleHelp(false);
  $('help').addEventListener('click', (e) => { if (e.target.id === 'help') toggleHelp(false); });

  // ---------------- keyboard ----------------
  const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(el.type)));
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (current) save(); return; }
    if (e.ctrlKey && !e.shiftKey && e.code === 'KeyF') { e.preventDefault(); focusSearch(); return; }
    if (document.activeElement === $('editor') && e.ctrlKey && !e.altKey) {
      const w = !e.shiftKey && { KeyB: '**', KeyI: '*', KeyU: '__' }[e.code] || (e.shiftKey && e.code === 'KeyH' && '==');
      if (w) { e.preventDefault(); wrapSel(w); return; }
    }
    if (isTextField(document.activeElement)) {
      if (e.key === 'Escape') { if (document.activeElement.id === 'timerEdit') endEditTimer(false); document.activeElement.blur(); }
      return;
    }
    if (e.key === '?' || e.key === 'F1') { e.preventDefault(); toggleHelp(); return; }
    if (e.key === 'Escape' && !$('help').hidden) { toggleHelp(false); return; }
    const a = TPKeys.keyToAction(e, 'down');
    if (!a) return;
    e.preventDefault();
    if (a.a === 'speaker' && !confirmLeaveEditor()) return;
    if (a.a === 'searchNav') { searchNav(a.d); return; }
    if (a.a === 'focusSearch') { focusSearch(); return; }
    act(a);
  }, true);
  window.addEventListener('keyup', (e) => {
    const a = TPKeys.keyToAction(e, 'up');
    if (a) act(a); // always release, even if focus moved into a text field meanwhile
  }, true);

  // ---------------- IPC ----------------
  tp.on('load', (p) => {
    const sameFile = current && current.file === p.file;
    current = p;
    $('speakerTitle').textContent = (p.num != null ? p.num + ' · ' : '') + p.name;
    showSettings(p.settings);
    renderOverview(p.text);
    if ($('q').value) runSearch();
    if (!sameFile || !dirty) { $('editor').value = TPParse.toLines(p.text).join('\n'); setDirty(false); }
    if (!sameFile) { lastReport = { timerMs: p.timerMs || 0, scrollPx: 0 }; mini.shown = mini.y; }
    kickMini();
    renderTimer(); renderStats();
    renderSpeakers();
  });
  tp.on('speakers', ({ list }) => { speakers = list; renderSpeakers(); });
  tp.on('settings', showSettings);
  tp.on('report', (r) => {
    const scrollChanged = !lastReport || lastReport.scrollPx !== r.scrollPx;
    lastReport = r;
    if (r.y != null) { mini.y = r.y; mini.at = performance.now(); }
    if (r.vw && (r.vw !== mini.vw || r.vh !== mini.vh)) { mini.vw = r.vw; mini.vh = r.vh; styleMini(); }
    kickMini();
    renderTimer();
    if (scrollChanged) renderStats();
    $('timer').classList.toggle('running', r.timerRunning);
    $('btnTimer').textContent = r.timerRunning ? 'Stop' : 'Start';
    $('btnTimer').classList.toggle('on', r.timerRunning);
    $('icPlay').hidden = r.playing; $('icPause').hidden = !r.playing;
    $('btnPlay').classList.toggle('on', r.playing);
    $('progressFill').style.transform = `scaleX(${r.progress.toFixed(4)})`;
    $('progressText').textContent = `¶ ${r.para + 1} / ${r.paraCount}  ·  ${Math.round(r.progress * 100)}%`;
    if (S.speed !== r.speed) { S.speed = r.speed; $('speed').value = r.speed; $('speedV').textContent = r.speed; renderStats(); }
    markPara(r.para);
    const li = document.querySelector(`#speakers li[data-file="${CSS.escape(r.file)}"]`);
    if (li) { li.querySelector('.tm').textContent = $('timer').textContent; li.querySelector('.bar i').style.width = Math.round(r.progress * 100) + '%'; }
  });
  tp.on('outputState', (o) => {
    $('onTop').checked = !!o.onTop;
    $('btnFull').textContent = o.fullscreen ? 'Exit fullscreen' : 'Fullscreen';
    $('btnFull').classList.toggle('on', !!o.fullscreen);
    const sel = $('display');
    sel.innerHTML = (o.displays || []).map(d => `<option value="${d.id}">${d.label}</option>`).join('');
    if (o.display != null) sel.value = String(o.display);
  });
  tp.on('toast', toast);
  tp.on('focusSearch', focusSearch);
  tp.on('searchNav', searchNav);

  setView(view);
  tp.info().then(i => { $('folder').textContent = i.scriptsDir; });
  tp.ready('control');
})();
