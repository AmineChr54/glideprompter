"""Noise / silence tests for Follow mode: the prompter must not move when nobody reads the script.

t5-noisy:   pink noise and keyboard-like clicks the whole time (about 20 dB below the speaker), 8 s of
            noise only at the start, a 12 s noise-only break in the middle. The talk is t1-verbatim.
t6-chatter: unrelated speech in the room (a second voice, about 12 dB quieter) during 10 s before the
            talk and during a 15 s break, nobody reading the script then.
Ground-truth word times are shifted to match. Run with the presentation-kit kokoro venv (needs t1 first):
  .../venvs/kokoro/Scripts/python.exe tools/follow/make-noisy.py
"""
import json
import pathlib

import numpy as np
import soundfile as sf
from kokoro import KPipeline

ROOT = pathlib.Path(__file__).resolve().parents[2]
T = ROOT / ".dev" / "talks"
SR = 16000
rng = np.random.default_rng(7)


def pink(n):
    f = np.fft.rfftfreq(n, 1 / SR)
    spec = (rng.standard_normal(len(f)) + 1j * rng.standard_normal(len(f))) / np.maximum(f, 20) ** 0.5
    x = np.fft.irfft(spec, n)
    return x / np.sqrt(np.mean(x ** 2))


def clicks(n):
    x = np.zeros(n)
    for t in rng.uniform(0, n / SR, int(n / SR * 1.5)):   # ~1.5 clicks per second
        i = int(t * SR)
        k = np.exp(-np.arange(160) / 25) * rng.standard_normal(160)
        x[i:i + 160] += k[: max(0, min(160, n - i))]
    return x / (np.sqrt(np.mean(x ** 2)) + 1e-9)


def rms(x):
    return np.sqrt(np.mean(x[np.abs(x) > 1e-4] ** 2))


def load(name):
    a, sr = sf.read(T / f"{name}.wav", dtype="float32")
    assert sr == SR
    return a, json.loads((T / f"{name}.json").read_text(encoding="utf-8"))


def split_at_gap(meta, after_sec):
    """Index of the first word starting after a pause that follows `after_sec`."""
    ws = meta["words"]
    for i in range(1, len(ws)):
        if ws[i - 1]["end"] > after_sec and ws[i]["start"] - ws[i - 1]["end"] > 0.3:
            return (ws[i - 1]["end"] + ws[i]["start"]) / 2
    return after_sec


def assemble(name, speech, meta, inserts, bed):
    """inserts: [(at_sec, seconds, filler_fn)]: insert a break at a pause in the speech."""
    out, words, cur, shift = [], [], 0, 0.0
    cuts = sorted(inserts)
    for at, dur, fill in cuts:
        i = int(at * SR)
        out.append(speech[cur:i])
        out.append(fill(int(dur * SR)))
        for w in meta["words"]:
            if cur / SR <= w["start"] < at:
                words.append({**w, "start": round(w["start"] + shift, 3), "end": round(w["end"] + shift, 3)})
        shift += dur
        cur = i
    out.append(speech[cur:])
    for w in meta["words"]:
        if w["start"] >= cur / SR:
            words.append({**w, "start": round(w["start"] + shift, 3), "end": round(w["end"] + shift, 3)})
    x = np.concatenate(out)
    x = x + bed(len(x))
    x = x / max(1.0, np.max(np.abs(x)) / 0.98)
    sf.write(T / f"{name}.wav", x.astype(np.float32), SR, subtype="PCM_16")
    (T / f"{name}.json").write_text(json.dumps({**meta, "name": name, "duration": round(len(x) / SR, 3), "words": words}, indent=1), encoding="utf-8")
    print(name, f"{len(x) / SR:.1f}s", len(words), "words")


speech, meta = load("t1-verbatim")
level = rms(speech)
silence = lambda n: np.zeros(n, np.float32)

# t5: noise bed under everything, two noise-only breaks
noise = lambda n: (pink(n) * 0.08 + clicks(n) * 0.05) * level
assemble("t5-noisy", speech, meta, [(0.0, 8.0, silence), (split_at_gap(meta, 90), 12.0, silence)], noise)

# t6: unrelated speech in the room while nobody reads the script
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
CHAT = ("So did you see the game last night? I could not believe the second half. "
        "Anyway, the coffee machine on the third floor is broken again, somebody should call facilities. "
        "We are meeting at seven for dinner, the place near the station with the green door. "
        "Honestly I think the new parking rules are a mess, nobody knows where to go.")
chat = np.concatenate([r.audio.numpy() for r in pipe(CHAT, voice="bm_george", speed=1.0)])
chat = np.interp(np.arange(int(len(chat) * SR / 24000)) * 24000 / SR, np.arange(len(chat)), chat).astype(np.float32)
chat = chat / rms(chat) * level * 0.25          # about 12 dB below the speaker
def chatter(n):
    reps = np.tile(chat, n // len(chat) + 1)[:n]
    return reps
assemble("t6-chatter", speech, meta, [(0.0, 10.0, chatter), (split_at_gap(meta, 60), 15.0, chatter)], lambda n: pink(n) * 0.02 * level)
