// Follow mode in the Control window: the toolbar toggle, the microphone capture, the voice pack
// panel, and a highlight of the followed word in the prompter view.
(() => {
  if (!window.tp || !tp.follow) return;           // the web version has no speech engine
  const $ = (id) => document.getElementById(id);
  const act = (a) => tp.action(a);
  const box = $('followBox');
  box.hidden = false;
  document.querySelector('.followside').hidden = false;

  const F = { ctx: null, stream: null, node: null, level: 0, raf: 0, status: null, following: false, word: -1 };
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }
  const mb = (n) => Math.round(n / 1048576) + ' MB';

  $('btnFollow').onclick = () => act({ a: 'followToggle' });
  // per-speaker setting, like the other looks
  const showHL = (s) => { if (s) $('followHighlight').checked = s.followHighlight !== false; };
  tp.on('settings', showHL);
  tp.on('load', (p) => showHL(p.settings));
  $('followHighlight').addEventListener('change', (e) => { act({ a: 'set', key: 'followHighlight', value: e.target.checked }); e.target.blur(); });

  // ---------------- microphone capture ----------------
  // The main process sends a MessagePort to the speech engine. It goes into the AudioWorklet,
  // so audio frames travel straight from the audio thread to the engine.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'glideprompter-follow-port') return;
    startCapture(e.ports[0], e.data.data || {});
  });
  async function startCapture(port, { deviceId, wav, fakeMic }) {
    window.__fakeMic = !!fakeMic;
    stopCapture();
    try {
      if (wav) return await startWav(port, wav);
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (deviceId) audio.deviceId = { exact: deviceId };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      catch (err) {
        if (!deviceId) throw err;
        delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio });  // device unplugged: use the default
        toast('The chosen microphone is not available. Using the default one.');
      }
      let ctx;
      try { ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }); }
      catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      await ctx.audioWorklet.addModule('follow/capture-worklet.js');
      const node = new AudioWorkletNode(ctx, 'follow-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => {
        if (e.data && e.data.level != null) F.level = e.data.level;
        if (e.data && e.data.firstSound != null && window.__fakeMic) window.__firstSound = performance.timeOrigin + performance.now() - e.data.firstSound * 1000;   // test timing
      };
      node.port.postMessage({ type: 'engine' }, [port]);
      const mute = ctx.createGain(); mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(mute).connect(ctx.destination);            // keeps the graph running; nothing is heard
      if (ctx.state === 'suspended') await ctx.resume();
      Object.assign(F, { ctx, stream, node });
      meter();
      listMics();
    } catch (err) {
      toast('Microphone: ' + (err && err.message || err));
      port.close();
      act({ a: 'followOff' });
    }
  }
  // Test hook (TP_FOLLOW_WAV): play a recording through the same worklet, in real time.
  async function startWav(port, samples) {
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('follow/capture-worklet.js');
    const node = new AudioWorkletNode(ctx, 'follow-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => {
      if (e.data && e.data.level != null) F.level = e.data.level;
      // the recording's first sample has just reached the worklet: that is "time 0" of the talk, like a live mic
      if (e.data && e.data.wavStarted) window.__wavStart = performance.timeOrigin + performance.now();
    };
    node.port.postMessage({ type: 'engine' }, [port]);
    const buf = ctx.createBuffer(1, samples.length, 16000); buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute).connect(ctx.destination);
    await ctx.resume();
    const at = ctx.currentTime + 0.5;
    node.port.postMessage({ type: 'wavAt', t: at });
    src.start(at);
    Object.assign(F, { ctx, stream: null, node });
    meter();
  }
  function stopCapture() {
    if (F.node) { try { F.node.port.postMessage({ type: 'stop' }); F.node.disconnect(); } catch {} }
    if (F.stream) F.stream.getTracks().forEach(t => t.stop());
    if (F.ctx) F.ctx.close().catch(() => {});
    F.ctx = F.stream = F.node = null; F.level = 0;
  }
  tp.on('followCapture', (c) => { if (!c.on) stopCapture(); });

  function meter() {
    cancelAnimationFrame(F.raf);
    const bar = $('followMeter').firstElementChild;
    const tick = () => {
      const db = F.level > 0 ? 20 * Math.log10(F.level) : -90;
      bar.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)).toFixed(1) + '%';
      F.level *= 0.85;
      if (F.ctx) F.raf = requestAnimationFrame(tick); else bar.style.width = '0%';
    };
    tick();
  }

  // ---------------- microphone list ----------------
  async function listMics() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const sel = $('followMic'), want = (F.status && F.status.mic) || '';
      sel.innerHTML = '<option value="">Default microphone</option>' +
        devs.map((d, i) => `<option value="${d.deviceId}"></option>`).join('');
      devs.forEach((d, i) => { sel.options[i + 1].textContent = d.label || `Microphone ${i + 1}`; });
      sel.value = devs.some(d => d.deviceId === want) ? want : '';
    } catch {}
  }
  $('followMic').addEventListener('change', (e) => { act({ a: 'followMic', deviceId: e.target.value }); e.target.blur(); });
  navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', listMics);

  // ---------------- voice pack panel ----------------
  function renderStatus(st) {
    F.status = st;
    const p = st.pack, text = $('packText'), btn = $('btnPack'), cancel = $('btnPackCancel'), bar = $('packBar');
    btn.hidden = cancel.hidden = bar.hidden = true;
    if (st.progress) {
      bar.hidden = false; cancel.hidden = false;
      bar.firstElementChild.style.width = (st.progress.total ? st.progress.done / st.progress.total * 100 : 0).toFixed(1) + '%';
      text.textContent = `Downloading the ${p.label}… ${mb(st.progress.done)} / ${mb(st.progress.total)}`;
    } else if (p.installed) {
      text.textContent = `✓ ${p.label} installed (${mb(p.size)}). Speech model by NVIDIA, CC-BY-4.0.`;
      btn.hidden = false; btn.textContent = 'Remove voice pack'; btn.dataset.do = 'remove';
    } else if (p.dev) {
      text.textContent = 'Using the developer model from .dev/models.';
    } else if (p.available) {
      text.textContent = 'Follow mode needs the English voice pack (speech model). It is downloaded once and works offline.';
      btn.hidden = false; btn.textContent = `Download voice pack (${mb(p.size)})`; btn.dataset.do = 'download';
    } else {
      text.textContent = 'The voice pack is not available in this version yet.';
    }
    if (st.engineError) text.textContent += '  Engine error: ' + st.engineError;
    if (!st.listening) $('followStats').textContent = '';
  }
  $('btnPack').onclick = () => {
    if ($('btnPack').dataset.do === 'remove') { if (confirm('Remove the voice pack? You can download it again later.')) act({ a: 'followRemove' }); }
    else act({ a: 'followDownload' });
  };
  $('btnPackCancel').onclick = () => act({ a: 'followCancel' });
  tp.on('followStatus', renderStatus);
  tp.on('followNeedPack', (st) => {
    renderStatus(st);
    const panel = $('followPanel');
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash');
    toast(st.pack.available ? 'Download the voice pack first (Follow mode section).' : 'The voice pack is not available yet.');
  });
  tp.on('followStats', (s) => {
    $('followStats').textContent = `Speech engine: ${s.avgMs} ms per 20 ms of audio (peak ${s.maxMs} ms)`;
  });

  // ---------------- state from the Output window ----------------
  let miniWords = null;
  tp.on('load', () => { miniWords = null; F.word = -1; highlight(-1); });
  function highlight(word) {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return;
    if (word < 0) { CSS.highlights.delete('tp-follow'); return; }
    if (!miniWords) {
      miniWords = [];
      for (const p of $('miniContent').children) for (const w of TPParse.domWords(p)) miniWords.push(w.range);
    }
    const r = miniWords[word];
    if (r) CSS.highlights.set('tp-follow', new Highlight(r)); else CSS.highlights.delete('tp-follow');
  }
  tp.on('report', (r) => {
    const on = !!r.following;
    box.classList.toggle('on', on);
    $('btnFollow').classList.toggle('on', on);
    box.classList.toggle('speaking', on && !!r.fSpeaking);
    box.classList.toggle('searching', on && r.fState === 'searching');
    $('followText').textContent = !on ? 'Follow' : r.fState === 'manual' ? 'Manual move' : r.fState === 'searching' ? 'Searching…'
      : r.fSpeaking ? 'Hearing voice' : 'Listening';
    // highlight the word the speaker is on (the one just after the last spoken word)
    const w = on ? r.fWord : -1;
    if (w !== F.word) { F.word = w; highlight(w); }
    if (F.following && !on) stopCapture();
    F.following = on;
  });

  act({ a: 'followStatus' });
  listMics();
})();
