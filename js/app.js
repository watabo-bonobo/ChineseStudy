/* 夜聊 中国語会話 — app logic (vanilla JS, no build step) */
(function () {
  "use strict";

  const SCENES = window.SCENES || [];
  const view = document.getElementById("view");

  /* ---------------- storage (per browser) ---------------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("yeliao:" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("yeliao:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const settings = Object.assign({ pinyin: true, ja: false, rate: 1, mode: "challenge" }, store.get("settings", {}));
  if (!store.get("rateV2", false)) { settings.rate = 1; store.set("rateV2", true); }
  const done = store.get("done", {});          // sceneId -> times finished
  const stars = store.get("stars", {});        // zh -> [zh, py, ja, note]
  const saveSettings = () => store.set("settings", settings);

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = {
    play: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>'
  };
  const allLines = () => {
    const out = [];
    SCENES.forEach((s) => s.turns.forEach((t) => {
      out.push({ scene: s, who: "p", line: t.p });
      t.r.forEach((r) => out.push({ scene: s, who: "me", line: r }));
    }));
    return out;
  };
  function toggleStar(line) {
    if (stars[line[0]]) delete stars[line[0]]; else stars[line[0]] = line.slice(0, 4);
    store.set("stars", stars);
    return !!stars[line[0]];
  }
  function starBtn(line) {
    const on = !!stars[line[0]];
    return `<button class="icon-btn star ${on ? "on" : ""}" data-star="${esc(line[0])}" aria-pressed="${on}" aria-label="フレーズ帳に保存">${icon.star}</button>`;
  }
  // Lines rendered on screen are kept here so star/play buttons can find their data.
  let lineRegistry = {};
  const reg = (line) => { lineRegistry[line[0]] = line; return line[0]; };

  /* ---------------- speech output ----------------
     Order of preference:
     1. Claude's own voice, when the page is opened in Claude and it can read Chinese
     2. a Chinese voice installed on the device (browser speech synthesis)
     Never fall back to a non-Chinese voice: it reads the characters as Japanese. */
  let zhVoice = null;
  let claudeTts = null;          // Claude voice namespace, only when it can read Chinese
  function findZhVoice() {
    if (!("speechSynthesis" in window)) return null;
    const vs = speechSynthesis.getVoices() || [];
    const zh = vs.filter((v) => /^(zh|cmn)/i.test(v.lang.replace("_", "-")));
    zhVoice = zh.find((v) => /CN|Hans/i.test(v.lang)) || zh.find((v) => !/HK|TW|yue/i.test(v.lang)) || zh[0] || null;
    return zhVoice;
  }
  if ("speechSynthesis" in window) { findZhVoice(); speechSynthesis.onvoiceschanged = findZhVoice; }
  const cleanForSpeech = (t) => String(t).replace(/[《》“”]/g, "");
  const voiceName = () => claudeTts ? "Claudeの音声" : zhVoice ? zhVoice.name : "";

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.innerHTML = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }
  const NO_VOICE_MSG = 'AIの返事を読み上げる中国語の音声がこの端末にありません。<a href="#prefs">設定</a>に追加のしかたがあります。';

  // Recorded audio for every scripted line (natural Mandarin voice, same on every device)
  const AUDIO = window.AUDIO || {};
  const player = new Audio();
  player.preload = "auto";
  function stopAll() {
    try { player.pause(); } catch (e) { /* nothing playing */ }
    if (claudeTts) try { claudeTts.stop(); } catch (e) { /* idle */ }
    if ("speechSynthesis" in window) try { speechSynthesis.cancel(); } catch (e) { /* idle */ }
  }

  function speak(text, rate) {
    if (!text) return;
    const r = rate || settings.rate;   // 1 = natural speed
    stopAll();
    if (AUDIO[text]) {
      player.src = AUDIO[text];
      player.playbackRate = r;
      if ("preservesPitch" in player) player.preservesPitch = true;
      player.play().catch(() => speakLive(text, r));
      return;
    }
    speakLive(text, r);
  }

  // For sentences without a recording (AI replies): Claude's voice or a device Chinese voice
  function speakLive(text, r) {
    if (claudeTts) {
      claudeTts.speak(cleanForSpeech(text), { language: "zh", rate: Math.min(1.5, Math.max(0.7, r)) })
        .catch((e) => { if (e && (e.code === "not_granted" || e.code === "unavailable")) { claudeTts = null; speakLive(text, r); } });
      return;
    }
    if (!("speechSynthesis" in window)) { toast(NO_VOICE_MSG); return; }
    const voice = zhVoice || findZhVoice();
    const listLoaded = (speechSynthesis.getVoices() || []).length > 0;
    if (!voice && listLoaded) { toast(NO_VOICE_MSG); return; }
    try {
      const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
      u.lang = "zh-CN";
      if (voice) u.voice = voice;
      u.rate = r * 0.85;
      speechSynthesis.speak(u);
    } catch (e) { toast(NO_VOICE_MSG); }
  }

  /* ---------------- speech input ----------------
     In Claude, the page uses the platform's dictation; elsewhere the browser's
     SpeechRecognition (Chrome on Android, Safari on iPhone). */
  const Mic = {
    dict: null,
    SR: window.SpeechRecognition || window.webkitSpeechRecognition || null,
    rec: null, live: false, finalText: "", partial: "", cb: null,
    available() { return !!(this.dict || this.SR); },
    attachDictation(d) {
      if (!d) return;
      this.dict = d;
      d.onPartial(({ text }) => { this.partial = text || ""; this.emit(false); });
      d.onFinal(({ text }) => { this.finalText = (this.finalText + (text || "")).trim(); this.partial = ""; this.emit(false); });
      d.onState(({ state, reason }) => {
        if (state === "idle") { this.live = false; this.emit(true, reason); }
      });
    },
    emit(ended, reason) {
      if (this.cb) this.cb({ text: (this.finalText + this.partial).trim(), ended, reason, live: this.live });
      if (ended) this.cb = null;
    },
    // Must be called straight from a tap.
    start(cb) {
      this.cb = cb; this.finalText = ""; this.partial = ""; this.live = true;
      if (this.dict) {
        this.dict.start({ language: "zh-CN" }).catch((e) => {
          this.live = false;
          const code = (e && e.code) || "error";
          if (code === "unavailable" || code === "not_granted") this.dictFailed = code;
          this.emit(true, code);
        });
        return;
      }
      if (!this.SR) { this.live = false; this.emit(true, "unavailable"); return; }
      const rec = new this.SR();
      this.rec = rec; let err = null;
      rec.lang = "zh-CN"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let fin = "", tmp = "";
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) fin += e.results[i][0].transcript; else tmp += e.results[i][0].transcript;
        }
        this.finalText = fin; this.partial = tmp; this.emit(false);
      };
      rec.onerror = (e) => { err = e.error; };
      rec.onend = () => { this.live = false; this.rec = null; this.emit(true, err); };
      try { rec.start(); } catch (e) { this.live = false; this.emit(true, "error"); }
    },
    stop() {
      if (this.dict) { this.dict.stop().catch(() => {}); return; }
      if (this.rec) try { this.rec.stop(); } catch (e) { /* already stopped */ }
    }
  };
  const micErrorText = (r) => ({
    "not-allowed": "マイクが許可されていません。ブラウザの設定でマイクを許可してください。",
    "service-not-allowed": "この画面では音声入力が使えません。",
    not_granted: "マイクが許可されていません。",
    "no-speech": "声が聞き取れませんでした。もう一度どうぞ。",
    unavailable: "この端末では音声入力が使えません。",
    dismissed: "マイクの確認が閉じられました。もう一度押すと再開できます。",
    "network": "音声認識の通信に失敗しました。"
  }[r] || (r && r !== "stopped" && r !== "viewer_stopped" && r !== "aborted" ? "音声入力が止まりました（" + r + "）。" : ""));

  /* ---------------- pronunciation check ---------------- */
  const DIG = "零一二三四五六七八九";
  function numToZh(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n > 99) return String(n);
    if (n < 10) return DIG[n];
    const t = Math.floor(n / 10), o = n % 10;
    return (t === 1 ? "" : DIG[t]) + "十" + (o ? DIG[o] : "");
  }
  const hanOnly = (s) => String(s || "").replace(/\d+/g, numToZh).replace(/[^㐀-鿿]/g, "");
  function compare(said, target) {
    const a = hanOnly(target), b = hanOnly(said);
    const n = a.length, m = b.length;
    if (!n) return { pct: 0, marks: [] };
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const hit = new Array(n).fill(false);
    let i = n, j = m;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) { hit[i - 1] = true; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
    }
    return { pct: Math.round((dp[n][m] / Math.max(n, m)) * 100), hit };
  }
  // Wrap target characters: matched = .hit, missed = .miss (punctuation untouched)
  function markTarget(target, hit) {
    let k = 0, out = "";
    for (const ch of target) {
      if (/[㐀-鿿]/.test(ch)) { out += `<span class="${hit[k] ? "hit" : "miss"}">${esc(ch)}</span>`; k++; }
      else out += esc(ch);
    }
    return out;
  }
  const scoreLabel = (p) => p >= 85 ? ["good", "ばっちり通じます"] : p >= 60 ? ["mid", "おしい！赤い字をもう一度"] : ["low", "お手本を聞いてもう一度"];

  /* ---------------- routing ---------------- */
  function route() {
    const h = (location.hash || "#home").slice(1);
    if (Mic.live) Mic.stop();
    lineRegistry = {};
    document.body.classList.remove("in-scene");
    document.querySelectorAll(".tabbar a").forEach((a) => a.removeAttribute("aria-current"));
    const tab = (name) => { const a = document.querySelector(`.tabbar a[data-tab="${name}"]`); if (a) a.setAttribute("aria-current", "page"); };
    if (h.startsWith("scene-")) {
      const s = SCENES.find((x) => x.id === h.slice(6));
      if (s) { document.body.classList.add("in-scene"); return Scene.open(s); }
    }
    if (h === "ai") { tab("ai"); return AI.render(); }
    if (h === "phrases") { tab("phrases"); return renderPhrases(); }
    if (h === "prefs") { tab("prefs"); return renderPrefs(); }
    tab("home"); renderHome();
  }
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  // Shared click handling for play / star buttons anywhere on the page
  view.addEventListener("click", (e) => {
    const p = e.target.closest("[data-play]");
    if (p) { speak(p.getAttribute("data-play")); return; }
    const s = e.target.closest("[data-star]");
    if (s) {
      const zh = s.getAttribute("data-star");
      const line = lineRegistry[zh] || stars[zh];
      if (!line) return;
      const on = toggleStar(line);
      document.querySelectorAll(`[data-star="${CSS.escape(zh)}"]`).forEach((b) => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    }
  });

  /* ---------------- home ---------------- */
  function tonightLine() {
    const mine = allLines().filter((x) => x.who === "me");
    const d = new Date();
    const seed = d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
    return mine[seed % mine.length];
  }
  function renderHome() {
    const t = tonightLine();
    const finished = SCENES.filter((s) => done[s.id]).length;
    view.innerHTML = `
      <header class="brand">
        <span class="word" lang="zh-CN">夜聊</span>
        <span class="stack" style="gap:0"><span class="py">yè liáo</span><span class="sub">夜の世間話を、中国語で。</span></span>
      </header>
      ${t ? `<section class="tonight" aria-label="今夜のひとこと">
        <span class="eyebrow">今夜のひとこと ・ ${esc(t.scene.title)}</span>
        <span class="zh" lang="zh-CN">${esc(t.line[0])}</span>
        <span class="py">${esc(t.line[1])}</span>
        <span class="ja">${esc(t.line[2])}</span>
        <span class="acts"><button class="icon-btn" data-play="${esc(t.line[0])}" aria-label="発音を聞く">${icon.play}</button>${starBtn(t.line)}</span>
      </section>` : ""}
      <div class="section-head"><h2>場面を選ぶ</h2><span class="small muted">${finished} / ${SCENES.length} 場面クリア</span></div>
      <ul class="scenes">
        ${SCENES.map((s) => `<li><a href="#scene-${s.id}">
          <span class="mark" lang="zh-CN" aria-hidden="true">${esc(s.mark)}</span>
          <span><span class="t">${esc(s.title)}</span><br><span class="w">${esc(s.where)}</span></span>
          <span class="meta">${done[s.id] ? `<span class="done-pill">${done[s.id]}回</span>` : `${s.turns.length}往復`}</span>
        </a></li>`).join("")}
      </ul>
      <a class="ai-card" href="#ai">
        <span class="mark" lang="zh-CN" aria-hidden="true">聊</span>
        <span><b>AIと自由に話す</b><br><span class="small muted">台本なしで、場面の続きを話してみる。間違いは直してくれます。</span></span>
      </a>`;
    reg(t ? t.line : ["", "", ""]);
  }

  /* ---------------- scene player ---------------- */
  const Scene = {
    s: null, t: 0, phase: "intro", pick: null, said: "", result: null, log: [], micMsg: "",
    open(s) {
      Object.assign(this, { s, t: 0, phase: "intro", pick: null, said: "", result: null, log: [], micMsg: "" });
      this.render();
    },
    lineHtml(line, who) {
      reg(line);
      const showPy = settings.pinyin, showJa = who === "me" || settings.ja;
      return `<div class="msg ${who}">
        <div class="bubble">
          <div class="zh" lang="zh-CN">${esc(line[0])}</div>
          <div class="py" ${showPy ? "" : "hidden"}>${esc(line[1])}</div>
          <div class="ja" ${showJa ? "" : "hidden"}>${esc(line[2])}</div>
          ${line[3] ? `<div class="note" ${showJa ? "" : "hidden"}>${esc(line[3])}</div>` : ""}
        </div>
        <div class="tools">
          <button class="chip" data-play="${esc(line[0])}">${icon.play}聞く</button>
          ${who === "p" ? `<button class="chip ${showPy ? "on" : ""}" data-toggle="py">ピンイン</button><button class="chip ${showJa ? "on" : ""}" data-toggle="ja">訳</button>` : ""}
        </div>
      </div>`;
    },
    render() {
      const s = this.s;
      const total = s.turns.length;
      const stepTxt = this.phase === "intro" ? `${total}往復` : this.phase === "end" ? "完了" : `${Math.min(this.t + 1, total)} / ${total}`;
      view.innerHTML = `
        <header class="scene-head">
          <a class="icon-btn" href="#home" aria-label="場面一覧に戻る">${icon.back}</a>
          <div class="title"><h1>${esc(s.title)}</h1><div class="w">${esc(s.where)}</div></div>
          <span class="step">${stepTxt}</span>
        </header>
        ${this.phase === "intro" ? this.introHtml() : `<div class="log" id="log">${this.log.map((x) => this.lineHtml(x.line, x.who)).join("")}</div>`}
        ${this.phase === "end" ? this.endHtml() : ""}
        <div class="tray" id="tray" ${this.phase === "end" ? "hidden" : ""}>${this.trayHtml()}</div>`;
      this.bind();
      if (this.phase !== "intro") requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
    },
    introHtml() {
      const s = this.s;
      return `<section class="intro">
        <div class="row" style="gap:14px;flex-wrap:nowrap"><span class="mark" lang="zh-CN" aria-hidden="true">${esc(s.mark)}</span><p class="lead" style="margin:0">${esc(s.intro)}</p></div>
        <div class="who">相手：${esc(s.partner)}</div>
        <div><div class="eyebrow" style="margin-bottom:6px">知っておくと便利</div><ul class="tips">${s.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      </section>`;
    },
    trayHtml() {
      if (this.phase === "end") return "";
      const turn = this.s.turns[this.t];
      if (this.phase === "intro") {
        return `<div class="label">${settings.mode === "challenge" ? "日本語を見て、中国語で言ってみるモード" : "中国語を見て読むモード"}（設定で変更できます）</div>
          <button class="btn primary" data-act="start">はじめる</button>`;
      }
      if (this.phase === "choose") {
        return `<div class="label">あなたの番：どう返しますか？</div>
          <div class="options">${turn.r.map((r, i) => settings.mode === "challenge"
            ? `<button class="option" data-pick="${i}">${esc(r[2])}</button>`
            : `<button class="option" data-pick="${i}"><span class="zh" lang="zh-CN">${esc(r[0])}</span>${settings.pinyin ? `<span class="py">${esc(r[1])}</span>` : ""}<span class="small muted">${esc(r[2])}</span></button>`).join("")}</div>`;
      }
      const r = turn.r[this.pick];
      reg(r);
      const micBtn = Mic.available() && !Mic.dictFailed
        ? `<button class="btn wide mic ${Mic.live ? "live" : ""}" data-act="mic">${icon.mic}${Mic.live ? "話し終わったら押す" : this.result ? "もう一度言う" : "話す"}</button>` : "";
      const heard = `<div class="heard" id="heard">${this.micMsg ? esc(this.micMsg) : this.said ? `聞き取り：<b lang="zh-CN">${esc(this.said)}</b>` : Mic.live ? "聞いています…" : ""}</div>`;
      if (this.phase === "say") {
        return `<div class="label">中国語で言ってみましょう</div>
          <div class="target-ja">${esc(r[2])}</div>
          ${heard}
          <div class="row">${micBtn}<button class="btn wide" data-act="reveal">${icon.eye}答えを見る</button></div>
          ${micBtn ? "" : `<div class="small muted">声に出して言ってから「答えを見る」を押してください。</div>`}`;
      }
      // reveal
      const res = this.result;
      const sl = res ? scoreLabel(res.pct) : null;
      return `<div class="answer">
          <div class="zh" lang="zh-CN">${res ? markTarget(r[0], res.hit) : esc(r[0])}</div>
          <div class="py">${esc(r[1])}</div>
          <div class="small">${esc(r[2])}</div>
          ${r[3] ? `<div class="note">${esc(r[3])}</div>` : ""}
        </div>
        ${res ? `<div class="score ${sl[0]}">一致 ${res.pct}% ・ ${sl[1]}</div>` : ""}
        ${heard}
        <div class="row">
          <button class="icon-btn" data-play="${esc(r[0])}" aria-label="お手本を聞く">${icon.play}</button>
          ${starBtn(r)}
          ${micBtn}
          <button class="btn primary wide" data-act="next">${this.t + 1 < this.s.turns.length ? "次へ" : "会話を終える"}</button>
        </div>`;
    },
    endHtml() {
      const mine = this.log.filter((x) => x.who === "me");
      return `<section class="end">
        <h2>おつかれさまでした</h2>
        <p class="muted" style="margin:0">今回使ったフレーズです。覚えたいものは保存しておくとフレーズ帳で見返せます。</p>
        <ul class="plist">${mine.map((x) => { reg(x.line); return `<li>
          <span class="zh" lang="zh-CN">${esc(x.line[0])}</span><span class="py">${esc(x.line[1])}</span><span class="ja">${esc(x.line[2])}</span>
          <span class="acts"><button class="icon-btn" data-play="${esc(x.line[0])}" aria-label="聞く">${icon.play}</button>${starBtn(x.line)}</span></li>`; }).join("")}</ul>
        <div class="stack">
          <a class="btn primary" href="#ai" data-ai-scene="${esc(this.s.id)}">AIとこの場面の続きを話す</a>
          <div class="row"><button class="btn wide" data-act="again">もう一度</button><a class="btn wide" href="#home">場面一覧へ</a></div>
        </div>
      </section>`;
    },
    partnerSays() {
      const line = this.s.turns[this.t].p;
      this.log.push({ who: "p", line });
      speak(line[0]);
    },
    bind() {
      view.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
        const bubble = b.closest(".msg").querySelector(".bubble");
        const which = b.getAttribute("data-toggle");
        const els = which === "py" ? [bubble.querySelector(".py")] : [bubble.querySelector(".ja"), bubble.querySelector(".note")];
        const show = els[0].hidden;
        els.forEach((el) => { if (el) el.hidden = !show; });
        b.classList.toggle("on", show);
      }));
      view.querySelectorAll("[data-ai-scene]").forEach((a) => a.addEventListener("click", () => { AI.pendingScene = a.getAttribute("data-ai-scene"); }));
      view.addEventListener("click", this._h || (this._h = (e) => {
        if (!location.hash.startsWith("#scene-")) return;
        const pick = e.target.closest("[data-pick]");
        if (pick) {
          this.pick = +pick.getAttribute("data-pick"); this.said = ""; this.result = null; this.micMsg = "";
          this.phase = settings.mode === "challenge" ? "say" : "reveal";
          if (this.phase === "reveal") speak(this.s.turns[this.t].r[this.pick][0]);
          return this.render();
        }
        const act = e.target.closest("[data-act]");
        if (!act) return;
        const a = act.getAttribute("data-act");
        if (a === "start") { this.phase = "choose"; this.partnerSays(); this.render(); }
        else if (a === "reveal") { if (Mic.live) Mic.stop(); this.phase = "reveal"; speak(this.s.turns[this.t].r[this.pick][0]); this.render(); }
        else if (a === "mic") this.mic();
        else if (a === "next") {
          if (Mic.live) Mic.stop();
          this.log.push({ who: "me", line: this.s.turns[this.t].r[this.pick] });
          this.t++; this.pick = null; this.said = ""; this.result = null; this.micMsg = "";
          if (this.t < this.s.turns.length) { this.phase = "choose"; this.partnerSays(); }
          else { this.phase = "end"; done[this.s.id] = (done[this.s.id] || 0) + 1; store.set("done", done); }
          this.render();
        } else if (a === "again") this.open(this.s);
      }));
    },
    mic() {
      if (Mic.live) { Mic.stop(); return; }
      this.micMsg = ""; this.said = "";
      const target = this.s.turns[this.t].r[this.pick][0];
      Mic.start(({ text, ended, reason }) => {
        this.said = text;
        if (ended) {
          if (text) { this.result = compare(text, target); this.phase = "reveal"; this.micMsg = ""; }
          else this.micMsg = micErrorText(reason) || "声が聞き取れませんでした。もう一度どうぞ。";
          this.render();
        } else {
          const h = document.getElementById("heard");
          if (h) h.innerHTML = text ? `聞き取り：<b lang="zh-CN">${esc(text)}</b>` : "聞いています…";
        }
      });
      this.render();
    }
  };

  /* ---------------- AI free talk ----------------
     Works when the page is opened in Claude (uses the page's "ask Claude" ability).
     Elsewhere it explains how to open it. */
  const AI = {
    sample: undefined,     // undefined = still checking, null = not available
    sceneId: store.get("aiScene", "free"),
    pendingScene: null,
    msgs: [],              // [{role, content}] sent to Claude (first one = instructions)
    view: [],              // rendered turns: {who:'ai', data} | {who:'me', text, fix}
    hints: [],
    busy: false, err: "", draft: "",
    sceneDesc() {
      if (this.sceneId === "free") return "上海の夜、友達の友達との気楽な飲み会。話題は自由（仕事、趣味、上海の生活、食べ物など）。";
      const s = SCENES.find((x) => x.id === this.sceneId);
      return s ? `${s.title}（${s.where}）。あなたの役：${s.partner}。${s.intro}` : "上海の夜の飲み会。";
    },
    instructions() {
      return [
        "あなたは中国語会話の練習相手です。上海に住む中国人として、場面の中の人物を演じてください。",
        "学習者：日本人、中国語学習歴7か月（HSK2〜3級程度）、上海在住、仕事はガス安全関連のソフトウェア。目標は会食や飲み会など夜の場面で世間話ができるようになること。",
        "場面：" + this.sceneDesc(),
        "ルール：",
        "- 毎回、自然な話し言葉の中国語（簡体字）で1〜2文だけ返す。HSK3程度の語彙が中心。たまに会食や飲み会で実際によく使う口語表現を1つ入れる。",
        "- 毎回、質問や話題を投げて会話を続ける。説教や長い説明はしない。",
        "- 学習者が日本語やピンインで書いたら、意図をくみ取って会話を続け、fix に中国語での言い方を示す。",
        "- 学習者の中国語に誤りや不自然な点があれば、fix に直した文と、日本語で短い説明を入れる。自然なら fix は null。",
        "- hints には、学習者が次に言えそうな短い返答例を2つ（HSK2〜3程度）。",
        "出力は次の形のJSONだけ：",
        '{"reply":{"zh":"中国語","py":"声調記号付きピンイン","ja":"自然な日本語訳"},"fix":null または {"zh":"直した中国語","py":"ピンイン","why":"日本語で1文の説明"},"hints":[{"zh":"","py":"","ja":""},{"zh":"","py":"","ja":""}]}'
      ].join("\n");
    },
    reset() {
      this.msgs = [{ role: "user", content: this.instructions() + "\n\n場面に合わせて、あなたから最初のひとことで話しかけてください。" }];
      this.view = []; this.hints = []; this.err = "";
    },
    async ask() {
      if (!this.sample || this.busy) return;
      this.busy = true; this.err = ""; this.render();
      try {
        const res = await this.sample.json(this.msgs, { cache: false });
        if (!res || !res.reply || !res.reply.zh) throw { code: "invalid_json" };
        this.msgs.push({ role: "assistant", content: JSON.stringify({ reply: res.reply }) });
        const lastMe = [...this.view].reverse().find((x) => x.who === "me");
        if (lastMe && res.fix && res.fix.zh) lastMe.fix = res.fix;
        this.view.push({ who: "ai", data: res.reply });
        this.hints = Array.isArray(res.hints) ? res.hints.filter((h) => h && h.zh).slice(0, 3) : [];
        speak(res.reply.zh);
      } catch (e) {
        const code = e && e.code;
        this.err = code === "not_granted" ? "Claudeへの問い合わせが許可されていません。ページの権限設定から許可するとAI会話が使えます。"
          : code === "rate_limited" ? "混み合っています。少し待ってからもう一度送ってください。"
          : "返事を受け取れませんでした。もう一度送ってください。";
        if (code === "not_granted") this.sample = null;
      }
      this.busy = false;
      this.render();
    },
    send(text) {
      text = (text || "").trim();
      if (!text || this.busy) return;
      this.view.push({ who: "me", text });
      this.msgs.push({ role: "user", content: text });
      // keep the instructions turn + the latest 24 turns
      if (this.msgs.length > 25) this.msgs = [this.msgs[0]].concat(this.msgs.slice(-24));
      this.draft = "";
      this.ask();
    },
    render() {
      if (location.hash !== "#ai") return;
      if (this.pendingScene) {
        this.sceneId = this.pendingScene; this.pendingScene = null; store.set("aiScene", this.sceneId); this.reset();
      }
      const unavailable = this.sample === null;
      const checking = this.sample === undefined;
      view.innerHTML = `
        <section class="ai-head">
          <h1>AIと自由に話す</h1>
          <p class="muted small" style="margin:0">台本なしの会話です。中国語で返してみて、言えない所は日本語でもOK。不自然な所は直してくれます。</p>
          <div class="row" style="flex-wrap:nowrap">
            <label class="field" style="flex:1;min-width:0" for="ai-scene">場面
              <select id="ai-scene">
                <option value="free" ${this.sceneId === "free" ? "selected" : ""}>自由な雑談（飲み会）</option>
                ${SCENES.map((s) => `<option value="${s.id}" ${this.sceneId === s.id ? "selected" : ""}>${esc(s.mark)}　${esc(s.title)}</option>`).join("")}
              </select>
            </label>
            <button class="btn" data-ai="restart" style="align-self:flex-end" ${unavailable || checking ? "disabled" : ""}>${this.view.length ? "やり直す" : "始める"}</button>
          </div>
        </section>
        ${unavailable ? `<div class="notice" style="margin-top:14px">AI会話は、このアプリをClaudeのページとして開いた時だけ使えます。台本の場面とフレーズ帳はどこでも使えます。</div>` : ""}
        ${checking ? `<div class="typing" style="margin-top:14px">AI会話が使えるか確認しています…</div>` : ""}
        <div class="log" id="log">
          ${this.view.map((x) => x.who === "ai" ? this.aiHtml(x.data) : this.meHtml(x)).join("")}
          ${this.busy ? `<div class="msg p"><div class="bubble typing">考えています…</div></div>` : ""}
          ${this.err ? `<div class="err">${esc(this.err)}</div>` : ""}
        </div>
        ${!unavailable && !checking && this.view.length ? `<div class="tray">
          ${this.hints.length ? `<div class="hints">${this.hints.map((h, i) => `<button data-hint="${i}"><span class="zh" lang="zh-CN">${esc(h.zh)}</span><span class="ja">${esc(h.ja || "")}</span></button>`).join("")}</div>` : ""}
          <div class="small muted" id="ai-heard"></div>
          <div class="composer">
            ${Mic.available() && !Mic.dictFailed ? `<button class="icon-btn mic ${Mic.live ? "live" : ""}" data-ai="mic" aria-label="話して入力">${icon.mic}</button>` : "<span></span>"}
            <textarea id="ai-input" rows="1" lang="zh-CN" placeholder="中国語で返事（日本語でもOK）">${esc(this.draft)}</textarea>
            <button class="icon-btn" data-ai="send" aria-label="送信" style="background:var(--accent);color:var(--accent-ink);border-color:var(--accent)">${icon.send}</button>
          </div>
        </div>` : ""}`;
      this.bind();
      if (this.view.length) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
    },
    aiHtml(d) {
      const line = [d.zh, d.py || "", d.ja || ""]; reg(line);
      return `<div class="msg p"><div class="bubble">
          <div class="zh" lang="zh-CN">${esc(d.zh)}</div>
          <div class="py" ${settings.pinyin ? "" : "hidden"}>${esc(d.py || "")}</div>
          <div class="ja" ${settings.ja ? "" : "hidden"}>${esc(d.ja || "")}</div>
        </div>
        <div class="tools"><button class="chip" data-play="${esc(d.zh)}">${icon.play}聞く</button>
          <button class="chip ${settings.pinyin ? "on" : ""}" data-toggle="py">ピンイン</button>
          <button class="chip ${settings.ja ? "on" : ""}" data-toggle="ja">訳</button></div></div>`;
    },
    meHtml(x) {
      let fix = "";
      if (x.fix) {
        const line = [x.fix.zh, x.fix.py || "", x.fix.why || ""]; reg(line);
        fix = `<div class="fix"><span class="lbl">こう言うと自然</span><span class="zh" lang="zh-CN">${esc(x.fix.zh)}</span>
          <span class="muted small">${esc(x.fix.py || "")}</span><span class="small">${esc(x.fix.why || "")}</span>
          <span class="row"><button class="chip" data-play="${esc(x.fix.zh)}">${icon.play}聞く</button>${starBtn(line)}</span></div>`;
      }
      return `<div class="msg me"><div class="bubble"><div class="zh" lang="zh-CN" style="font-size:17px">${esc(x.text)}</div>${fix}</div></div>`;
    },
    bind() {
      const sel = document.getElementById("ai-scene");
      if (sel) sel.addEventListener("change", () => { this.sceneId = sel.value; store.set("aiScene", this.sceneId); this.reset(); this.render(); });
      const input = document.getElementById("ai-input");
      if (input) {
        input.addEventListener("input", () => { this.draft = input.value; input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(input.value); } });
      }
      view.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
        const bubble = b.closest(".msg").querySelector(".bubble");
        const el = bubble.querySelector(b.getAttribute("data-toggle") === "py" ? ".py" : ".ja");
        el.hidden = !el.hidden; b.classList.toggle("on", !el.hidden);
      }));
      view.querySelectorAll("[data-hint]").forEach((b) => b.addEventListener("click", () => {
        const h = this.hints[+b.getAttribute("data-hint")];
        if (h && input) { input.value = h.zh; this.draft = h.zh; input.focus(); speak(h.zh); }
      }));
      view.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => {
        const a = b.getAttribute("data-ai");
        if (a === "restart") { this.reset(); this.ask(); }
        else if (a === "send") this.send(input && input.value);
        else if (a === "mic") {
          if (Mic.live) { Mic.stop(); return; }
          const base = input ? input.value : "";
          b.classList.add("live");
          Mic.start(({ text, ended, reason }) => {
            if (input) { input.value = (base + text).trim(); this.draft = input.value; }
            const hd = document.getElementById("ai-heard");
            if (ended) {
              b.classList.remove("live");
              if (hd) hd.textContent = text ? "" : micErrorText(reason);
            } else if (hd) hd.textContent = "聞いています…（話し終わったらマイクをもう一度押す）";
          });
        }
      }));
    }
  };

  /* ---------------- phrase book ---------------- */
  let phraseFilter = "all";
  function renderPhrases() {
    let items;
    if (phraseFilter === "star") items = Object.values(stars).map((line) => ({ line, who: "me", scene: null }));
    else items = allLines().filter((x) => phraseFilter === "all" || x.scene.id === phraseFilter);
    view.innerHTML = `
      <h1 style="font-size:22px">フレーズ帳</h1>
      <div class="filters" role="tablist">
        <button class="chip ${phraseFilter === "all" ? "on" : ""}" data-f="all">すべて</button>
        <button class="chip ${phraseFilter === "star" ? "on" : ""}" data-f="star">${icon.star}保存 ${Object.keys(stars).length}</button>
        ${SCENES.map((s) => `<button class="chip ${phraseFilter === s.id ? "on" : ""}" data-f="${s.id}"><span class="m" lang="zh-CN">${esc(s.mark)}</span>${esc(s.title)}</button>`).join("")}
      </div>
      ${items.length ? `<ul class="plist">${items.map((x) => { reg(x.line); return `<li>
        <span class="who-tag">${x.scene ? `${esc(x.scene.title)} ・ ${x.who === "p" ? "相手" : "あなた"}` : "保存したフレーズ"}</span>
        <span class="zh" lang="zh-CN">${esc(x.line[0])}</span>
        <span class="py">${esc(x.line[1])}</span>
        <span class="ja">${esc(x.line[2])}${x.line[3] ? `<br><span class="note">${esc(x.line[3])}</span>` : ""}</span>
        <span class="acts"><button class="icon-btn" data-play="${esc(x.line[0])}" aria-label="聞く">${icon.play}</button>${starBtn(x.line)}</span>
      </li>`; }).join("")}</ul>`
        : `<div class="empty">まだ保存したフレーズはありません。<br>会話中に ☆ を押すとここに集まります。</div>`}`;
    view.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { phraseFilter = b.getAttribute("data-f"); renderPhrases(); }));
  }

  /* ---------------- settings ---------------- */
  function renderPrefs() {
    view.innerHTML = `
      <h1 style="font-size:22px">設定</h1>
      <div class="prefs">
        <div class="pref"><span>練習のしかた</span><span class="d">「日本語→中国語」は言いたいことを日本語で選び、自分で中国語にします。</span>
          <span class="c seg"><button data-mode="challenge" aria-pressed="${settings.mode === "challenge"}">日本語→中国語</button><button data-mode="read" aria-pressed="${settings.mode === "read"}">中国語を読む</button></span></div>
        <div class="pref"><span>ピンインを表示</span><span class="d">オフにすると、聞き取りと漢字だけで挑戦できます。</span>
          <button class="c switch" role="switch" id="sw-py" aria-checked="${settings.pinyin}" aria-label="ピンインを表示"></button></div>
        <div class="pref"><span>相手のセリフの訳を表示</span><span class="d">オフでも、吹き出しの「訳」でいつでも見られます。</span>
          <button class="c switch" role="switch" id="sw-ja" aria-checked="${settings.ja}" aria-label="訳を表示"></button></div>
        <div class="pref"><span>読み上げの速さ</span><span class="d" id="rate-val">${settings.rate.toFixed(2)} 倍</span>
          <span class="c row"><input type="range" id="rate" min="0.6" max="1.3" step="0.05" value="${settings.rate}" aria-label="読み上げの速さ"><button class="icon-btn" data-play="今天真的很开心，下次我们再约！" aria-label="試しに聞く">${icon.play}</button></span></div>
      </div>
      <div class="about">
        <div><b>読み上げ：</b>場面とフレーズ帳のセリフは、録音済みの中国語（普通话）の音声で再生します。どの端末でも同じ声です。</div>
        <div><b>AIの返事の読み上げ：</b>${voiceName() ? `中国語の音声（${esc(voiceName())}）で読み上げます。` : "この端末には中国語の音声が入っていないため、AIの返事は読み上げできません（文字では表示されます）。"}</div>
        ${claudeTts || zhVoice ? "" : `<div>AIの返事も読み上げたい場合、中国語の音声を追加するには：<br>・iPhone：設定 → アクセシビリティ → 読み上げコンテンツ → 声 → 中国語（中国大陸）を選んでダウンロード<br>・Android：設定 → システム → 言語と入力 → 音声出力（テキスト読み上げ）→ Google音声サービスの設定で「中国語（普通话）」の音声データをインストール<br>・パソコン：Chromeで開くと中国語の音声が最初から入っています。<br>追加したらこのページを開き直してください。</div>`}
        <div>マイク：${Mic.available() && !Mic.dictFailed ? "使えます。初回はマイクの許可を求められます。" : "この端末・ブラウザでは使えません（声に出して練習し、「答えを見る」で確認できます）。"}</div>
        <div>練習の記録と保存したフレーズは、この端末のブラウザに保存されます。</div>
        <button class="btn ghost" id="reset-progress" style="justify-self:start">クリア回数をリセット</button>
        <div id="reset-msg"></div>
      </div>`;
    view.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { settings.mode = b.getAttribute("data-mode"); saveSettings(); renderPrefs(); }));
    const sw = (id, key) => document.getElementById(id).addEventListener("click", () => { settings[key] = !settings[key]; saveSettings(); renderPrefs(); });
    sw("sw-py", "pinyin"); sw("sw-ja", "ja");
    const rate = document.getElementById("rate");
    rate.addEventListener("input", () => { settings.rate = parseFloat(rate.value); document.getElementById("rate-val").textContent = settings.rate.toFixed(2) + " 倍"; saveSettings(); });
    document.getElementById("reset-progress").addEventListener("click", () => {
      Object.keys(done).forEach((k) => delete done[k]); store.set("done", done);
      document.getElementById("reset-msg").textContent = "クリア回数をリセットしました。";
    });
  }

  /* ---------------- Claude page abilities (only inside Claude) ---------------- */
  if (window.claude && typeof window.claude.use === "function") {
    window.claude.use("sample").then((s) => { AI.sample = s || null; if (location.hash === "#ai") AI.render(); }).catch(() => { AI.sample = null; AI.render(); });
    window.claude.use("dictation").then((d) => { if (d) Mic.attachDictation(d); }).catch(() => {});
    window.claude.use("tts").then(async (t) => {
      if (!t) return;
      const langs = t.languages ? await t.languages().catch(() => undefined) : undefined;
      // Use Claude's voice only when it says it can read Chinese.
      if (Array.isArray(langs) && langs.some((l) => /^zh/i.test(l))) {
        claudeTts = t;
        if (location.hash === "#prefs") renderPrefs();
      }
    }).catch(() => {});
    Mic.SR = null; // inside Claude the frame has no direct microphone access; dictation is used instead
  } else {
    AI.sample = null;
  }

  route();
})();
