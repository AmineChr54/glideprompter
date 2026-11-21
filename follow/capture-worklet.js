// Follow mode audio capture (AudioWorklet). Cuts the microphone signal into 20 ms frames of 16 kHz mono
// Float32 and sends them straight to the speech engine over the MessagePort it receives. Also reports
// the input level for the meter.
const OUT_RATE = 16000, FRAME = 320;

class FollowCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.buf = new Float32Array(FRAME); this.n = 0;
    this.step = sampleRate / OUT_RATE;   // 1 when the AudioContext already runs at 16 kHz
    this.phase = 0; this.prev = 0;
    this.peak = 0; this.frames = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'engine') this.engine = e.ports[0];
      if (e.data && e.data.type === 'wavAt') this.wavAt = e.data.t;
      if (e.data && e.data.type === 'stop') { if (this.engine) this.engine.close(); this.engine = null; }
    };
  }
  push(x) {
    this.buf[this.n++] = x;
    const a = x < 0 ? -x : x; if (a > this.peak) this.peak = a;
    if (this.n === FRAME) {
      if (this.engine) this.engine.postMessage(this.buf);       // cloned: Electron's MessagePortMain can't take transferred buffers
      this.buf = new Float32Array(FRAME); this.n = 0;
      if (++this.frames % 3 === 0) { this.port.postMessage({ level: this.peak }); this.peak = 0; }
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (!this.heard && this.engine) {   // test timing (fake mic): when does the first sound arrive?
      for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > 1e-3) { this.heard = true; this.port.postMessage({ firstSound: (ch.length - i) / sampleRate }); break; }
    }
    // test hook: tell the page when a scheduled recording reaches this worklet (TP_FOLLOW_WAV timing)
    if (this.wavAt != null && currentTime >= this.wavAt) { this.wavAt = null; this.port.postMessage({ wavStarted: true }); }
    if (this.step === 1) { for (let i = 0; i < ch.length; i++) this.push(ch[i]); return true; }
    // Fallback resampler (linear) if the browser would not open a 16 kHz context.
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      while (this.phase <= 1) { this.push(this.prev + (x - this.prev) * this.phase); this.phase += this.step; }
      this.phase -= 1; this.prev = x;
    }
    return true;
  }
}
registerProcessor('follow-capture', FollowCapture);
