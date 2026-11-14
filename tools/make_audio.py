"""Generate the app's recorded Mandarin audio with Kokoro v1.1-zh (sherpa-onnx).

Pronunciation is forced from the hand-written pinyin in the scripts, so polyphones
(干杯, 这行, 还 …) are never guessed. 3rd-tone sandhi is applied automatically.

usage:
  node tools/export_lines.js work/lines.json
  python3 tools/make_audio.py --models M --dry-run                 # check the pinyin only
  python3 tools/make_audio.py --models M --shard 0/2 --check &     # generate (shards can run in parallel)
  python3 tools/make_audio.py --models M --shard 1/2 --check &
  python3 tools/make_audio.py --models M --bundle                  # pack into audio/*.mp3 + js/audio-index.js

Each line is rendered to work/mp3/<sha1>.mp3 (kept as a cache: existing files are skipped).
--bundle concatenates them into one file per scene (and a few for words) so the app ships
~40 files instead of thousands; js/audio-index.js maps each sentence to [file, offset, length].

MODELS_DIR must contain kokoro-multi-lang-v1_1/ (and, for --check,
sherpa-onnx-paraformer-zh-2024-03-09/). See tools/README.md.
"""
import argparse, collections, difflib, hashlib, json, os, re, shutil, subprocess, sys, unicodedata
from functools import lru_cache

VOICE = {"p": 102, "me": 25, "word": 25}   # Kokoro: partner male voice, learner lines and words female voice
ap = argparse.ArgumentParser()
ap.add_argument("--models", required=True)
ap.add_argument("--engine", default="zipvoice", choices=["zipvoice", "kokoro"])
ap.add_argument("--zv-voices", default="p=k102,me=k25,word=k25", help="ZipVoice: role=voice name in tools/voices/voices.json")
ap.add_argument("--zv-steps", type=int, default=8)
ap.add_argument("--zv-script-tones", action="store_true", help="ZipVoice: use the script's tones as written (default: pypinyin's tones, which is how the model was trained, whenever the syllable itself agrees)")
ap.add_argument("--zv-gs", type=float, default=3.0, help="ZipVoice guidance scale")
ap.add_argument("--zv-word-tempo", type=float, default=0.85, help="ZipVoice: stretch single words (said slower and clearer); one-character words get x0.9 more")
ap.add_argument("--roles", default="", help="generate only these roles, e.g. me,word")
ap.add_argument("--zv-int8", action="store_true", help="ZipVoice: faster int8 decoder")
ap.add_argument("--lines", default="work/lines.json")
ap.add_argument("--out", default="audio")
ap.add_argument("--index", default="js/audio-index.js")
ap.add_argument("--work", default="", help="cache dir (default: work/<engine>)")
ap.add_argument("--check", action="store_true", help="transcribe new audio with ASR and report mismatches")
ap.add_argument("--shard", default="0/1", help="k/n: generate only every n-th line starting at k")
ap.add_argument("--dry-run", action="store_true", help="only check the pinyin")
ap.add_argument("--bundle", action="store_true", help="pack generated mp3s into bundles and write the index")
ap.add_argument("--redo", default="", help="file with Chinese sentences (one per line) to regenerate")
a = ap.parse_args()
K = os.path.join(a.models, "kokoro-multi-lang-v1_1")
ZV = os.path.join(a.models, "sherpa-onnx-zipvoice-distill-zh-en-emilia")
TOOLS = os.path.dirname(os.path.abspath(__file__))

# ---------- pinyin -> syllables ----------
TONE = {"̄": 1, "́": 2, "̌": 3, "̀": 4}

MAP_FILE = os.path.join(TOOLS, "kokoro_syllables.json")
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

# ZipVoice tokens: initial + "0", final + tone (5 = neutral), spelling-based like pypinyin(strict=False)
INITS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"]
try:
    from pypinyin import lazy_pinyin, Style
except ImportError:
    lazy_pinyin = None

def zv_align(chars, sylls):
    """ZipVoice was trained on pypinyin labels, which rarely mark neutral tones (先生 xian1 sheng1, 试试 shi4 shi4).
    Feeding the script's neutral tones made it slur those syllables, so keep the script's syllable (that fixes
    polyphones) but take pypinyin's tone wherever both agree on the syllable itself."""
    if lazy_pinyin is None or a.zv_script_tones:
        return sylls
    pp = lazy_pinyin(chars, style=Style.TONE3, neutral_tone_with_five=True)
    if len(pp) != len(sylls):
        return sylls
    out = []
    for (b, t), q in zip(sylls, pp):
        qb, qt = (q[:-1], int(q[-1])) if q[-1:].isdigit() else (q, 5)
        if b == "R":
            out.append(("er", qt) if qb == "er" else (b, t))
        else:
            out.append((b, qt) if qb == b else (b, t))
    return out

def zv_tokens(sylls):
    out = []
    for b, t in sylls:
        t = str(t or 5)
        if b == "R":
            out.append("er5")
        elif b in ("ng", "n", "m"):
            out.append(("m" if b == "m" else "n") + (t if t != "1" else "2"))
        else:
            i = next((i for i in INITS if b.startswith(i) and len(b) > len(i)), "")
            out += ([i + "0"] if i else []) + [b[len(i):] + t]
    return " ".join(out)
ZV_PUNCT = {"，": ",", "。": ".", "！": "!", "？": "?", "、": ",", "：": ",", "；": ","}

HAN = re.compile(r"[㐀-鿿]")
clauses = lambda zh: [c for c in re.split(r"[^㐀-鿿]+", zh) if c]
SPLIT = r"[\s'’,.!?;:，。！？、…《》“”\"()（）·\-]+"

lines = json.load(open(a.lines, encoding="utf8"))
VOICES = json.load(open(os.path.join(TOOLS, "voices", "voices.json"), encoding="utf8"))
lex, zlex, problems = {}, {}, []
for ln in lines + [{"zh": v["text"], "py": v["py"]} for v in VOICES.values()]:
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
    ln["_zv"], ln["_zv_script"] = [], []
    for c in cl:
        part = sylls[k:k + len(c)]; k += len(c)
        ln["_zv"].append(zv_tokens(zv_align(c, part)))
        ln["_zv_script"].append(zv_tokens(part))
        if len(c) > 1 or c not in zlex or not zv_tokens(part).endswith("5"):
            zlex[c] = zv_tokens(zv_align(c, part))
        pron = kokoro_phones(sandhi(part))
        if c in lex and lex[c] != pron:
            if len(c) > 1:
                problems.append(f"{c}  (同じ文字列に別の読み: {lex[c]} / {pron})")
            elif pron.endswith(" 5"):
                continue  # a lone character: keep the toned reading, not the neutral one
        lex[c] = pron
if problems:
    print("ピンインの問題（音声は作りません）:\n  " + "\n  ".join(problems))
    sys.exit(1)

if a.dry_run:
    nd = sum(1 for ln in lines if ln["_zv"] != ln["_zv_script"])
    print(f"ピンインOK: {len(lines)} 文（ZipVoice で台本と違う声調を使う文 {nd}）"); sys.exit(0)

W = a.work or os.path.join("work", a.engine)
MP3 = os.path.join(W, "mp3")
os.makedirs(MP3, exist_ok=True)
keyof = lambda zh: hashlib.sha1(zh.encode("utf8")).hexdigest()[:10]

# ---------- bundle ----------
if a.bundle:
    os.makedirs(a.out, exist_ok=True)
    groups = collections.OrderedDict()
    for ln in lines:
        groups.setdefault(ln.get("bundle") or "misc", []).append(ln["zh"])
    index, missing = {}, []
    for name, zhs in groups.items():
        data, off = bytearray(), 0
        for zh in zhs:
            f = os.path.join(MP3, keyof(zh) + ".mp3")
            if not os.path.exists(f):
                missing.append(zh); continue
            b = open(f, "rb").read()
            index[zh] = [name, len(data), len(b)]
            data += b
        open(os.path.join(a.out, name + ".mp3"), "wb").write(data)
    for f in os.listdir(a.out):
        if f.endswith(".mp3") and f[:-4] not in groups:
            os.remove(os.path.join(a.out, f))
    with open(a.index, "w", encoding="utf8") as w:
        w.write("/* 録音済み音声。文 → [audio/のファイル名, 開始バイト, 長さ]。tools/make_audio.py --bundle が自動生成します。 */\nwindow.AUDIO = ")
        json.dump(index, w, ensure_ascii=False, separators=(",", ":"))
        w.write(";\n")
    sizes = sum(os.path.getsize(os.path.join(a.out, n + ".mp3")) for n in groups)
    print(f"{len(groups)} ファイル / {len(index)} 文 / {sizes / 1e6:.1f} MB")
    if missing:
        print(f"音声がない文 {len(missing)} 件（先に生成してください）:", *missing[:10], sep="\n  ")
    reps = [json.load(open(os.path.join(W, f), encoding="utf8")) for f in sorted(os.listdir(W)) if f.startswith("asr_") and f.endswith(".json")]
    if reps:
        bad = sorted([x for r in reps for x in r["bad"]], reverse=True)
        n = sum(r["n"] for r in reps); e = sum(r["err"] for r in reps); c = sum(r["chars"] for r in reps)
        json.dump(bad, open(os.path.join(W, "asr_report.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
        print(f"ASR: {n} 文、文字誤り率 {e / max(1, c):.3f}、完全一致 {n - len(bad)}/{n}（詳細 {W}/asr_report.json）")
    sys.exit(0)

# ---------- forced lexicon + jieba dict ----------
k_sh, n_sh = map(int, a.shard.split("/"))
import sherpa_onnx, soundfile as sf
threads = max(1, (os.cpu_count() or 4) // n_sh)
if a.engine == "zipvoice":
    import numpy as np
    ZLEX = os.path.join(W, f"zv-lexicon{k_sh}.txt")
    with open(ZLEX, "w", encoding="utf8") as w:
        for c, p in zlex.items():
            w.write(f"{c} {p}\n")
        for c, p in ZV_PUNCT.items():
            w.write(f"{c} {p}\n")
    zv = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            zipvoice=sherpa_onnx.OfflineTtsZipvoiceModelConfig(
                tokens=os.path.join(ZV, "tokens.txt"), encoder=os.path.join(ZV, "text_encoder.onnx"),
                decoder=os.path.join(ZV, "fm_decoder_int8.onnx" if a.zv_int8 else "fm_decoder.onnx"),
                vocoder=os.path.join(ZV, "vocos_24khz.onnx"), lexicon=ZLEX, guidance_scale=a.zv_gs),
            num_threads=threads)))
    role_voice = dict(x.split("=") for x in a.zv_voices.split(","))
    prompts = {}
    for name in set(role_voice.values()):
        v = VOICES[name]
        x, sr = sf.read(os.path.join(TOOLS, "voices", v["wav"]), dtype="float32")
        prompts[name] = (v["text"], (x.mean(1) if x.ndim > 1 else x).tolist(), sr)
    def synth(text, role):
        pt, px, psr = prompts[role_voice.get(role, role_voice["me"])]
        # (slowing ZipVoice itself down makes it leak the prompt into short words, so words are stretched afterwards)
        au = zv.generate(text, pt, px, psr, 1.0, a.zv_steps)
        x = np.array(au.samples, dtype=np.float32)
        x = x / max(1e-6, float(np.sqrt((x ** 2).mean()))) * 0.08   # same loudness for every line
        return np.clip(x, -1, 1), au.sample_rate
else:
    DW = os.path.join(W, f"dict{k_sh}")
    shutil.rmtree(DW, ignore_errors=True)
    shutil.copytree(os.path.join(K, "dict"), DW)
    LEX = os.path.join(W, f"lexicon-zh{k_sh}.txt")
    with open(LEX, "w", encoding="utf8") as w:
        w.write(open(os.path.join(K, "lexicon-zh.txt"), encoding="utf8").read().rstrip("\n") + "\n")
        for c, p in lex.items():
            w.write(f"{c} {p}\n")
    for f in ("user.dict.utf8", "jieba.dict.utf8"):
        with open(os.path.join(DW, f), "a", encoding="utf8") as w:
            for c in lex:
                w.write(f"{c} 100000000 n\n")

    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=os.path.join(K, "model.onnx"), voices=os.path.join(K, "voices.bin"), tokens=os.path.join(K, "tokens.txt"),
                lexicon=f"{os.path.join(K, 'lexicon-us-en.txt')},{LEX}", dict_dir=DW, data_dir=os.path.join(K, "espeak-ng-data")),
            num_threads=threads),
        max_num_sentences=1))
    def synth(text, role):
        au = tts.generate(text, sid=VOICE.get(role, 25), speed=1.0)
        return au.samples, au.sample_rate
rec = None
if a.check:
    P = os.path.join(a.models, "sherpa-onnx-paraformer-zh-2024-03-09")
    rec = sherpa_onnx.OfflineRecognizer.from_paraformer(paraformer=os.path.join(P, "model.int8.onnx"), tokens=os.path.join(P, "tokens.txt"), num_threads=threads)
han = lambda s: re.sub(r"[^\u3400-\u9fff]", "", s)
NORM = str.maketrans({"他": "她", "它": "她", "哪": "那", "呐": "呢", "啦": "了", "嘛": "吗", "的": "得", "地": "得", "在": "再", "做": "作"})
redo = set(l.strip() for l in open(a.redo, encoding="utf8")) if a.redo else set()
# ZipVoice: remember which tokens each mp3 was made from, so a pronunciation change re-renders exactly the affected lines
SIGF = os.path.join(W, "tokens.json")
SIGS = json.load(open(SIGF, encoding="utf8")) if os.path.exists(SIGF) else {}
sig = lambda ln: " | ".join(ln.get("_zv", [])) if a.engine == "zipvoice" else ""
if a.engine == "zipvoice":
    for ln in lines:   # mp3s made before this record existed used the script's tones as written
        if keyof(ln["zh"]) not in SIGS and os.path.exists(os.path.join(MP3, keyof(ln["zh"]) + ".mp3")):
            SIGS[keyof(ln["zh"])] = " | ".join(ln.get("_zv_script", []))
def save_sigs():
    if a.engine == "zipvoice" and n_sh == 1:
        json.dump(SIGS, open(SIGF, "w", encoding="utf8"), ensure_ascii=False)
rep = {"n": 0, "err": 0, "chars": 0, "bad": []}
made = 0
for i, ln in enumerate(lines):
    if i % n_sh != k_sh:
        continue
    if a.roles and ln.get("role") not in a.roles.split(","):
        continue
    zh = ln["zh"]
    mp3 = os.path.join(MP3, keyof(zh) + ".mp3")
    if os.path.exists(mp3) and zh not in redo and SIGS.get(keyof(zh), sig(ln)) == sig(ln):
        continue
    text = re.sub(r"[《》“”]", "", zh).replace("……", "，").replace("…", "，")
    samples, srate = synth(text, ln.get("role"))
    wav = os.path.join(W, f"tmp{k_sh}.wav")
    sf.write(wav, samples, samplerate=srate, subtype="PCM_16")
    af = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,adelay=60"
    if a.engine == "zipvoice" and ln.get("role") == "word":
        af += ",atempo=%.3f" % (a.zv_word_tempo * (0.9 if len(HAN.findall(text)) == 1 else 1.0))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-af", af,
                    "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "48k", "-write_xing", "0", "-id3v2_version", "0", mp3], check=True)
    made += 1
    SIGS[keyof(zh)] = sig(ln)
    if rec:
        s = rec.create_stream(); s.accept_waveform(srate, samples); rec.decode_stream(s)
        ref, hyp = han(zh).translate(NORM), han(s.result.text).translate(NORM)
        sm = difflib.SequenceMatcher(None, ref, hyp)
        err = max(len(ref), len(hyp)) - sum(m.size for m in sm.get_matching_blocks())
        rep["n"] += 1; rep["err"] += err; rep["chars"] += len(ref)
        if err:
            rep["bad"].append([round(err / max(1, len(ref)), 3), zh, s.result.text])
    if made % 50 == 0:
        print(f"[{k_sh}/{n_sh}] {made} 件", flush=True)
        if rec: json.dump(rep, open(os.path.join(W, f"asr_{k_sh}.json"), "w", encoding="utf8"), ensure_ascii=False)
        save_sigs()
if rec:
    json.dump(rep, open(os.path.join(W, f"asr_{k_sh}.json"), "w", encoding="utf8"), ensure_ascii=False)
save_sigs()
print(f"[{k_sh}/{n_sh}] 完了: {made} 件を作成")
