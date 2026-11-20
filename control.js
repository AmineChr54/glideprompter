// Control window: toolbar, speakers, script overview, editor. Sends actions; Output owns state.
(() => {
  const $ = (id) => document.getElementById(id);
  const act = (a) => tp.action(a);

  let current = null;          // current load payload
  let S = {};                  // current settings
  let speakers = [];
  let lastPara = -1, paraEls = [], userScrolledAt = 0;
  let dirty = false;

  const fmt = (ms) => {
    const t = Math.floor((ms || 0) / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p2 = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  };
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------------- settings UI ----------------
  const SLIDERS = {
    fontSize: (v) => v, margin: (v) => v, speed: (v) => v,
    readingLine: (v) => Math.round(v * 100), lineHeight: (v) => Number(v).toFixed(2), timerSize: (v) => v,
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

  $('btnPlay').onclick = () => act({ a: 'togglePlay' });
  $('btnAlign').onclick = () => act({ a: 'toggleAlign' });
  $('btnMirrorH').onclick = () => act({ a: 'toggle', key: 'mirrorH' });
  $('btnMirrorV').onclick = () => act({ a: 'toggle', key: 'mirrorV' });
  $('btnGuide').onclick = () => act({ a: 'toggle', key: 'showGuide' });
  $('btnTimer').onclick = () => act({ a: 'timerToggle' });
  $('btnTimerReset').onclick = () => act({ a: 'timerReset' });
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
      li.querySelector('.tm').textContent = fmt(s.timerMs);
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
    const ov = $('overview');
    ov.innerHTML = lines.map((l, i) => `<p data-i="${i}">${TPParse.lineToHtml(l)}</p>`).join('');
    paraEls = Array.from(ov.children);
    lastPara = -1;
  }
  $('overview').addEventListener('click', (e) => {
    const p = e.target.closest('p'); if (p) act({ a: 'gotoPara', i: Number(p.dataset.i) });
  });
  $('overview').addEventListener('wheel', () => { userScrolledAt = performance.now(); }, { passive: true });

  function markPara(i) {
    if (i === lastPara || !paraEls.length) return;
    const prev = lastPara; lastPara = i;
    if (prev < 0 || Math.abs(prev - i) > 1) paraEls.forEach((p, k) => { p.classList.toggle('past', k < i); p.classList.toggle('cur', k === i); });
    else { paraEls[prev] && paraEls[prev].classList.remove('cur'); paraEls[prev] && paraEls[prev].classList.toggle('past', prev < i);
           paraEls[i] && paraEls[i].classList.add('cur'); paraEls[i] && paraEls[i].classList.remove('past'); }
    if (paraEls[i] && $('tab-script').classList.contains('active') && performance.now() - userScrolledAt > 2500) {
      paraEls[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function setDirty(d) { dirty = d; $('dirty').textContent = d ? '● unsaved changes' : ''; }
  $('editor').addEventListener('input', () => setDirty(true));
  async function save() {
    if (!current) return;
    await tp.saveScript(current.file, TPParse.toFileText($('editor').value));
    setDirty(false); toast('Script saved');
  }
  $('btnSave').onclick = save;
  $('btnRevert').onclick = () => { if (current) { $('editor').value = TPParse.toLines(current.text).join('\n'); setDirty(false); } };

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'script' && paraEls[lastPara]) paraEls[lastPara].scrollIntoView({ block: 'center' });
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
    if ($('tab-script').classList.contains('active')) paraEls[m.para].scrollIntoView({ block: 'center' });
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

  // ---------------- help ----------------
  $('helpTable').innerHTML = TPKeys.HELP.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('');
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
    if (isTextField(document.activeElement)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
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
    renderSpeakers();
  });
  tp.on('speakers', ({ list }) => { speakers = list; renderSpeakers(); });
  tp.on('settings', showSettings);
  tp.on('report', (r) => {
    $('timer').textContent = fmt(r.timerMs);
    $('timer').classList.toggle('running', r.timerRunning);
    $('btnTimer').textContent = r.timerRunning ? 'Stop' : 'Start';
    $('btnTimer').classList.toggle('on', r.timerRunning);
    $('icPlay').hidden = r.playing; $('icPause').hidden = !r.playing;
    $('btnPlay').classList.toggle('on', r.playing);
    $('progressFill').style.transform = `scaleX(${r.progress.toFixed(4)})`;
    $('progressText').textContent = `¶ ${r.para + 1} / ${r.paraCount}  ·  ${Math.round(r.progress * 100)}%`;
    if (S.speed !== r.speed) { S.speed = r.speed; $('speed').value = r.speed; $('speedV').textContent = r.speed; }
    markPara(r.para);
    const li = document.querySelector(`#speakers li[data-file="${CSS.escape(r.file)}"]`);
    if (li) { li.querySelector('.tm').textContent = fmt(r.timerMs); li.querySelector('.bar i').style.width = Math.round(r.progress * 100) + '%'; }
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

  tp.info().then(i => { $('folder').textContent = i.scriptsDir; });
  tp.ready('control');
})();
