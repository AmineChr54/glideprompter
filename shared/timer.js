// Timer display shared by the Output and Control windows (plain browser script).
// The stored value is always the elapsed time in ms; settings decide how it is shown.
(function () {
  const p2 = (n) => String(n).padStart(2, '0');

  // Seconds -> "mm:ss" or "h:mm:ss" (no sign).
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  }

  // "5:30", "05:30", "1:02:03", "90" (seconds) -> seconds, or null if invalid.
  function parse(str) {
    const t = String(str || '').trim().replace(/^[-+]/, '');
    if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
    return t.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  }

  // What the timer shows for a given elapsed time.
  //   up:   elapsed; warn from (target - warn), over after target (target 0 = no colours)
  //   down: target - elapsed; warn in the last `warn` s; over at 0, then -mm:ss (or 00:00 without overtime)
  function view(elapsedMs, s) {
    s = s || {};
    const el = Math.floor((elapsedMs || 0) / 1000);
    const target = Math.max(0, Number(s.timerTarget) || 0);
    const warn = Math.max(0, Number(s.timerWarn) || 0);
    if (s.timerMode === 'down') {
      const left = target - el;
      if (left > 0) return { text: clock(left), state: left <= warn ? 'warn' : 'normal', shown: left };
      if (left === 0 || s.timerOvertime === false) return { text: clock(0), state: 'over', shown: 0 };
      return { text: '-' + clock(-left), state: 'over', shown: left };
    }
    let state = 'normal';
    if (target) state = el >= target ? 'over' : el > 0 && el >= target - warn ? 'warn' : 'normal';
    return { text: clock(el), state, shown: el };
  }

  // Elapsed ms that makes the timer show `shownSec` (inverse of view).
  function elapsedFor(shownSec, s) {
    const target = Math.max(0, Number((s || {}).timerTarget) || 0);
    return Math.max(0, (s && s.timerMode === 'down' ? target - shownSec : shownSec) * 1000);
  }

  window.TPTimer = { view, clock, parse, elapsedFor };
})();
