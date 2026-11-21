"""Generates synthetic English test talks for Follow mode, with exact word timings.

Uses Kokoro-82M (from presentation-kit's voice-lab venv). Every spoken word is stored with its
start/end time and, for script words, its position in the script (paragraph, word-in-paragraph),
counted exactly like TPParse.plainWords. Variants add ad-libs, skipped paragraphs, long pauses and
repeated lines, so the expected prompter position is known at every moment.

Usage (from the repo root):
  <python-with-kokoro> tools/follow/make-talks.py [out_dir]
Output: <out_dir>/<name>.wav (16 kHz mono) + <name>.json
"""
import json
import pathlib
import re
import sys
import unicodedata

import numpy as np
import soundfile as sf
from kokoro import KPipeline

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".dev" / "talks"
SCRIPT = ROOT / "default-scripts" / "2_Sample_Talk.txt"
SR_TTS, SR = 24000, 16000

PAUSE_CUE = re.compile(r"\[(?:PAUSE|BREATHE|BEAT|SILENCE|WAIT)[^\]]*\]", re.I)


def lines():
    text = SCRIPT.read_text(encoding="utf-8").lstrip("\ufeff")
    ls = re.split(r"<br\s*/?>[ \t]*\r?\n|<br\s*/?>|\r?\n", text, flags=re.I)
    while ls and not ls[-1].strip():
        ls.pop()
    return ls


def spoken_text(line):
    """What the speaker says: cues and markup removed."""
    t = re.sub(r"\[[^\]]*\]", " ", line)
    t = re.sub(r"\{[^}]*\}", "", t)
    t = re.sub(r"\*\*|__|==|\*", "", t)
    return re.sub(r"\s+", " ", t).strip()


def plain_words(line):
    """Same rule as TPParse.plainWords (shared/parse.js)."""
    t = re.sub(r"\[[^\]]*\]", " ", line)
    t = re.sub(r"\{[^}]*\}", " ", t)
    t = re.sub(r"\*\*|__|==|\*", "", t)
    return [w for w in t.split() if re.search(r"[^\W_]", w)]


def norm(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^\w]|_", "", s.lower())


class Talk:
    def __init__(self, voice, speed=1.0):
        self.voice, self.speed = voice, speed
        self.chunks, self.t, self.words = [], 0.0, []

    def silence(self, sec):
        self.chunks.append(np.zeros(int(sec * SR_TTS), np.float32))
        self.t += sec

    def say(self, text, refs=None, kind="script"):
        """refs: one (para, k) per plain word of text, or None for ad-libs."""
        words = [w for w in text.split() if re.search(r"[^\W_]", w)]
        if refs is None:
            refs = [None] * len(words)
        assert len(refs) == len(words), (text, refs)
        toks = []
        for res in PIPE(text, voice=self.voice, speed=self.speed):
            audio = res.audio.numpy() if hasattr(res.audio, "numpy") else np.asarray(res.audio)
            for tk in res.tokens or []:
                if tk.start_ts is not None and norm(tk.text):
                    toks.append((norm(tk.text), self.t + tk.start_ts, self.t + tk.end_ts))
            self.chunks.append(audio.astype(np.float32))
            self.t += len(audio) / SR_TTS
        # align plain words to Kokoro tokens (a word may span several tokens: "turn-by-turn")
        ti = 0
        for w, ref in zip(words, refs):
            target, acc, start, end = norm(w), "", None, None
            j = ti
            while j < len(toks) and j < ti + 4 and not target.startswith(toks[j][0]):
                j += 1
            if j < len(toks) and target.startswith(toks[j][0]):
                ti = j
                while ti < len(toks) and acc != target and target.startswith(acc + toks[ti][0]):
                    acc += toks[ti][0]
                    start = toks[ti][1] if start is None else start
                    end = toks[ti][2]
                    ti += 1
            if start is None:
                start = end = self.words[-1]["end"] if self.words else self.t
            rec = {"w": w, "start": round(start, 3), "end": round(end, 3), "kind": kind}
            if ref:
                rec["para"], rec["k"] = ref
            self.words.append(rec)

    def para(self, i, from_k=0, to_k=None):
        """Speak paragraph i (optionally only words from_k..to_k), with pause cues as silence."""
        line = LINES[i]
        pw = plain_words(line)
        to_k = len(pw) if to_k is None else to_k
        if not pw[from_k:to_k]:
            return
        # split at pause cues so they become silences
        k = 0
        for part in re.split(r"(" + PAUSE_CUE.pattern + r")", line, flags=re.I):
            if part is None:
                continue
            if PAUSE_CUE.fullmatch(part or ""):
                if from_k <= k <= to_k and k > from_k:
                    self.silence(1.2)
                continue
            n = len(plain_words(part))
            lo, hi = max(k, from_k), min(k + n, to_k)
            if lo < hi:
                ws = plain_words(part)[lo - k:hi - k]
                self.say(" ".join(ws) if (lo, hi) != (k, k + n) else spoken_text(part), [(i, j) for j in range(lo, hi)])
            k += n
        self.silence(0.35)

    def save(self, name):
        audio = np.concatenate(self.chunks)
        n16 = int(len(audio) * SR / SR_TTS)
        a16 = np.interp(np.arange(n16) * SR_TTS / SR, np.arange(len(audio)), audio).astype(np.float32)
        OUT.mkdir(parents=True, exist_ok=True)
        sf.write(OUT / f"{name}.wav", a16, SR, subtype="PCM_16")
        meta = {"name": name, "voice": self.voice, "speed": self.speed, "duration": round(self.t, 3),
                "script": SCRIPT.name, "words": self.words}
        (OUT / f"{name}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(f"{name}: {self.t:.1f}s, {len(self.words)} words", flush=True)


LINES = lines()
SPOKEN = [i for i, l in enumerate(LINES) if plain_words(l)]
PIPE = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")


def verbatim():
    t = Talk("af_heart")
    t.silence(1.0)
    for i in SPOKEN:
        t.para(i)
    t.save("t1-verbatim")


def adlib():
    t = Talk("am_michael", 1.1)
    t.silence(1.0)
    extras = {SPOKEN[2]: "Honestly, I still remember that afternoon very clearly.",
              SPOKEN[9]: "And I mean really, really good at it. Think about the last time you were lost.",
              SPOKEN[20]: "This one is my favourite part of the whole story, by the way."}
    for i in SPOKEN:
        t.para(i)
        if i in extras:
            t.say(extras[i], kind="adlib")
            t.silence(0.4)
    t.save("t2-adlib-fast")


def skip():
    t = Talk("af_bella")
    t.silence(1.0)
    skipped = set(SPOKEN[10:13]) | {SPOKEN[22]}
    for i in SPOKEN:
        if i in skipped:
            continue
        t.para(i)
    t.save("t3-skip")


def pauses_repeat():
    t = Talk("bm_george", 0.95)
    t.silence(1.0)
    for n, i in enumerate(SPOKEN):
        t.para(i)
        if n in (4, 15, 27):
            t.silence(4.0)           # long pause: the prompter must stop
        if n == 14:                  # repeat the line just said
            t.say("Let me say that again.", kind="adlib")
            t.silence(0.3)
            t.para(i)
        if n == 22:                  # start a sentence, stop, restart it
            t.para(SPOKEN[n + 1], 0, 4)
            t.say("sorry,", kind="adlib")
            t.silence(0.5)
    t.save("t4-pauses-repeat")


if __name__ == "__main__":
    which = sys.argv[2].split(",") if len(sys.argv) > 2 else ["verbatim", "adlib", "skip", "pauses_repeat"]
    for w in which:
        globals()[w]()
