"""Turn each line's hand-written pinyin into model syllables (tone numbers, surface
3rd-tone sandhi) and build a lexicon + jieba user dict so every clause is read
exactly as written, with no polyphone guessing."""
import json, re, sys, unicodedata

M = "matcha-icefall-zh-baker"
tokens = [l.split()[0] for l in open(f"{M}/tokens.txt", encoding="utf8") if l.strip()]
tokset = set(tokens)
bases = sorted({re.sub(r"\d$", "", t) for t in tokens if re.fullmatch(r"[a-z]+\d?", t)}, key=len, reverse=True)
baseset = set(bases)

TONE = {"̄": 1, "́": 2, "̌": 3, "̀": 4}

def letters_with_tone(word):
    """'Zhōngtián' -> list of (letter, tone or 0)"""
    out = []
    for ch in unicodedata.normalize("NFD", word.lower()):
        if ch in TONE:
            out[-1] = (out[-1][0], TONE[ch])
        elif ch == "̈":  # ü
            out[-1] = ("v", out[-1][1])
        elif ch.isalpha():
            out.append((ch, 0))
    return out

def syllabify(word):
    """Split concatenated pinyin. Prefers splits with one tone mark per syllable,
    no vowel-initial syllable inside a word (rènao = re.nao, not ren.ao), fewest pieces."""
    lt = letters_with_tone(word)
    s = "".join(c for c, _ in lt)
    from functools import lru_cache
    @lru_cache(None)
    def best(i):
        if i == len(s):
            return (0, ())
        cands = []
        for b in bases:
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
        if s[i] == "r" and i > 0:
            rest = best(i + 1)
            if rest is not None:
                cands.append((1 + rest[0], (("er", 2),) + rest[1]))
        return min(cands) if cands else None
    r = best(0)
    if r is None:
        raise ValueError(f"cannot split {word!r}")
    return list(r[1])

HAN = re.compile(r"[㐀-鿿]")

def clauses(zh):
    return [c for c in re.split(r"[^㐀-鿿]+", zh) if c]

def sandhi(sylls):
    s = list(sylls)
    i = 0
    while i < len(s):
        if s[i][1] == 3:
            j = i
            while j + 1 < len(s) and s[j + 1][1] == 3:
                j += 1
            for k in range(i, j):
                s[k] = (s[k][0], 2)
            i = j + 1
        else:
            i += 1
    return s

def tok(b, t):
    name = b + (str(t) if t else "")
    if name not in tokset:
        name = b if b in tokset else b + "5"
    if name not in tokset:
        raise ValueError(f"no token {b}{t}")
    return name

lines = json.load(open("lines.json", encoding="utf8"))
lex, udict, bad = {}, {}, []
for ln in lines:
    words = [w for w in re.split(r"[\s'’,.!?;:，。！？…《》“”\"()（）·\-]+", ln["py"]) if w]
    sylls = [s for w in words for s in syllabify(w)]
    cl = clauses(ln["zh"])
    n = sum(len(c) for c in cl)
    if n != len(sylls):
        bad.append((ln["zh"], ln["py"], n, len(sylls), " ".join(b + str(t) for b, t in sylls)))
        continue
    k = 0
    for c in cl:
        part = sandhi(sylls[k:k + len(c)]); k += len(c)
        pron = " ".join(tok(b, t) for b, t in part)
        if c in lex and lex[c] != pron and len(c) > 1:
            print("conflict", c, lex[c], "|", pron)
        lex[c] = pron
    ln["clauses"] = [[c, lex[c]] for c in cl]

for b in bad:
    print("MISMATCH", *b, sep="\n  ")
json.dump(lines, open("lines_prepped.json", "w", encoding="utf8"), ensure_ascii=False, indent=1)
print(len(lines), "lines", len(lex), "clauses", len(bad), "mismatches")
