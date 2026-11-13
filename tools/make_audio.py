"""Generate the app's recorded Mandarin audio with Kokoro v1.1-zh (sherpa-onnx).

Pronunciation is forced from the hand-written pinyin in the scripts, so polyphones
(干杯, 这行, 还 …) are never guessed. 3rd-tone sandhi is applied automatically.

usage:
  node tools/export_lines.js work/lines.json
  python3 tools/make_audio.py --models MODELS_DIR --lines work/lines.json --out audio [--only-new] [--check]

MODELS_DIR must contain kokoro-multi-lang-v1_1/ (and, for --check,
sherpa-onnx-paraformer-zh-2024-03-09/). See tools/README.md.
"""
import argparse, collections, difflib, hashlib, json, os, re, shutil, subprocess, sys, unicodedata
from functools import lru_cache

VOICE = {"p": 102, "me": 25, "word": 25}   # partner: male voice, learner lines and words: female voice
ap = argparse.ArgumentParser()
ap.add_argument("--models", required=True)
ap.add_argument("--lines", default="work/lines.json")
ap.add_argument("--out", default="audio")
ap.add_argument("--index", default="js/audio-index.js")
ap.add_argument("--work", default="work")
ap.add_argument("--only-new", action="store_true", help="skip lines whose mp3 already exists")
ap.add_argument("--check", action="store_true", help="transcribe results with ASR and report mismatches")
a = ap.parse_args()
K = os.path.join(a.models, "kokoro-multi-lang-v1_1")

# ---------- pinyin -> syllables ----------
TONE = {"̄": 1, "́": 2, "̌": 3, "̀": 4}

MAP_FILE = os.path.join(os.path.dirname(__file__), "kokoro_syllables.json")
MP = json.load(open(MAP_FILE, encoding="utf8"))
BASES = sorted(MP, key=len, reverse=True)

def letters_with_tone(word):
    out = []
    for ch in unicodedata.normalize("NFD", word.lower()):
        if ch in TONE:
            out[-1] = (out[-1][0], TONE[ch])
        elif ch == "̈":
            out[-1] = ("v", out[-1][1])
        elif ch.isalpha():
            out.append((ch, 0))
    return out

def syllabify(word):
    lt = letters_with_tone(word)
    s = "".join(c for c, _ in lt)

    @lru_cache(None)
    def best(i):
        if i == len(s):
            return (0, ())
        cands = []
        for b in BASES:
            if s.startswith(b, i):
                j = i + len(b)
                tones = [t for _, t in lt[i:j] if t]
                if len(tones) > 1:
                    continue
                rest = best(j)
                if rest is None:
                    continue
                pen = (10 if i > 0 and b[0] in "aeo" else 0) + 1
                cands.append((pen + rest[0], ((b, tones[0] if tones else 0),) + rest[1]))
        if s[i] == "r" and i > 0:  # erhua
            rest = best(i + 1)
            if rest is not None:
                cands.append((1 + rest[0], (("R", 0),) + rest[1]))
        return min(cands) if cands else None

    r = best(0)
    if r is None:
        raise ValueError(f"cannot split pinyin {word!r}")
    return list(r[1])

def sandhi(sylls):
    s = list(sylls)
    idx = [k for k, x in enumerate(s) if x[0] != "R"]
    i = 0
    while i < len(idx):
        if s[idx[i]][1] == 3:
            j = i
            while j + 1 < len(idx) and s[idx[j + 1]][1] == 3:
                j += 1
            for k in range(i, j):
                s[idx[k]] = (s[idx[k]][0], 2)
            i = j + 1
        else:
            i += 1
    return s

def kokoro_phones(sylls):
    out = []
    for b, t in sylls:
        if b == "R":
            out[-1] = out[-1][:-1] + ["R", out[-1][-1]]
        else:
            out.append(MP[b].split() + [str(t or 5)])
    return " ".join(" ".join(x) for x in out)

HAN = re.compile(r"[㐀-鿿]")
clauses = lambda zh: [c for c in re.split(r"[^㐀-鿿]+", zh) if c]
SPLIT = r"[\s'’,.!?;:，。！？、…《》“”\"()（）·\-]+"

lines = json.load(open(a.lines, encoding="utf8"))
lex, problems = {}, []
for ln in lines:
    try:
        sylls = [x for w in re.split(SPLIT, ln["py"]) if w for x in syllabify(w)]
    except ValueError as e:
        problems.append(f"{ln['zh']}  ({e})"); continue
    cl = clauses(ln["zh"])
    n_han = sum(len(c) for c in cl)
    n_syl = len(sylls)  # an erhua "r" stands for the character 儿
    if re.search(r"[0-9A-Za-z]", ln["zh"]):
        problems.append(f"{ln['zh']}  (半角の数字・英字が入っています)")
    if n_han != n_syl:
        problems.append(f"{ln['zh']}  (漢字{n_han}字 / ピンイン{n_syl}音節: {ln['py']})"); continue
    k = 0
    for c in cl:
        part = sylls[k:k + len(c)]; k += len(c)
        pron = kokoro_phones(sandhi(part))
        if c in lex and lex[c] != pron:
            problems.append(f"{c}  (同じ文字列に別の読み: {lex[c]} / {pron})")
        lex[c] = pron
if problems:
    print("ピンインの問題（音声は作りません）:\n  " + "\n  ".join(problems))
    sys.exit(1)

# ---------- forced lexicon + jieba dict ----------
W = a.work
shutil.rmtree(os.path.join(W, "dict"), ignore_errors=True)
shutil.copytree(os.path.join(K, "dict"), os.path.join(W, "dict"))
with open(os.path.join(W, "lexicon-zh.txt"), "w", encoding="utf8") as w:
    w.write(open(os.path.join(K, "lexicon-zh.txt"), encoding="utf8").read().rstrip("\n") + "\n")
    for c, p in lex.items():
        w.write(f"{c} {p}\n")
for f in ("user.dict.utf8", "jieba.dict.utf8"):
    with open(os.path.join(W, "dict", f), "a", encoding="utf8") as w:
        for c in lex:
            w.write(f"{c} 100000000 n\n")

import sherpa_onnx, soundfile as sf
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=os.path.join(K, "model.onnx"), voices=os.path.join(K, "voices.bin"), tokens=os.path.join(K, "tokens.txt"),
            lexicon=f"{os.path.join(K, 'lexicon-us-en.txt')},{os.path.join(W, 'lexicon-zh.txt')}",
            dict_dir=os.path.join(W, "dict"), data_dir=os.path.join(K, "espeak-ng-data")),
        num_threads=8),
    max_num_sentences=1))

os.makedirs(a.out, exist_ok=True)
index, made = {}, []
for ln in lines:
    zh = ln["zh"]
    key = hashlib.sha1(zh.encode("utf8")).hexdigest()[:10]
    mp3 = os.path.join(a.out, key + ".mp3")
    index[zh] = f"audio/{key}.mp3"
    if a.only_new and os.path.exists(mp3):
        continue
    text = re.sub(r"[《》“”]", "", zh).replace("……", "，").replace("…", "，")
    au = tts.generate(text, sid=VOICE.get(ln.get("role"), 25), speed=1.0)
    wav = os.path.join(W, key + ".wav")
    sf.write(wav, au.samples, samplerate=au.sample_rate, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,adelay=60",
                    "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", mp3], check=True)
    made.append((zh, wav))
# drop recordings no longer used
keep = {os.path.basename(v) for v in index.values()}
for f in os.listdir(a.out):
    if f.endswith(".mp3") and f not in keep:
        os.remove(os.path.join(a.out, f))
with open(a.index, "w", encoding="utf8") as w:
    w.write("/* 録音済み音声（中国語の文 → ファイル）。tools/make_audio.py が自動生成します。 */\nwindow.AUDIO = ")
    json.dump(index, w, ensure_ascii=False, indent=0)
    w.write(";\n")
print(f"{len(made)} 件を作成 / 全 {len(index)} 件")

# ---------- optional ASR check ----------
if a.check and made:
    import numpy as np
    P = os.path.join(a.models, "sherpa-onnx-paraformer-zh-2024-03-09")
    rec = sherpa_onnx.OfflineRecognizer.from_paraformer(paraformer=os.path.join(P, "model.int8.onnx"), tokens=os.path.join(P, "tokens.txt"), num_threads=8)
    han = lambda s: re.sub(r"[^㐀-鿿]", "", s)
    NORM = str.maketrans({"他": "她", "它": "她", "哪": "那", "呐": "呢", "啦": "了", "嘛": "吗", "的": "得", "地": "得", "在": "再", "做": "作"})
    bad, err_sum, n_sum = [], 0, 0
    for zh, wav in made:
        x, sr = sf.read(wav, dtype="float32")
        s = rec.create_stream(); s.accept_waveform(sr, x); rec.decode_stream(s)
        ref, hyp = han(zh).translate(NORM), han(s.result.text).translate(NORM)
        sm = difflib.SequenceMatcher(None, ref, hyp)
        err = max(len(ref), len(hyp)) - sum(m.size for m in sm.get_matching_blocks())
        err_sum += err; n_sum += len(ref)
        if err:
            bad.append((err / max(1, len(ref)), zh, s.result.text))
    bad.sort(reverse=True)
    json.dump(bad, open(os.path.join(W, "asr_report.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
    print(f"ASR: 文字誤り率 {err_sum / max(1, n_sum):.3f}、完全一致 {len(made) - len(bad)}/{len(made)}")
    for r, zh, hyp in bad[:40]:
        print(f"  {r:.2f} {zh}\n       → {hyp}")
