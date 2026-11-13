/* 熊猫 xióngmāo — 中国語会話アプリ (vanilla JS, no build step)
 *
 * Data (loaded before this file):
 *   window.SCENES  js/scenes.js       台本
 *   window.WORDS   js/words.js        単語・つなぎ言葉・フレーズ（任意）
 *   window.AUDIO   js/audio-index.js  中国語の文 → 録音ファイル
 */
(function () {
  "use strict";

  const SCENES = window.SCENES || [];
  const AUDIO = window.AUDIO || {};
  const view = document.getElementById("view");
  const now = () => Date.now();
  const DAY = 86400000;

  /* =============== storage (this browser only) =============== */
  const NS = "xm:";
  const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const settings = Object.assign({ style: "challenge", pinyin: true, subs: "show", ja: false, rate: 1 }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);

  /* =============== helpers =============== */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const isLine = (x) => Array.isArray(x) && typeof x[0] === "string";
  const asLines = (p) => (isLine(p) ? [p] : (p || []));
  const I = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    slow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
    go: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l11 7-11 7z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
  };

  /* =============== content model =============== */
  // every learner line (r) and partner line (p) reachable in a scene, across all branches
  function sceneLines(scene) {
    const p = [], r = [];
    (function walk(turns) {
      for (const t of turns) {
        if (t.alt) { t.alt.forEach(walk); continue; }
        asLines(t.p).forEach((l) => p.push(l));
        (t.r || []).forEach((l) => r.push(l));
      }
    })(scene.turns);
    const uniq = (a) => { const s = new Set(); return a.filter((l) => !s.has(l[0]) && s.add(l[0])); };
    return { p: uniq(p), r: uniq(r) };
  }
  function turnRange(scene) {
    function len(turns) {
      let lo = 0, hi = 0;
      for (const t of turns) {
        if (t.alt) { const ls = t.alt.map(len); lo += Math.min(...ls.map((x) => x[0])); hi += Math.max(...ls.map((x) => x[1])); }
        else { hi += 1; if (!t.opt) lo += 1; }
      }
      return [lo, hi];
    }
    return len(scene.turns);
  }
  // A fresh run: random branch, optional turns in or out, random partner wording, shuffled replies
  function buildRun(scene) {
    const out = [];
    (function walk(turns) {
      for (const t of turns) {
        if (t.alt) { walk(pick(t.alt)); continue; }
        if (t.opt && Math.random() < 0.5) continue;
        out.push({ p: pick(asLines(t.p)), r: shuffle(t.r || []), k: t.k || [] });
      }
    })(scene.turns);
    return out;
  }

  // Words: from js/words.js, otherwise collected from the turns' k notes
  const WORDS = (function () {
    if (Array.isArray(window.WORDS) && window.WORDS.length) return window.WORDS;
    const map = new Map();
    const all = [];
    SCENES.forEach((s) => (function walk(turns) {
      for (const t of turns) {
        if (t.alt) { t.alt.forEach(walk); continue; }
        const ls = asLines(t.p).concat(t.r || []);
        (t.k || []).forEach((k) => {
          if (!map.has(k[0])) map.set(k[0], { w: k[0], py: k[1], ja: k[2], kind: "単語", hsk: null, scenes: [], ex: [] });
          const w = map.get(k[0]);
          if (!w.scenes.includes(s.id)) w.scenes.push(s.id);
          ls.forEach((l) => { if (containsWord(l[0], k[0]) && !w.ex.some((e) => e[0] === l[0])) w.ex.push([l[0], l[1], l[2], s.id]); });
        });
        all.push(...ls);
      }
    })(s.turns));
    return [...map.values()];
  })();
  const WORD_BY = new Map(WORDS.map((w) => [w.w, w]));
  const KINDS = ["つなぎ言葉", "接続詞", "フレーズ", "単語"].filter((k) => WORDS.some((w) => w.kind === k));
  WORDS.forEach((w) => { if (w.kind && !KINDS.includes(w.kind)) KINDS.push(w.kind); });

  function wordParts(w) { return String(w).split(/…+|\.\.\.+/).filter(Boolean); }
  function containsWord(zh, w) {
    let i = 0;
    for (const part of wordParts(w)) { const j = zh.indexOf(part, i); if (j < 0) return false; i = j + part.length; }
    return true;
  }
  // wrap the k words inside a sentence: <span class="kw" data-kw="...">
  function highlight(zh, ks) {
    const marks = new Array(zh.length).fill(null);
    (ks || []).forEach((k) => {
      const w = Array.isArray(k) ? k[0] : k;
      let i = 0; const spans = [];
      for (const part of wordParts(w)) {
        const j = zh.indexOf(part, i);
        if (j < 0) return;
        spans.push([j, j + part.length]); i = j + part.length;
      }
      if (spans.some(([a, b]) => marks.slice(a, b).some(Boolean))) return;
      spans.forEach(([a, b]) => { for (let x = a; x < b; x++) marks[x] = w; });
    });
    let out = "", cur = null;
    for (let x = 0; x < zh.length; x++) {
      if (marks[x] !== cur) {
        if (cur) out += "</span>";
        if (marks[x]) { const wd = WORD_BY.get(marks[x]); out += `<span class="kw ${wd && /つなぎ|接続/.test(wd.kind || "") ? "conn" : ""}" data-kw="${esc(marks[x])}" role="button" tabindex="0">`; }
        cur = marks[x];
      }
      out += esc(zh[x]);
    }
    if (cur) out += "</span>";
    return out;
  }
  const wordAudioKey = (w) => String(w).replace(/…+|\.\.\.+/g, "，");
  const kindShort = (k) => ({ "つなぎ言葉": "つなぎ", "接続詞": "接続詞", "フレーズ": "フレーズ", "単語": "単語" }[k] || k || "単語");

  /* =============== progress & review (spaced, no streaks) =============== */
  // item keys: "s:<zh>" a line you say, "l:<zh>" a line you hear, "w:<word>" a word
  const prog = store.get("prog", {});
  const saveProg = () => store.set("prog", prog);
  const GAP = [10 * 60000, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 40 * DAY]; // by box after success
  function grade(key, g) {           // g: 0 言えなかった/不正解, 1 あやしい, 2 言えた/正解
    const st = prog[key] || { b: 0, n: 0 };
    st.n += 1; st.t = now(); st.g = g;
    if (g === 2) { st.b = Math.min((st.b || 0) + 1, 5); st.due = now() + GAP[st.b]; }
    else if (g === 1) { st.b = Math.max(1, Math.min(st.b || 0, 2)); st.due = now() + DAY / 2; }
    else { st.b = 0; st.due = now() + GAP[0]; }
    prog[key] = st; saveProg();
  }
  // 0 まだ / 1 練習中 (last try failed or unsure) / 2 言える (last try succeeded) / 3 定着 (succeeded across spaced reviews)
  const tier = (key) => { const st = prog[key]; if (!st) return 0; if (st.b >= 3 && st.g === 2) return 3; return st.g === 2 ? 2 : 1; };
  const TIER_NAME = ["まだ", "練習中", "言える", "定着"];
  function dueItems() {
    const t = now();
    return Object.keys(prog).filter((k) => prog[k].due && prog[k].due <= t).sort((a, b) => prog[a].due - prog[b].due);
  }
  // find line data for a review key
  const LINE_INDEX = (() => {
    const m = new Map();
    SCENES.forEach((s) => { const L = sceneLines(s); L.p.forEach((l) => m.set(l[0], { line: l, scene: s, who: "p" })); L.r.forEach((l) => { if (!m.has(l[0]) || m.get(l[0]).who === "p") m.set(l[0], { line: l, scene: s, who: "me" }); }); });
    return m;
  })();
  const kOf = (zh) => { // k notes of the turn that contains this line
    let found = [];
    SCENES.some((s) => (function walk(turns) {
      for (const t of turns) {
        if (t.alt) { if (t.alt.some(walk)) return true; continue; }
        if (asLines(t.p).concat(t.r || []).some((l) => l[0] === zh)) { found = t.k || []; return true; }
      }
      return false;
    })(s.turns));
    return found;
  };

  /* =============== audio =============== */
  let claudeTts = null, zhVoice = null;
  function findZhVoice() {
    if (!("speechSynthesis" in window)) return null;
    const zh = (speechSynthesis.getVoices() || []).filter((v) => /^(zh|cmn)/i.test(v.lang.replace("_", "-")));
    zhVoice = zh.find((v) => /CN|Hans/i.test(v.lang)) || zh.find((v) => !/HK|TW|yue/i.test(v.lang)) || zh[0] || null;
    return zhVoice;
  }
  if ("speechSynthesis" in window) { findZhVoice(); speechSynthesis.onvoiceschanged = findZhVoice; }
  const player = new Audio();
  player.preload = "auto";
  let playToken = 0;
  const hasAudio = (zh) => !!AUDIO[zh];
  function stopAudio() {
    playToken++;
    try { player.pause(); } catch (e) { /* idle */ }
    if (claudeTts) try { claudeTts.stop(); } catch (e) { /* idle */ }
    if ("speechSynthesis" in window) try { speechSynthesis.cancel(); } catch (e) { /* idle */ }
  }
  // Plays a sentence. Resolves when it has finished (or failed). rate: 1 = natural
  function play(zh, rate) {
    stopAudio();
    const token = playToken;
    const r = rate || settings.rate;
    if (!zh) return Promise.resolve();
    if (AUDIO[zh]) {
      return new Promise((res) => {
        player.src = AUDIO[zh];
        player.playbackRate = r;
        if ("preservesPitch" in player) player.preservesPitch = true;
        player.onended = () => res(true);
        player.onerror = () => res(false);
        player.play().catch(() => { if (token === playToken) speakLive(zh, r).then(res); else res(false); });
      });
    }
    return speakLive(zh, r);
  }
  function speakLive(zh, r) {
    const text = String(zh).replace(/[《》“”]/g, "");
    if (claudeTts) return claudeTts.speak(text, { language: "zh", rate: Math.min(1.5, Math.max(0.7, r)) }).then(() => true, () => false);
    const v = zhVoice || findZhVoice();
    if (!("speechSynthesis" in window) || (!v && (speechSynthesis.getVoices() || []).length)) { toast("この文は録音がなく、端末に中国語の音声もないため再生できません。"); return Promise.resolve(false); }
    return new Promise((res) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "zh-CN"; if (v) u.voice = v; u.rate = r * 0.85;
        u.onend = () => res(true); u.onerror = () => res(false);
        speechSynthesis.speak(u);
      } catch (e) { res(false); }
    });
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  /* =============== microphone =============== */
  const Mic = {
    dict: null, SR: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    rec: null, live: false, finalText: "", partial: "", cb: null, failed: "",
    available() { return !this.failed && !!(this.dict || this.SR); },
    attachDictation(d) {
      this.dict = d;
      d.onPartial(({ text }) => { this.partial = text || ""; this.emit(false); });
      d.onFinal(({ text }) => { this.finalText = (this.finalText + (text || "")).trim(); this.partial = ""; this.emit(false); });
      d.onState(({ state, reason }) => { if (state === "idle") { this.live = false; this.emit(true, reason); } });
    },
    emit(ended, reason) {
      const cb = this.cb;
      if (ended) this.cb = null;
      if (cb) cb({ text: (this.finalText + this.partial).trim(), ended, reason });
    },
    start(cb) { // call straight from a tap
      stopAudio();
      this.cb = cb; this.finalText = ""; this.partial = ""; this.live = true;
      if (this.dict) {
        this.dict.start({ language: "zh-CN" }).catch((e) => {
          this.live = false; const code = (e && e.code) || "error";
          if (code === "unavailable" || code === "not_granted") this.failed = code;
          this.emit(true, code);
        });
        return;
      }
      if (!this.SR) { this.live = false; this.emit(true, "unavailable"); return; }
      const rec = new this.SR(); this.rec = rec; let err = null;
      rec.lang = "zh-CN"; rec.interimResults = true; rec.continuous = false;
      rec.onresult = (e) => { let f = "", t = ""; for (let i = 0; i < e.results.length; i++) (e.results[i].isFinal ? (f += e.results[i][0].transcript) : (t += e.results[i][0].transcript)); this.finalText = f; this.partial = t; this.emit(false); };
      rec.onerror = (e) => { err = e.error; if (err === "not-allowed" || err === "service-not-allowed") this.failed = err; };
      rec.onend = () => { this.live = false; this.rec = null; this.emit(true, err); };
      try { rec.start(); } catch (e) { this.live = false; this.emit(true, "error"); }
    },
    stop() { if (this.dict) this.dict.stop().catch(() => {}); else if (this.rec) try { this.rec.stop(); } catch (e) { /* stopped */ } }
  };
  const micError = (r) => ({
    "not-allowed": "マイクが許可されていません。", "service-not-allowed": "この画面では音声入力が使えません。", not_granted: "マイクが許可されていません。",
    "no-speech": "声が聞き取れませんでした。もう一度どうぞ。", unavailable: "この端末では音声入力が使えません。",
    dismissed: "マイクの確認が閉じられました。", network: "音声認識の通信に失敗しました。"
  }[r] || "声が聞き取れませんでした。もう一度どうぞ。");

  /* =============== pronunciation match =============== */
  const DIG = "零一二三四五六七八九";
  const numZh = (n) => { n = +n; if (isNaN(n) || n > 99) return String(n); if (n < 10) return DIG[n]; const t = Math.floor(n / 10), o = n % 10; return (t === 1 ? "" : DIG[t]) + "十" + (o ? DIG[o] : ""); };
  const hanOnly = (s) => String(s || "").replace(/\d+/g, numZh).replace(/[^㐀-鿿]/g, "");
  function compare(said, target) {
    const a = hanOnly(target), b = hanOnly(said), n = a.length, m = b.length;
    if (!n) return { pct: 0, hit: [] };
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const hit = new Array(n).fill(false); let i = n, j = m;
    while (i > 0 && j > 0) { if (a[i - 1] === b[j - 1]) { hit[i - 1] = true; i--; j--; } else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--; }
    return { pct: Math.round((dp[n][m] / Math.max(n, m)) * 100), hit };
  }
  function markHits(zh, hit) {
    let k = 0, out = "";
    for (const ch of zh) { if (/[㐀-鿿]/.test(ch)) { out += `<span class="${hit[k] ? "hit" : "miss"}">${esc(ch)}</span>`; k++; } else out += esc(ch); }
    return out;
  }

  /* =============== shared UI pieces =============== */
  const playBtn = (zh, label, cls) => `<button class="${cls || "chip"}" data-play="${esc(zh)}" aria-label="${esc(label || "聞く")}">${I.play}${cls === "icon-btn" ? "" : esc(label || "聞く")}</button>`;
  function sheet(html) {
    closeSheet();
    const el = document.createElement("div");
    el.className = "sheet-wrap"; el.id = "sheet";
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}<button class="btn wide ghost" data-close-sheet>閉じる</button></div>`;
    el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close-sheet]")) closeSheet(); });
    document.body.appendChild(el);
  }
  function closeSheet() { const s = document.getElementById("sheet"); if (s) s.remove(); }
  function wordSheet(w) {
    const wd = WORD_BY.get(w);
    if (!wd) return;
    const exs = (wd.ex || []).slice(0, 4);
    sheet(`<div class="ws-head"><span class="kind">${esc(kindShort(wd.kind))}${wd.hsk ? ` ・ HSK${wd.hsk}` : ""}</span>
      <div class="ws-w" lang="zh-CN">${esc(wd.w)}</div><div class="ws-py">${esc(wd.py)}</div><div class="ws-ja">${esc(wd.ja)}</div>
      <div class="row">${playBtn(wordAudioKey(wd.w), "単語を聞く")}<span class="tier t${tier("w:" + wd.w)}">${TIER_NAME[tier("w:" + wd.w)]}</span></div></div>
      ${exs.length ? `<div class="eyebrow">会話の中では</div><ul class="exs">${exs.map((e) => `<li><div class="zh" lang="zh-CN">${highlight(e[0], [wd.w])}</div><div class="py">${esc(e[1])}</div><div class="ja">${esc(e[2])}</div>${playBtn(e[0])}</li>`).join("")}</ul>` : ""}`);
  }

  /* =============== router =============== */
  const TABS = ["home", "words", "ai", "stats", "prefs"];
  let ctrl = null;
  function route() {
    const h = (location.hash || "#home").slice(1);
    if (Mic.live) Mic.stop();
    stopAudio(); closeSheet();
    const focusMode = /^(scene-|review|wq)/.test(h);
    document.body.classList.toggle("focus", focusMode);
    document.querySelectorAll(".tabbar a").forEach((a) => a.toggleAttribute("aria-current", false));
    const tab = TABS.includes(h) ? h : (h.startsWith("scene-") ? "home" : h === "wq" ? "words" : "home");
    const a = document.querySelector(`.tabbar a[data-tab="${tab}"]`); if (a) a.setAttribute("aria-current", "page");
    if (h.startsWith("scene-")) { const s = SCENES.find((x) => x.id === h.slice(6)); if (s) { ctrl = Scene; return Scene.open(s); } }
    if (h === "review") { ctrl = Review; return Review.open(); }
    if (h === "wq") { ctrl = WordQuiz; return WordQuiz.open(); }
    ctrl = { words: Words, ai: AI, stats: Stats, prefs: Prefs }[h] || Home;
    ctrl.render();
  }
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
  view.addEventListener("click", (e) => {
    const p = e.target.closest("[data-play]");
    if (p) { e.preventDefault(); play(p.getAttribute("data-play"), p.hasAttribute("data-slow") ? 0.75 : undefined); return; }
    const kw = e.target.closest("[data-kw]");
    if (kw) { wordSheet(kw.getAttribute("data-kw")); return; }
    const a = e.target.closest("[data-act]");
    if (a && ctrl && ctrl.act) ctrl.act(a.getAttribute("data-act"), a, e);
  });
  view.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-kw]")) { e.preventDefault(); wordSheet(e.target.getAttribute("data-kw")); } });
  document.addEventListener("click", (e) => { const p = e.target.closest("#sheet [data-play]"); if (p) play(p.getAttribute("data-play")); });

  /* =============== HOME =============== */
  const PANDA = '<svg class="panda" viewBox="0 0 64 64" aria-hidden="true"><circle cx="15" cy="15" r="9" class="pk"/><circle cx="49" cy="15" r="9" class="pk"/><circle cx="32" cy="35" r="24" class="pw"/><ellipse cx="22" cy="33" rx="6.5" ry="8.5" transform="rotate(-25 22 33)" class="pk"/><ellipse cx="42" cy="33" rx="6.5" ry="8.5" transform="rotate(25 42 33)" class="pk"/><circle cx="23" cy="32" r="2.2" class="pw"/><circle cx="41" cy="32" r="2.2" class="pw"/><ellipse cx="32" cy="43" rx="4" ry="2.8" class="pk"/></svg>';
  function sceneMastery(s) {
    const L = sceneLines(s).r;
    const t = L.map((l) => tier("s:" + l[0]));
    return { total: L.length, can: t.filter((x) => x >= 2).length, prac: t.filter((x) => x === 1).length };
  }
  const Home = {
    render() {
      const due = dueItems().length;
      const groups = [];
      SCENES.forEach((s) => { const g = s.group || "場面"; let G = groups.find((x) => x.g === g); if (!G) groups.push(G = { g, list: [] }); G.list.push(s); });
      const last = store.get("lastScene", null);
      const lastScene = last && SCENES.find((s) => s.id === last);
      view.innerHTML = `
        <header class="brand">${PANDA}<div><div class="word" lang="zh-CN">熊猫</div><div class="py">xióngmāo ・ 夜の世間話を中国語で</div></div></header>
        ${Object.keys(prog).length ? "" : `<p class="small muted lead-p">場面を選んで、「話す練習」「聞き取り」「シャドーイング」のどれかで練習します。言えなかった文は、間をあけて復習に出てきます。</p>`}
        ${due ? `<a class="review-card" href="#review"><span><b>復習 ${due}件</b><br><span class="small muted">前に言えなかった・あやしかったものを、間をあけてもう一度。</span></span><span class="btn primary">始める</span></a>` : ""}
        ${lastScene ? `<a class="resume" href="#scene-${lastScene.id}"><span class="mark sm" lang="zh-CN">${esc(lastScene.mark)}</span><span>前回の続き：<b>${esc(lastScene.title)}</b></span>${I.next}</a>` : ""}
        ${groups.map((G) => `
          ${groups.length > 1 ? `<h2 class="group-h">${esc(G.g)}</h2>` : `<h2 class="group-h">場面を選ぶ</h2>`}
          <ul class="scenes">${G.list.map((s) => { const m = sceneMastery(s); const [lo, hi] = turnRange(s); return `<li><a href="#scene-${s.id}">
            <span class="mark" lang="zh-CN" aria-hidden="true">${esc(s.mark)}</span>
            <span class="body"><span class="t">${esc(s.title)}</span><span class="w">${esc(s.where)}</span>
              <span class="meter" aria-label="言えるフレーズ ${m.can} / ${m.total}"><span class="bar"><i class="can" style="width:${(m.can / Math.max(1, m.total)) * 100}%"></i><i class="prac" style="width:${(m.prac / Math.max(1, m.total)) * 100}%"></i></span><span class="n">${m.can}/${m.total}</span></span></span>
            <span class="meta">${lo === hi ? lo : `${lo}〜${hi}`}往復</span></a></li>`; }).join("")}</ul>`).join("")}
        <a class="ai-card" href="#ai"><span class="mark" lang="zh-CN" aria-hidden="true">聊</span><span><b>AIと自由に話す</b><br><span class="small muted">台本なしの会話。不自然なところは直してくれます。</span></span></a>`;
    }
  };

  /* =============== SCENE (speak / listen / shadow) =============== */
  const Scene = {
    open(s) {
      this.s = s; this.mode = null; this.run = null; this.i = 0; this.log = []; this.results = [];
      store.set("lastScene", s.id);
      this.renderIntro();
    },
    header(stepText, frac) {
      return `<header class="focus-head">
        <a class="quit" href="#home">${I.close}<span>やめる</span></a>
        <div class="title"><h1>${esc(this.s.title)}</h1>${stepText ? `<div class="step">${stepText}</div>` : ""}</div>
        <button class="chip speed" data-act="speed" aria-label="再生速度">${settings.rate === 1 ? "速度 1.0" : "速度 " + settings.rate.toFixed(2)}</button>
      </header>${frac != null ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}"><i style="width:${frac * 100}%"></i></div>` : ""}`;
    },
    renderIntro() {
      const s = this.s, [lo, hi] = turnRange(s), m = sceneMastery(s);
      view.innerHTML = `${this.header("", null)}
        <section class="intro">
          <div class="row nowrap"><span class="mark" lang="zh-CN" aria-hidden="true">${esc(s.mark)}</span><div><div class="small muted">${esc(s.where)}</div><p class="lead">${esc(s.intro)}</p></div></div>
          <div class="who">相手：${esc(s.partner)}　・　1回 ${lo === hi ? lo : `${lo}〜${hi}`}往復（毎回流れが少し変わります）</div>
          <div class="modes">
            <button class="mode" data-act="mode" data-mode="speak"><b>話す練習</b><span>相手のセリフを聞いて、自分の返しを中国語で言う</span></button>
            <button class="mode" data-act="mode" data-mode="listen"><b>聞き取り</b><span>文字を隠して音だけで聞き、意味を選ぶ</span></button>
            <button class="mode" data-act="mode" data-mode="shadow"><b>シャドーイング</b><span>会話を流して、音声のすぐ後に続けて言う</span></button>
          </div>
          <div class="small muted">この場面で言えるフレーズ：${m.can} / ${m.total}</div>
          ${s.tips && s.tips.length ? `<details class="tips-box"><summary>知っておくと便利</summary><ul class="tips">${s.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
        </section>`;
    },
    act(a, el) {
      if (a === "speed") { settings.rate = settings.rate === 1 ? 0.75 : settings.rate === 0.75 ? 1.25 : 1; saveSettings(); el.textContent = settings.rate === 1 ? "速度 1.0" : "速度 " + settings.rate.toFixed(2); return; }
      if (a === "mode") { this.mode = el.getAttribute("data-mode"); this.run = buildRun(this.s); this.i = 0; this.log = []; this.results = []; this.phase = "choose"; this.pickI = null; this.said = ""; this.score = null; this.micMsg = ""; this.answered = null; this.choices = null;
        if (this.mode === "shadow") return Shadow.start(this);
        this.enterTurn(); return; }
      if (this.mode === "speak") return this.actSpeak(a, el);
      if (this.mode === "listen") return this.actListen(a, el);
      if (a === "again") return this.act("mode", { getAttribute: () => this.mode });
    },
    enterTurn() {
      const t = this.run[this.i];
      this.phase = this.mode === "listen" ? "hear" : "choose";
      this.pickI = null; this.said = ""; this.score = null; this.micMsg = ""; this.answered = null;
      if (this.mode === "speak") { this.log.push({ who: "p", line: t.p, k: t.k, hide: settings.subs === "after" }); }
      this.render();
      play(t.p[0]).then(() => { // reveal hidden subtitles once heard
        const last = this.log[this.log.length - 1];
        if (this.mode === "speak" && last && last.hide && last.line === t.p) {
          last.hide = false;
          const bs = view.querySelectorAll(".msg.p .bubble"), b = bs[bs.length - 1];
          if (b) { b.classList.remove("hidden-text"); const rb = b.querySelector(".reveal-sub"); if (rb) rb.remove(); }
        }
      });
    },
    stepText() { return `${Math.min(this.i + 1, this.run.length)} / ${this.run.length} 往復`; },
    bubble(x) {
      const showPy = settings.pinyin, showJa = x.who === "me" || settings.ja;
      return `<div class="msg ${x.who}">
        <div class="bubble ${x.hide ? "hidden-text" : ""}">
          <div class="zh" lang="zh-CN">${highlight(x.line[0], x.k)}</div>
          <div class="py" ${showPy ? "" : "hidden"}>${esc(x.line[1])}</div>
          <div class="ja" ${showJa ? "" : "hidden"}>${esc(x.line[2])}</div>
          ${x.line[3] ? `<div class="note" ${showJa ? "" : "hidden"}>${esc(x.line[3])}</div>` : ""}
          ${x.hide ? `<button class="reveal-sub" data-act="unhide">文字を表示</button>` : ""}
        </div>
        <div class="tools">${playBtn(x.line[0])}${x.who === "p" ? `<button class="chip" data-play="${esc(x.line[0])}" data-slow>${I.slow}ゆっくり</button><button class="chip" data-act="toggle" data-t="py">ピンイン</button><button class="chip" data-act="toggle" data-t="ja">訳</button>` : ""}</div>
      </div>`;
    },
    render() {
      if (this.mode === "listen") return this.renderListen();
      const done = this.phase === "end";
      view.innerHTML = `${this.header(done ? "おわり" : this.stepText(), done ? 1 : this.i / this.run.length)}
        <div class="log">${this.log.map((x) => this.bubble(x)).join("")}</div>
        ${done ? this.endHtml() : `<div class="tray">${this.trayHtml()}</div>`}`;
      requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
    },
    micButton(label) {
      return Mic.available() ? `<button class="btn wide mic ${Mic.live ? "live" : ""}" data-act="mic">${I.mic}${Mic.live ? "話し終えたらタップ" : label}</button>` : "";
    },
    trayHtml() {
      const t = this.run[this.i];
      if (this.phase === "choose") {
        return `<div class="label">あなたの番：どう返しますか？</div>
          <div class="options">${t.r.map((r, n) => settings.style === "challenge"
            ? `<button class="option" data-act="pick" data-n="${n}">${esc(r[2])}</button>`
            : `<button class="option" data-act="pick" data-n="${n}"><span class="zh" lang="zh-CN">${esc(r[0])}</span>${settings.pinyin ? `<span class="py">${esc(r[1])}</span>` : ""}<span class="small muted">${esc(r[2])}</span></button>`).join("")}</div>`;
      }
      const r = t.r[this.pickI];
      const heard = `<div class="heard" id="heard">${this.micMsg ? esc(this.micMsg) : this.said ? `聞き取り：<b lang="zh-CN">${esc(this.said)}</b>` : Mic.live ? "聞いています…" : ""}</div>`;
      if (this.phase === "say") {
        return `<div class="label">中国語で言ってみましょう</div>
          <div class="target-ja">${esc(r[2])}</div>${heard}
          <div class="row">${this.micButton("話す")}<button class="btn wide" data-act="reveal">${I.eye}答えを見る</button></div>
          ${Mic.available() ? "" : `<div class="small muted">声に出して言ってから「答えを見る」を押してください。</div>`}`;
      }
      const sc = this.score;
      const ks = (t.k || []).filter((k) => containsWord(r[0], k[0]));
      return `<div class="answer">
          <div class="zh" lang="zh-CN">${sc ? markHits(r[0], sc.hit) : highlight(r[0], t.k)}</div>
          <div class="py">${esc(r[1])}</div><div class="small">${esc(r[2])}</div>
          ${r[3] ? `<div class="note">${esc(r[3])}</div>` : ""}
          <div class="row">${playBtn(r[0], "お手本")}<button class="chip" data-play="${esc(r[0])}" data-slow>${I.slow}ゆっくり</button>${Mic.available() ? `<button class="chip mic ${Mic.live ? "live" : ""}" data-act="mic">${I.mic}${Mic.live ? "話し終えたらタップ" : "もう一度言う"}</button>` : ""}</div>
        </div>
        ${sc ? `<div class="score ${sc.pct >= 85 ? "good" : sc.pct >= 60 ? "mid" : "low"}">一致 ${sc.pct}%${sc.pct >= 85 ? " ・ 通じます" : sc.pct >= 60 ? " ・ 赤い字をもう一度" : " ・ お手本を聞いてもう一度"}</div>` : ""}
        ${heard}
        ${ks.length ? `<div class="points"><span class="eyebrow">この文のポイント</span>${ks.map((k) => `<button class="kchip" data-kw="${esc(k[0])}"><span lang="zh-CN">${esc(k[0])}</span> ${esc(k[2])}</button>`).join("")}</div>` : ""}
        <div class="label">自分で言えましたか？</div>
        <div class="grades">
          <button class="btn g0" data-act="grade" data-g="0">言えなかった</button>
          <button class="btn g1" data-act="grade" data-g="1">あやしい</button>
          <button class="btn g2 ${sc && sc.pct >= 85 ? "suggest" : ""}" data-act="grade" data-g="2">言えた</button>
        </div>`;
    },
    actSpeak(a, el) {
      const t = this.run[this.i];
      if (a === "unhide") { const x = this.log[this.log.length - 1]; if (x) x.hide = false; return this.render(); }
      if (a === "toggle") { const b = el.closest(".msg").querySelector(el.getAttribute("data-t") === "py" ? ".py" : ".ja"); if (b) b.hidden = !b.hidden; const n = el.closest(".msg").querySelector(".note"); if (n && el.getAttribute("data-t") === "ja") n.hidden = b.hidden; return; }
      if (a === "pick") { this.pickI = +el.getAttribute("data-n"); this.phase = settings.style === "challenge" ? "say" : "reveal"; if (this.phase === "reveal") play(t.r[this.pickI][0]); return this.render(); }
      if (a === "reveal") { if (Mic.live) Mic.stop(); this.phase = "reveal"; play(t.r[this.pickI][0]); return this.render(); }
      if (a === "mic") return this.mic();
      if (a === "grade") {
        if (Mic.live) Mic.stop();
        const g = +el.getAttribute("data-g"), r = t.r[this.pickI];
        grade("s:" + r[0], g);
        (t.k || []).filter((k) => containsWord(r[0], k[0])).forEach((k) => { if (WORD_BY.has(k[0]) && !prog["w:" + k[0]]) grade("w:" + k[0], 1); });
        this.results.push({ line: r, g, k: t.k });
        this.log.push({ who: "me", line: r, k: t.k });
        this.i++;
        if (this.i < this.run.length) return this.enterTurn();
        this.phase = "end"; return this.render();
      }
      if (a === "again") { return this.act("mode", { getAttribute: () => "speak" }); }
    },
    mic() {
      if (Mic.live) { Mic.stop(); return; }
      const target = this.run[this.i].r[this.pickI][0];
      this.micMsg = ""; this.said = "";
      Mic.start(({ text, ended, reason }) => {
        this.said = text;
        if (ended) {
          if (text) { this.score = compare(text, target); this.phase = "reveal"; this.micMsg = ""; }
          else this.micMsg = micError(reason);
          this.render();
        } else { const h = document.getElementById("heard"); if (h) h.innerHTML = text ? `聞き取り：<b lang="zh-CN">${esc(text)}</b>` : "聞いています…"; }
      });
      this.render();
    },
    endHtml() {
      const ok = this.results.filter((x) => x.g === 2).length;
      const ks = []; this.results.forEach((x) => (x.k || []).forEach((k) => { if (!ks.some((y) => y[0] === k[0])) ks.push(k); }));
      return `<section class="end">
        <h2>おつかれさまでした</h2>
        <p class="muted">${this.results.length}文のうち、言えたのは ${ok}文。言えなかった・あやしかった文は、間をあけて復習に出てきます。</p>
        <ul class="plist">${this.results.map((x) => `<li><span class="gdot g${x.g}" aria-label="${["言えなかった", "あやしい", "言えた"][x.g]}"></span><span class="zh" lang="zh-CN">${highlight(x.line[0], x.k)}</span><span class="ja">${esc(x.line[2])}</span><span class="acts">${playBtn(x.line[0], "聞く", "icon-btn")}</span></li>`).join("")}</ul>
        ${ks.length ? `<div class="eyebrow">この会話に出てきた単語・つなぎ言葉</div><div class="kchips">${ks.map((k) => `<button class="kchip" data-kw="${esc(k[0])}"><span lang="zh-CN">${esc(k[0])}</span> ${esc(k[2])}</button>`).join("")}</div>` : ""}
        <div class="stack">
          <button class="btn primary" data-act="again">もう一度（流れが変わります）</button>
          <a class="btn" href="#ai" data-ai-scene="${esc(this.s.id)}">AIとこの場面の続きを話す</a>
          <a class="btn ghost" href="#home">場面一覧へ</a>
        </div></section>`;
    },
    /* ----- listening ----- */
    renderListen() {
      const done = this.phase === "end";
      if (done) {
        const ok = this.results.filter((x) => x.g === 2).length;
        view.innerHTML = `${this.header("おわり", 1)}<section class="end"><h2>聞き取り ${ok} / ${this.results.length}</h2>
          <p class="muted">まちがえた文は、間をあけて復習に出てきます。</p>
          <ul class="plist">${this.results.map((x) => `<li><span class="gdot g${x.g}"></span><span class="zh" lang="zh-CN">${esc(x.line[0])}</span><span class="py">${esc(x.line[1])}</span><span class="ja">${esc(x.line[2])}</span><span class="acts">${playBtn(x.line[0], "聞く", "icon-btn")}</span></li>`).join("")}</ul>
          <div class="stack"><button class="btn primary" data-act="again">もう一度（流れが変わります）</button><a class="btn ghost" href="#home">場面一覧へ</a></div></section>`;
        return;
      }
      const t = this.run[this.i];
      if (!this.choices) this.choices = this.makeChoices(t.p);
      const ans = this.answered;
      view.innerHTML = `${this.header(this.stepText(), this.i / this.run.length)}
        <section class="listen">
          <div class="big-play"><button class="play-xl" data-play="${esc(t.p[0])}" aria-label="もう一度聞く">${I.play}</button>
            <button class="chip" data-play="${esc(t.p[0])}" data-slow>${I.slow}ゆっくり</button></div>
          <div class="label center">相手は何と言った？</div>
          <div class="options">${this.choices.map((c, n) => `<button class="option ${ans != null ? (c.ok ? "right" : n === ans ? "wrong" : "") : ""}" data-act="answer" data-n="${n}" ${ans != null ? "disabled" : ""}>${esc(c.ja)}</button>`).join("")}</div>
          ${ans != null ? `<div class="answer"><div class="zh" lang="zh-CN">${highlight(t.p[0], t.k)}</div><div class="py">${esc(t.p[1])}</div><div class="small">${esc(t.p[2])}</div></div>
            <button class="btn primary" data-act="lnext">${this.i + 1 < this.run.length ? "次へ" : "結果を見る"}</button>` : `<button class="btn ghost" data-act="answer" data-n="-1">わからない（答えを見る）</button>`}
        </section>`;
    },
    makeChoices(p) {
      const pool = shuffle(sceneLines(this.s).p.filter((l) => l[0] !== p[0] && l[2] !== p[2]));
      const others = pool.length >= 2 ? pool : pool.concat(shuffle(SCENES.flatMap((s) => sceneLines(s).p)).filter((l) => l[0] !== p[0]));
      return shuffle([{ ja: p[2], ok: true }, { ja: others[0][2] }, { ja: others[1][2] }]);
    },
    actListen(a, el) {
      const t = this.run[this.i];
      if (a === "answer") {
        if (this.answered != null) return;
        const n = +el.getAttribute("data-n"); const ok = n >= 0 && this.choices[n].ok;
        this.answered = n; grade("l:" + t.p[0], ok ? 2 : 0); this.results.push({ line: t.p, g: ok ? 2 : 0 });
        if (!ok) play(t.p[0]);
        return this.renderListen();
      }
      if (a === "lnext") { this.i++; this.choices = null; this.answered = null; if (this.i < this.run.length) return this.enterTurn(); this.phase = "end"; return this.renderListen(); }
      if (a === "again") return this.act("mode", { getAttribute: () => "listen" });
    }
  };

  /* =============== SHADOWING =============== */
  const Shadow = {
    start(sc) {
      this.sc = sc; this.list = []; this.cur = -1; this.playing = false; this.show = settings.pinyin ? "all" : "zh";
      sc.run.forEach((t) => { this.list.push({ who: "p", line: t.p, k: t.k }); if (t.r[0]) this.list.push({ who: "me", line: pick(t.r), k: t.k }); });
      ctrl = this; this.render();
    },
    render() {
      const sc = this.sc;
      view.innerHTML = `${sc.header(this.cur >= 0 ? `${this.cur + 1} / ${this.list.length} 文` : `${this.list.length} 文`, this.cur < 0 ? 0 : (this.cur + 1) / this.list.length)}
        <p class="small muted" style="margin:12px 0 0">音声のすぐ後に、同じように声に出してください。1文ごとに言うための間があきます。</p>
        <div class="seg sm" role="group" aria-label="文字の表示"><button data-act="show" data-v="all" aria-pressed="${this.show === "all"}">全部</button><button data-act="show" data-v="zh" aria-pressed="${this.show === "zh"}">漢字だけ</button><button data-act="show" data-v="none" aria-pressed="${this.show === "none"}">文字なし</button></div>
        <ol class="shadow-list">${this.list.map((x, n) => `<li class="${n === this.cur ? "cur" : ""} ${x.who}" data-act="jump" data-n="${n}">
          <span class="who-tag">${x.who === "p" ? "相手" : "あなた"}</span>
          <span class="zh" lang="zh-CN" ${this.show === "none" ? "hidden" : ""}>${highlight(x.line[0], x.k)}</span>
          <span class="py" ${this.show === "all" ? "" : "hidden"}>${esc(x.line[1])}</span>
          <span class="ja" ${this.show === "all" ? "" : "hidden"}>${esc(x.line[2])}</span></li>`).join("")}</ol>
        <div class="tray"><div class="row">
          <button class="btn primary wide" data-act="toggleplay">${this.playing ? I.pause + "一時停止" : I.go + (this.cur >= 0 ? "続きから" : "はじめる")}</button>
          <button class="btn" data-act="restart">最初から</button></div></div>`;
      const cur = view.querySelector(".shadow-list .cur"); if (cur) cur.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    async loop() {
      const token = ++this.loopToken;
      while (this.playing && token === this.loopToken) {
        this.cur++;
        if (this.cur >= this.list.length) { this.playing = false; this.cur = this.list.length - 1; this.render(); toast("シャドーイングが終わりました。"); return; }
        this.render();
        const zh = this.list[this.cur].line[0];
        const t0 = now();
        await play(zh);
        if (!this.playing || token !== this.loopToken) return;
        const gap = Math.max(1200, (now() - t0) * 1.1 + 400); // time to repeat it yourself
        await new Promise((r) => setTimeout(r, gap));
      }
    },
    loopToken: 0,
    act(a, el) {
      if (a === "speed") return Scene.act(a, el);
      if (a === "show") { this.show = el.getAttribute("data-v"); return this.render(); }
      if (a === "toggleplay") { this.playing = !this.playing; if (this.playing) { if (this.cur >= this.list.length - 1) this.cur = -1; else this.cur = Math.max(-1, this.cur - 1); this.loop(); } else { stopAudio(); this.loopToken++; this.render(); } return; }
      if (a === "restart") { stopAudio(); this.loopToken++; this.cur = -1; this.playing = true; this.loop(); return; }
      if (a === "jump") { stopAudio(); this.loopToken++; this.cur = +el.getAttribute("data-n") - 1; this.playing = true; this.loop(); }
    }
  };

  /* =============== REVIEW =============== */
  const Review = {
    open() {
      this.items = dueItems().slice(0, 15).map((key) => {
        const kind = key[0], val = key.slice(2);
        if (kind === "w") { const w = WORD_BY.get(val); return w ? { key, kind, w } : null; }
        const L = LINE_INDEX.get(val); return L ? { key, kind, line: L.line, scene: L.scene, k: kOf(val) } : null;
      }).filter(Boolean);
      this.i = 0; this.phase = "q"; this.done = []; this.choices = null;
      this.render();
    },
    render() {
      if (!this.items.length) { view.innerHTML = `<header class="focus-head"><a class="quit" href="#home">${I.close}<span>やめる</span></a><div class="title"><h1>復習</h1></div><span></span></header><div class="empty">いま復習するものはありません。</div>`; return; }
      if (this.i >= this.items.length) {
        const ok = this.done.filter((g) => g === 2).length;
        view.innerHTML = `<header class="focus-head"><a class="quit" href="#home">${I.close}<span>閉じる</span></a><div class="title"><h1>復習</h1><div class="step">おわり</div></div><span></span></header>
          <section class="end"><h2>${this.items.length}件のうち ${ok}件できました</h2><p class="muted">できたものは、次はもっと間をあけて出てきます。</p><a class="btn primary" href="#home">ホームへ</a></section>`;
        return;
      }
      const it = this.items[this.i];
      const head = `<header class="focus-head"><a class="quit" href="#home">${I.close}<span>やめる</span></a><div class="title"><h1>復習</h1><div class="step">${this.i + 1} / ${this.items.length}</div></div><span></span></header><div class="progress"><i style="width:${(this.i / this.items.length) * 100}%"></i></div>`;
      let body = "";
      if (it.kind === "l") {
        if (!this.choices) { Scene.s = it.scene; this.choices = Scene.makeChoices(it.line); }
        const ans = this.ans;
        body = `<section class="listen"><div class="eyebrow center">聞き取り ・ ${esc(it.scene.title)}</div>
          <div class="big-play"><button class="play-xl" data-play="${esc(it.line[0])}" aria-label="聞く">${I.play}</button><button class="chip" data-play="${esc(it.line[0])}" data-slow>${I.slow}ゆっくり</button></div>
          <div class="options">${this.choices.map((c, n) => `<button class="option ${ans != null ? (c.ok ? "right" : n === ans ? "wrong" : "") : ""}" data-act="lans" data-n="${n}" ${ans != null ? "disabled" : ""}>${esc(c.ja)}</button>`).join("")}</div>
          ${ans != null ? `<div class="answer"><div class="zh" lang="zh-CN">${highlight(it.line[0], it.k)}</div><div class="py">${esc(it.line[1])}</div></div><button class="btn primary" data-act="next">次へ</button>` : ""}</section>`;
      } else {
        const zh = it.kind === "w" ? it.w.w : it.line[0], py = it.kind === "w" ? it.w.py : it.line[1], ja = it.kind === "w" ? it.w.ja : it.line[2];
        body = `<section class="card-q"><div class="eyebrow">${it.kind === "w" ? esc(kindShort(it.w.kind)) : "フレーズ ・ " + esc(it.scene.title)}</div>
          <div class="q-ja">${esc(ja)}</div>
          ${it.kind === "w" && it.w.ex && it.w.ex[0] ? `<div class="small muted">例：${esc(it.w.ex[0][2])}</div>` : ""}
          ${this.phase === "a" ? `<div class="answer"><div class="zh" lang="zh-CN">${it.kind === "w" ? esc(zh) : highlight(zh, it.k)}</div><div class="py">${esc(py)}</div>
            ${it.kind === "w" && it.w.ex && it.w.ex[0] ? `<div class="ex"><span lang="zh-CN">${highlight(it.w.ex[0][0], [it.w.w])}</span> ${playBtn(it.w.ex[0][0])}</div>` : ""}
            <div class="row">${playBtn(it.kind === "w" ? wordAudioKey(zh) : zh, "お手本")}</div></div>
            <div class="grades"><button class="btn g0" data-act="g" data-g="0">言えなかった</button><button class="btn g1" data-act="g" data-g="1">あやしい</button><button class="btn g2" data-act="g" data-g="2">言えた</button></div>`
          : `<div class="small muted">中国語で言ってから、答えを見てください。</div><button class="btn primary" data-act="show">${I.eye}答えを見る</button>`}</section>`;
      }
      view.innerHTML = head + body;
    },
    act(a, el) {
      const it = this.items[this.i];
      if (a === "show") { this.phase = "a"; play(it.kind === "w" ? wordAudioKey(it.w.w) : it.line[0]); return this.render(); }
      if (a === "g") { const g = +el.getAttribute("data-g"); grade(it.key, g); this.done.push(g); return this.next(); }
      if (a === "lans") { const n = +el.getAttribute("data-n"); this.ans = n; const ok = this.choices[n].ok; grade(it.key, ok ? 2 : 0); this.done.push(ok ? 2 : 0); return this.render(); }
      if (a === "next") return this.next();
    },
    next() { this.i++; this.phase = "q"; this.choices = null; this.ans = null; this.render(); const it = this.items[this.i]; if (it && it.kind === "l") play(it.line[0]); }
  };

  /* =============== WORDS =============== */
  let wFilter = store.get("wFilter", { kind: "all", hsk: "all" });
  const filteredWords = () => WORDS.filter((w) => (wFilter.kind === "all" || w.kind === wFilter.kind) && (wFilter.hsk === "all" || String(w.hsk || "x") === wFilter.hsk));
  const Words = {
    render() {
      if (!WORDS.length) { view.innerHTML = `<h1 class="page-h">単語</h1><div class="empty">単語・つなぎ言葉のデータは、いま作っている新しい台本と一緒に追加されます。</div>`; return; }
      const list = filteredWords();
      const levels = [...new Set(WORDS.map((w) => String(w.hsk || "x")))].sort();
      const t = [0, 0, 0, 0]; list.forEach((w) => t[tier("w:" + w.w)]++);
      view.innerHTML = `<h1 class="page-h">単語・つなぎ言葉</h1>
        <p class="small muted lead-p">会話に出てくる語だけを集めています。タップすると、会話の中での使われ方が見られます。</p>
        <div class="filters" aria-label="種類">${["all", ...KINDS].map((k) => `<button class="chip ${wFilter.kind === k ? "on" : ""}" data-act="fk" data-v="${esc(k)}">${k === "all" ? "すべて" : esc(k)}</button>`).join("")}</div>
        <div class="filters" aria-label="レベル">${["all", ...levels].map((h) => `<button class="chip ${wFilter.hsk === h ? "on" : ""}" data-act="fh" data-v="${h}">${h === "all" ? "全レベル" : h === "x" ? "その他" : "HSK" + h}</button>`).join("")}</div>
        <div class="wq-start">
          <div><b>${list.length}語</b><span class="small muted">　言える ${t[2] + t[3]} ・ 練習中 ${t[1]} ・ まだ ${t[0]}</span></div>
          <a class="btn primary" href="#wq">この中から10語練習する</a>
        </div>
        <ul class="wlist">${list.map((w) => `<li><button data-kw="${esc(w.w)}">
          <span class="tdot t${tier("w:" + w.w)}" aria-label="${TIER_NAME[tier("w:" + w.w)]}"></span>
          <span class="w" lang="zh-CN">${esc(w.w)}</span><span class="py">${esc(w.py)}</span>
          <span class="ja">${esc(w.ja)}</span><span class="kind">${esc(kindShort(w.kind))}${w.hsk ? " ・ " + w.hsk + "級" : ""}</span></button></li>`).join("")}</ul>`;
    },
    act(a, el) {
      if (a === "fk") wFilter.kind = el.getAttribute("data-v");
      if (a === "fh") wFilter.hsk = el.getAttribute("data-v");
      store.set("wFilter", wFilter); this.render();
    }
  };

  const WordQuiz = {
    open() {
      const list = filteredWords();
      const score = (w) => { const st = prog["w:" + w.w]; if (!st) return 1; if (st.due <= now()) return 0; return 2 + st.b; };
      this.items = shuffle(list).sort((a, b) => score(a) - score(b)).slice(0, 10);
      this.i = 0; this.res = []; this.prepare(); this.render();
    },
    prepare() {
      const w = this.items[this.i]; if (!w) return;
      const types = [];
      if (w.ex && w.ex.length && wordParts(w.w).length === 1) types.push("cloze");
      if (hasAudio(wordAudioKey(w.w)) || hasAudio((w.ex && w.ex[0] && w.ex[0][0]) || "")) types.push("ear");
      types.push("say");
      this.type = types[this.i % types.length];
      this.ans = null; this.shown = false;
      const sameKind = shuffle(WORDS.filter((x) => x.w !== w.w && x.kind === w.kind && wordParts(x.w).length === 1));
      const anyKind = shuffle(WORDS.filter((x) => x.w !== w.w));
      const others = sameKind.concat(anyKind).filter((x, n, a) => a.indexOf(x) === n);
      if (this.type === "cloze") { this.ex = pick(w.ex); this.choices = shuffle([w, ...others.filter((x) => !this.ex[0].includes(x.w)).slice(0, 2)]); }
      if (this.type === "ear") this.choices = shuffle([w, ...others.filter((x) => x.ja !== w.ja).slice(0, 2)]);
    },
    head() {
      return `<header class="focus-head"><a class="quit" href="#words">${I.close}<span>やめる</span></a><div class="title"><h1>単語の練習</h1><div class="step">${Math.min(this.i + 1, this.items.length)} / ${this.items.length}</div></div><span></span></header><div class="progress"><i style="width:${(this.i / Math.max(1, this.items.length)) * 100}%"></i></div>`;
    },
    render() {
      if (!this.items.length) { view.innerHTML = `${this.head()}<div class="empty">練習できる単語がありません。</div>`; return; }
      if (this.i >= this.items.length) {
        view.innerHTML = `${this.head()}<section class="end"><h2>${this.items.length}語のうち ${this.res.filter((g) => g === 2).length}語できました</h2>
          <ul class="plist">${this.items.map((w, n) => `<li><span class="gdot g${this.res[n]}"></span><span class="zh" lang="zh-CN">${esc(w.w)}</span><span class="ja">${esc(w.ja)}</span><span class="acts">${playBtn(wordAudioKey(w.w), "聞く", "icon-btn")}</span></li>`).join("")}</ul>
          <div class="stack"><a class="btn primary" href="#wq" data-act="restart">もう10語</a><a class="btn ghost" href="#words">単語一覧へ</a></div></section>`;
        return;
      }
      const w = this.items[this.i], ans = this.ans;
      const after = (extra) => `<div class="answer"><div class="zh" lang="zh-CN">${esc(w.w)}　<span class="py">${esc(w.py)}</span></div><div class="small">${esc(w.ja)}</div>
          ${(w.ex || [])[0] ? `<div class="ex"><span lang="zh-CN">${highlight((this.ex || w.ex[0])[0], [w.w])}</span><br><span class="small muted">${esc((this.ex || w.ex[0])[2])}</span> ${playBtn((this.ex || w.ex[0])[0])}</div>` : ""}${extra || ""}</div>`;
      let body = "";
      if (this.type === "cloze") {
        const parts = this.ex[0].split(w.w);
        body = `<div class="eyebrow">空いているところに入る語は？</div>
          <div class="cloze" lang="zh-CN">${esc(parts[0])}<span class="blank">${ans != null ? esc(w.w) : "＿＿"}</span>${esc(parts.slice(1).join(w.w))}</div>
          <div class="small muted">${esc(this.ex[2])}</div>
          <div class="options cols">${this.choices.map((c, n) => `<button class="option ${ans != null ? (c === w ? "right" : n === ans ? "wrong" : "") : ""}" data-act="ans" data-n="${n}" ${ans != null ? "disabled" : ""}><span class="zh" lang="zh-CN">${esc(c.w)}</span></button>`).join("")}</div>
          ${ans != null ? after() + `<button class="btn primary" data-act="next">次へ</button>` : ""}`;
      } else if (this.type === "ear") {
        const src = hasAudio(wordAudioKey(w.w)) ? wordAudioKey(w.w) : w.ex[0][0];
        body = `<div class="eyebrow">聞こえた語の意味は？</div>
          <div class="big-play"><button class="play-xl" data-play="${esc(src)}" aria-label="聞く">${I.play}</button></div>
          ${src !== wordAudioKey(w.w) ? `<div class="small muted center">文の中の「${esc(w.py)}」の意味を選んでください。</div>` : ""}
          <div class="options">${this.choices.map((c, n) => `<button class="option ${ans != null ? (c === w ? "right" : n === ans ? "wrong" : "") : ""}" data-act="ans" data-n="${n}" ${ans != null ? "disabled" : ""}>${esc(c.ja)}</button>`).join("")}</div>
          ${ans != null ? after() + `<button class="btn primary" data-act="next">次へ</button>` : ""}`;
      } else {
        body = `<div class="eyebrow">中国語で言ってみましょう</div><div class="q-ja">${esc(w.ja)}</div>
          ${(w.ex || [])[0] ? `<div class="small muted">使う場面：${esc(w.ex[0][2])}</div>` : ""}
          ${this.shown ? after() + `<div class="grades"><button class="btn g0" data-act="g" data-g="0">言えなかった</button><button class="btn g1" data-act="g" data-g="1">あやしい</button><button class="btn g2" data-act="g" data-g="2">言えた</button></div>`
            : `<button class="btn primary" data-act="show">${I.eye}答えを見る</button>`}`;
      }
      view.innerHTML = `${this.head()}<section class="card-q">${body}</section>`;
    },
    act(a, el) {
      const w = this.items[this.i];
      if (a === "restart") { this.open(); return; }
      if (a === "ans") { const n = +el.getAttribute("data-n"); this.ans = n; const ok = this.choices[n] === w; grade("w:" + w.w, ok ? 2 : 0); this.res[this.i] = ok ? 2 : 0; play(this.type === "cloze" ? this.ex[0] : wordAudioKey(w.w)); return this.render(); }
      if (a === "show") { this.shown = true; play(wordAudioKey(w.w)); return this.render(); }
      if (a === "g") { const g = +el.getAttribute("data-g"); grade("w:" + w.w, g); this.res[this.i] = g; return this.next(); }
      if (a === "next") return this.next();
    },
    next() { this.i++; this.prepare(); this.render(); const w = this.items[this.i]; if (w && this.type === "ear") play(hasAudio(wordAudioKey(w.w)) ? wordAudioKey(w.w) : w.ex[0][0]); }
  };

  /* =============== STATS (実力) =============== */
  const Stats = {
    render() {
      const allR = [], allP = [];
      SCENES.forEach((s) => { const L = sceneLines(s); allR.push(...L.r); allP.push(...L.p); });
      const cnt = (keys) => { const t = [0, 0, 0, 0]; keys.forEach((k) => t[tier(k)]++); return t; };
      const say = cnt(allR.map((l) => "s:" + l[0])), hear = cnt(allP.filter((l) => prog["l:" + l[0]]).map((l) => "l:" + l[0]));
      const heardOk = allP.filter((l) => tier("l:" + l[0]) >= 2).length, heardTried = allP.filter((l) => prog["l:" + l[0]]).length;
      const wd = cnt(WORDS.map((w) => "w:" + w.w));
      const bar = (t, total) => `<span class="sbar">${[3, 2, 1].map((x) => `<i class="t${x}" style="width:${(t[x] / Math.max(1, total)) * 100}%"></i>`).join("")}</span>`;
      const levels = [...new Set(WORDS.map((w) => w.hsk || "x"))].sort();
      view.innerHTML = `<h1 class="page-h">実力</h1>
        <p class="small muted lead-p">「言える」は最後の練習で言えた（聞き取れた）もの、「定着」は日をあけて3回以上続けて言えたものです。</p>
        <div class="kpis">
          <div><b>${say[2] + say[3]}</b><span>言えるフレーズ<br><span class="muted">全${allR.length}文</span></span></div>
          <div><b>${heardOk}</b><span>聞き取れた文<br><span class="muted">${heardTried}文を練習</span></span></div>
          <div><b>${wd[2] + wd[3]}</b><span>言える単語<br><span class="muted">全${WORDS.length}語</span></span></div>
        </div>
        <div class="legend"><span><i class="t3"></i>定着</span><span><i class="t2"></i>言える</span><span><i class="t1"></i>練習中</span><span><i class="t0"></i>まだ</span></div>
        ${WORDS.length ? `<h2 class="sec-h">単語（HSKの級ごと）</h2>
        <ul class="stat-rows">${levels.map((h) => { const ws = WORDS.filter((w) => (w.hsk || "x") === h); const t = cnt(ws.map((w) => "w:" + w.w)); return `<li><span class="lbl">${h === "x" ? "その他" : "HSK" + h}</span>${bar(t, ws.length)}<span class="n">${t[2] + t[3]}/${ws.length}</span></li>`; }).join("")}</ul>` : ""}
        <h2 class="sec-h">場面ごとの言えるフレーズ</h2>
        <ul class="stat-rows">${SCENES.map((s) => { const L = sceneLines(s).r; const t = cnt(L.map((l) => "s:" + l[0])); return `<li><a href="#scene-${s.id}" class="lbl"><span class="mark xs" lang="zh-CN">${esc(s.mark)}</span>${esc(s.title)}</a>${bar(t, L.length)}<span class="n">${t[2] + t[3]}/${L.length}</span></li>`; }).join("")}</ul>
        ${hear[0] + hear[1] + hear[2] + hear[3] ? "" : `<p class="small muted">聞き取りの記録は、場面の「聞き取り」で練習すると出てきます。</p>`}`;
    }
  };

  /* =============== AI free talk =============== */
  const AI = {
    sample: undefined, sceneId: store.get("aiScene", "free"), pendingScene: null,
    msgs: [], turns: [], hints: [], busy: false, err: "", draft: "",
    sceneDesc() {
      if (this.sceneId === "free") return "上海の夜、友達の友達との気楽な飲み会。話題は自由（仕事、趣味、上海の生活、食べ物など）。";
      const s = SCENES.find((x) => x.id === this.sceneId);
      return s ? `${s.title}（${s.where}）。あなたの役：${s.partner}。${s.intro}` : "上海の夜の飲み会。";
    },
    instructions() {
      return [
        "あなたは中国語会話の練習相手です。上海に住む中国人として、場面の中の人物を演じてください。",
        "学習者：日本人、学習歴7か月（HSK2〜3級）、上海在住、仕事はガス安全関連のソフトウェア。目標はHSK4級の範囲で、会食や飲み会など夜の場面の世間話をすらすら話し、聞き取れるようになること。",
        "場面：" + this.sceneDesc(),
        "ルール：",
        "- 毎回、自然な話し言葉の中国語（簡体字）で1〜2文だけ返す。語彙はHSK4級まで。難しい言い回しや成語は使わない。",
        "- 毎回、質問や話題を投げて会話を続ける。説教や長い説明はしない。",
        "- 学習者が日本語やピンインで書いたら、意図をくみ取って会話を続け、fix に中国語での言い方を示す。",
        "- 学習者の中国語に誤りや不自然な点があれば、fix に直した文と日本語の短い説明。自然なら fix は null。",
        "- hints には、学習者が次に言えそうな短い返答例を2つ（HSK4級まで）。",
        "出力は次の形のJSONだけ：",
        '{"reply":{"zh":"中国語","py":"声調記号付きピンイン","ja":"自然な日本語訳"},"fix":null または {"zh":"直した中国語","py":"ピンイン","why":"日本語で1文"},"hints":[{"zh":"","py":"","ja":""},{"zh":"","py":"","ja":""}]}'
      ].join("\n");
    },
    reset() { this.msgs = [{ role: "user", content: this.instructions() + "\n\n場面に合わせて、あなたから最初のひとことで話しかけてください。" }]; this.turns = []; this.hints = []; this.err = ""; },
    async ask() {
      if (!this.sample || this.busy) return;
      this.busy = true; this.err = ""; this.render();
      try {
        const res = await this.sample.json(this.msgs, { cache: false });
        if (!res || !res.reply || !res.reply.zh) throw { code: "invalid_json" };
        this.msgs.push({ role: "assistant", content: JSON.stringify({ reply: res.reply }) });
        const lastMe = [...this.turns].reverse().find((x) => x.who === "me");
        if (lastMe && res.fix && res.fix.zh) lastMe.fix = res.fix;
        this.turns.push({ who: "ai", d: res.reply });
        this.hints = Array.isArray(res.hints) ? res.hints.filter((h) => h && h.zh).slice(0, 3) : [];
        play(res.reply.zh);
      } catch (e) {
        const code = e && e.code;
        this.err = code === "not_granted" ? "Claudeへの問い合わせが許可されていません。ページの権限設定から許可するとAI会話が使えます。" : code === "rate_limited" ? "混み合っています。少し待ってからもう一度送ってください。" : "返事を受け取れませんでした。もう一度送ってください。";
        if (code === "not_granted") this.sample = null;
      }
      this.busy = false; this.render();
    },
    send(text) {
      text = (text || "").trim();
      if (!text || this.busy) return;
      this.turns.push({ who: "me", text }); this.msgs.push({ role: "user", content: text });
      if (this.msgs.length > 25) this.msgs = [this.msgs[0]].concat(this.msgs.slice(-24));
      this.draft = ""; this.ask();
    },
    render() {
      if (location.hash !== "#ai") return;
      if (this.pendingScene) { this.sceneId = this.pendingScene; this.pendingScene = null; store.set("aiScene", this.sceneId); this.reset(); }
      const off = this.sample === null, checking = this.sample === undefined;
      view.innerHTML = `<h1 class="page-h">AIと自由に話す</h1>
        <p class="small muted lead-p">台本なしの会話です。中国語で返してみて、言えないところは日本語でもOK。</p>
        <div class="row nowrap"><label class="field grow" for="ai-scene">場面
          <select id="ai-scene"><option value="free" ${this.sceneId === "free" ? "selected" : ""}>自由な雑談（飲み会）</option>
          ${SCENES.map((s) => `<option value="${s.id}" ${this.sceneId === s.id ? "selected" : ""}>${esc(s.mark)}　${esc(s.title)}</option>`).join("")}</select></label>
          <button class="btn" data-act="restart" style="align-self:flex-end" ${off || checking ? "disabled" : ""}>${this.turns.length ? "最初から" : "始める"}</button></div>
        ${off ? `<div class="notice">AI会話は、このアプリをClaudeのページとして開いたときだけ使えます。</div>` : ""}
        ${checking ? `<div class="small muted">AI会話が使えるか確認しています…</div>` : ""}
        <div class="log">${this.turns.map((x) => x.who === "ai" ? this.aiHtml(x.d) : this.meHtml(x)).join("")}
          ${this.busy ? `<div class="msg p"><div class="bubble typing">考えています…</div></div>` : ""}${this.err ? `<div class="err">${esc(this.err)}</div>` : ""}</div>
        ${!off && !checking && this.turns.length ? `<div class="tray">
          ${this.hints.length ? `<div class="hints">${this.hints.map((h, n) => `<button data-act="hint" data-n="${n}"><span class="zh" lang="zh-CN">${esc(h.zh)}</span><span class="ja">${esc(h.ja || "")}</span></button>`).join("")}</div>` : ""}
          <div class="small muted" id="ai-heard"></div>
          <div class="composer">${Mic.available() ? `<button class="icon-btn mic ${Mic.live ? "live" : ""}" data-act="mic" aria-label="話して入力">${I.mic}</button>` : "<span></span>"}
            <textarea id="ai-input" rows="1" lang="zh-CN" placeholder="中国語で返事（日本語でもOK）">${esc(this.draft)}</textarea>
            <button class="icon-btn send" data-act="send" aria-label="送信">${I.send}</button></div></div>` : ""}`;
      const sel = document.getElementById("ai-scene");
      if (sel) sel.onchange = () => { this.sceneId = sel.value; store.set("aiScene", this.sceneId); this.reset(); this.render(); };
      const input = document.getElementById("ai-input");
      if (input) {
        input.oninput = () => { this.draft = input.value; input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
        input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(input.value); } };
      }
      if (this.turns.length) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
    },
    aiHtml(d) {
      return `<div class="msg p"><div class="bubble"><div class="zh" lang="zh-CN">${esc(d.zh)}</div>
        <div class="py" ${settings.pinyin ? "" : "hidden"}>${esc(d.py || "")}</div><div class="ja" ${settings.ja ? "" : "hidden"}>${esc(d.ja || "")}</div></div>
        <div class="tools">${playBtn(d.zh)}<button class="chip" data-act="toggle" data-t="py">ピンイン</button><button class="chip" data-act="toggle" data-t="ja">訳</button></div></div>`;
    },
    meHtml(x) {
      return `<div class="msg me"><div class="bubble"><div class="zh mine" lang="zh-CN">${esc(x.text)}</div>
        ${x.fix ? `<div class="fix"><span class="lbl">こう言うと自然</span><span class="zh" lang="zh-CN">${esc(x.fix.zh)}</span><span class="small muted">${esc(x.fix.py || "")}</span><span class="small">${esc(x.fix.why || "")}</span><span class="row">${playBtn(x.fix.zh)}</span></div>` : ""}</div></div>`;
    },
    act(a, el) {
      const input = document.getElementById("ai-input");
      if (a === "restart") { this.reset(); this.ask(); }
      else if (a === "send") this.send(input && input.value);
      else if (a === "hint") { const h = this.hints[+el.getAttribute("data-n")]; if (h && input) { input.value = h.zh; this.draft = h.zh; input.focus(); play(h.zh); } }
      else if (a === "toggle") { const b = el.closest(".msg").querySelector(el.getAttribute("data-t") === "py" ? ".py" : ".ja"); if (b) b.hidden = !b.hidden; }
      else if (a === "mic") {
        if (Mic.live) { Mic.stop(); return; }
        const base = input ? input.value : ""; el.classList.add("live");
        Mic.start(({ text, ended, reason }) => {
          if (input) { input.value = (base + text).trim(); this.draft = input.value; }
          const hd = document.getElementById("ai-heard");
          if (ended) { el.classList.remove("live"); if (hd) hd.textContent = text ? "" : micError(reason); }
          else if (hd) hd.textContent = "聞いています…（話し終えたらマイクをもう一度タップ）";
        });
      }
    }
  };
  view.addEventListener("click", (e) => { const a = e.target.closest("[data-ai-scene]"); if (a) AI.pendingScene = a.getAttribute("data-ai-scene"); }, true);

  /* =============== SETTINGS =============== */
  const Prefs = {
    render() {
      const seg = (key, opts) => `<span class="c seg">${opts.map(([v, l]) => `<button data-act="set" data-k="${key}" data-v="${v}" aria-pressed="${String(settings[key]) === String(v)}">${l}</button>`).join("")}</span>`;
      view.innerHTML = `<h1 class="page-h">設定</h1>
        <div class="prefs">
          <div class="pref"><span>話す練習のしかた</span><span class="d">日本語を見て自分で中国語にするか、中国語を見て読むか。</span>${seg("style", [["challenge", "日本語→中国語"], ["read", "中国語を読む"]])}</div>
          <div class="pref"><span>相手のセリフの文字</span><span class="d">「聞いてから」にすると、音声が終わるまで文字を隠します。</span>${seg("subs", [["show", "すぐ表示"], ["after", "聞いてから"]])}</div>
          <div class="pref"><span>ピンイン</span><span class="d">オフにすると、漢字と音だけで練習できます。</span>${seg("pinyin", [["true", "表示"], ["false", "隠す"]])}</div>
          <div class="pref"><span>相手のセリフの訳</span><span class="d">隠していても、吹き出しの「訳」でいつでも見られます。</span>${seg("ja", [["true", "表示"], ["false", "隠す"]])}</div>
          <div class="pref"><span>再生の速さ</span><span class="d">練習中も画面右上の「速度」で切り替えられます。</span>${seg("rate", [["0.75", "ゆっくり"], ["1", "ふつう"], ["1.25", "速め"]])}</div>
        </div>
        <div class="about">
          <div><b>音声</b>：場面・単語の文は、すべて録音済みの中国語音声で再生します（相手は男性、あなたの文と単語は女性の声）。AIの返事は${claudeTts ? "Claudeの音声" : zhVoice ? "端末の中国語音声（" + esc(zhVoice.name) + "）" : "端末に中国語の音声がないため文字だけ"}になります。</div>
          <div><b>マイク</b>：${Mic.available() ? "使えます。初回は許可を求められます。" : "この端末・画面では使えません。声に出してから「答えを見る」で確認してください。"}</div>
          <div><b>記録</b>：練習の記録はこの端末のブラウザに保存されます。</div>
          <div class="row">${playBtn("今天真的很开心，下次我们再约！", "音声を試す")}<button class="btn ghost" data-act="reset">記録を消す</button></div>
          <div id="reset-box"></div>
        </div>`;
    },
    act(a, el) {
      if (a === "set") { const k = el.getAttribute("data-k"); let v = el.getAttribute("data-v"); if (v === "true" || v === "false") v = v === "true"; else if (k === "rate") v = parseFloat(v); settings[k] = v; saveSettings(); return this.render(); }
      if (a === "reset") { document.getElementById("reset-box").innerHTML = `<div class="notice">練習の記録（言えた・復習の予定）をすべて消します。<div class="row" style="margin-top:8px"><button class="btn" data-act="reset-yes">消す</button><button class="btn ghost" data-act="reset-no">やめる</button></div></div>`; return; }
      if (a === "reset-yes") { Object.keys(prog).forEach((k) => delete prog[k]); saveProg(); document.getElementById("reset-box").innerHTML = `<div class="small">記録を消しました。</div>`; return; }
      if (a === "reset-no") document.getElementById("reset-box").innerHTML = "";
    }
  };

  /* =============== Claude page abilities (only inside Claude) =============== */
  if (window.claude && typeof window.claude.use === "function") {
    Mic.SR = null; // inside Claude the frame has no direct microphone; dictation is used instead
    window.claude.use("sample").then((s) => { AI.sample = s || null; if (location.hash === "#ai") AI.render(); }).catch(() => { AI.sample = null; });
    window.claude.use("dictation").then((d) => { if (d) Mic.attachDictation(d); }).catch(() => {});
    window.claude.use("tts").then(async (t) => {
      if (!t) return;
      const langs = t.languages ? await t.languages().catch(() => undefined) : undefined;
      if (Array.isArray(langs) && langs.some((l) => /^zh/i.test(l))) claudeTts = t;
    }).catch(() => {});
  } else {
    AI.sample = null;
  }

  route();
})();
