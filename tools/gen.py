"""Generate one mp3 per line with the Baker Mandarin voice, forcing the hand-checked pinyin."""
import hashlib, json, os, shutil, subprocess, sys
import sherpa_onnx, soundfile as sf

M = "matcha-icefall-zh-baker"
OUT = sys.argv[1]
only = sys.argv[2:]  # optional: only these zh lines

lines = json.load(open("lines_prepped.json", encoding="utf8"))

# lexicon: original + one entry per clause with our pinyin
os.makedirs("work/dict", exist_ok=True)
for f in os.listdir(f"{M}/dict"):
    p = f"{M}/dict/{f}"
    if os.path.isfile(p):
        shutil.copy(p, f"work/dict/{f}")
    else:
        shutil.copytree(p, f"work/dict/{f}", dirs_exist_ok=True)
clause_pron = {}
for ln in lines:
    for c, pron in ln["clauses"]:
        clause_pron[c] = pron
with open("work/lexicon.txt", "w", encoding="utf8") as w:
    w.write(open(f"{M}/lexicon.txt", encoding="utf8").read().rstrip("\n") + "\n")
    for c, pron in clause_pron.items():
        w.write(f"{c} {pron}\n")
with open("work/dict/user.dict.utf8", "a", encoding="utf8") as w:
    for c in clause_pron:
        w.write(f"{c} 100000000 n\n")
# jieba's main dict too, so max-probability segmentation keeps each clause whole
with open("work/dict/jieba.dict.utf8", "a", encoding="utf8") as w:
    for c in clause_pron:
        w.write(f"{c} 100000000 n\n")

cfg = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
            acoustic_model=f"{M}/model-steps-3.onnx",
            vocoder="vocos-22khz-univ.onnx",
            lexicon="work/lexicon.txt",
            tokens=f"{M}/tokens.txt",
            dict_dir="work/dict",
        ),
        num_threads=4,
        debug=bool(os.environ.get("DEBUG")),
    ),
    max_num_sentences=1,
)
tts = sherpa_onnx.OfflineTts(cfg)

os.makedirs(OUT, exist_ok=True)
index = {}
for ln in lines:
    zh = ln["zh"]
    key = hashlib.sha1(zh.encode("utf8")).hexdigest()[:10]
    index[zh] = f"audio/{key}.mp3"
    if only and zh not in only:
        continue
    # keep only clause text + simple punctuation for natural pauses
    text = "".join(ch if ch not in "《》“”……" else ("，" if ch == "…" else "") for ch in zh)
    audio = tts.generate(text, sid=0, speed=1.0)
    wav = f"work/{key}.wav"
    sf.write(wav, audio.samples, samplerate=audio.sample_rate, subtype="PCM_16")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-ac", "1", "-ar", "22050",
                    "-codec:a", "libmp3lame", "-b:a", "48k", f"{OUT}/{key}.mp3"], check=True)
json.dump(index, open(f"{OUT}/index.json", "w", encoding="utf8"), ensure_ascii=False, indent=0)
print("done", len(index))
