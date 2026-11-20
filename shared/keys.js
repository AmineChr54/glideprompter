// One shortcut map for both windows. Returns an action object or null.
// Uses e.key for symbols (works on German QWERTZ too) and e.code for digits.
(function () {
  // Actions handled by the main process (everything else goes to the Output renderer).
  const MAIN_ACTIONS = new Set(['speaker', 'fullscreen', 'onTop', 'saveDefault', 'resetDefault', 'size1080', 'focusSearch', 'searchNav']);

  function keyToAction(e, phase) {
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const repeat = e.repeat;

    if (phase === 'up') {
      if (k === 'ArrowUp' || k === 'ArrowDown') return { a: 'nudgeRelease', dir: k === 'ArrowUp' ? -1 : 1 };
      return null;
    }

    if (e.ctrlKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      return repeat ? null : { a: 'speaker', index: Number(e.code.slice(5)) - 1 };
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') return repeat ? null : { a: 'focusSearch' };
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    if (k === 'Enter' || k === 'F3') return { a: 'searchNav', d: e.shiftKey ? -1 : 1 };

    switch (k) {
      case ' ': case 'Spacebar': return repeat ? null : { a: 'togglePlay' };
      case 'Escape': return { a: 'pause' };
      case 'ArrowUp':
        if (e.shiftKey) return { a: 'speedBy', d: +1 };
        return repeat ? { a: 'noop' } : { a: 'nudgePress', dir: -1 };
      case 'ArrowDown':
        if (e.shiftKey) return { a: 'speedBy', d: -1 };
        return repeat ? { a: 'noop' } : { a: 'nudgePress', dir: 1 };
      case 'PageUp': return { a: 'para', d: -1 };
      case 'PageDown': return { a: 'para', d: +1 };
      case 'Home': return repeat ? null : { a: 'home' };
      case 'End': return repeat ? null : { a: 'end' };
      case '+': return { a: 'setBy', key: 'fontSize', d: +4 };
      case '-': return { a: 'setBy', key: 'fontSize', d: -4 };
      case '[': case ',': return { a: 'setBy', key: 'margin', d: -1 };
      case ']': case '.': return { a: 'setBy', key: 'margin', d: +1 };
    }
    if (e.code === 'NumpadAdd') return { a: 'setBy', key: 'fontSize', d: +4 };
    if (e.code === 'NumpadSubtract') return { a: 'setBy', key: 'fontSize', d: -4 };
    if (repeat) return null;
    switch (lower) {
      case 't': return e.shiftKey ? { a: 'timerReset' } : { a: 'timerToggle' };
      case 'l': return { a: 'toggle', key: 'showGuide' };
      case 'p': return { a: 'toggle', key: 'showProgress' };
      case 'h': return { a: 'toggle', key: 'mirrorH' };
      case 'v': return { a: 'toggle', key: 'mirrorV' };
      case 'f': return { a: 'fullscreen' };
      case 'a': return { a: 'toggleAlign' };
    }
    return null;
  }

  const HELP = [
    ['Space', 'Play / pause scrolling'],
    ['↑ / ↓', 'Smooth nudge back / forward (hold = glide)'],
    ['Shift + ↑ / ↓', 'Speed +1 / −1'],
    ['PageUp / PageDown', 'Previous / next paragraph'],
    ['Home / End', 'Jump to start / end'],
    ['T', 'Timer start / stop'],
    ['Shift + T', 'Timer reset to 00:00'],
    ['+ / −', 'Text size ±4 px'],
    [', / .   ( [ / ] )', 'Margin −1 / +1 %'],
    ['L', 'Reading line on / off'],
    ['P', 'Progress bar on / off'],
    ['H / V', 'Mirror horizontal / vertical'],
    ['F', 'Output fullscreen on / off'],
    ['A', 'Align text left / centre'],
    ['Ctrl + F', 'Search a word the speaker says'],
    ['Enter / Shift + Enter', 'Jump prompter to next / previous match (also F3)'],
    ['Ctrl + 1…9', 'Switch speaker'],
    ['Ctrl + S', 'Save script (in editor)'],
    ['Esc', 'Pause / leave text field'],
    ['?', 'Show / hide this help'],
  ];

  window.TPKeys = { keyToAction, MAIN_ACTIONS, HELP };
})();
