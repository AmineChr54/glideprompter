// Default look + timer settings for every speaker. Used by the desktop main process
// (require) and by the web version (plain <script>, exposes window.TPDefaults).
(function (root) {
  const DEFAULTS = {
    fontSize: 72, margin: 12, speed: 24, bg: '#000000', fg: '#ffffff',
    lineHeight: 1.8, align: 'left', mirrorH: false, mirrorV: false, readingLine: 0.35,
    showGuide: true, showProgress: true, timerSize: 48, showTimer: true,
    fontFamily: 'Arial', fontWeight: 400, letterSpacing: 0,
    timerMode: 'up', timerTarget: 600, timerWarn: 60, timerOvertime: true,
    timerPos: 'tr', timerFg: '#ffffff', timerBg: '#000000',
    followHighlight: true,       // Follow mode: tint the words already said
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DEFAULTS;
  else root.TPDefaults = DEFAULTS;
})(this);
