// Collect every Chinese sentence/word the app can play, for audio generation.
// Output: lines.json = [{zh, py, role, bundle}]  role: "p" (partner) | "me" (learner line) | "word"
//         bundle: which audio/*.mp3 file the sentence is packed into (scene id, w-<kind>, misc)
// usage: node tools/export_lines.js [out=lines.json]
const fs = require("fs");
global.window = {};
const root = __dirname + "/..";
eval(fs.readFileSync(root + "/js/scenes.js", "utf8"));
if (fs.existsSync(root + "/js/words.js")) eval(fs.readFileSync(root + "/js/words.js", "utf8"));

const out = [], seen = new Set();
const add = (zh, py, role, bundle) => {
  if (!zh || seen.has(zh)) return;
  seen.add(zh); out.push({ zh, py, role, bundle });
};
const KIND = { "接続詞": "conj", "つなぎ言葉": "link", "フレーズ": "phrase", "単語": "word" };
const isLine = (x) => Array.isArray(x) && typeof x[0] === "string";
const lines = (p) => (isLine(p) ? [p] : p || []);
function walk(turns, id) {
  for (const t of turns) {
    if (t.alt) { t.alt.forEach((b) => walk(b, id)); continue; }
    lines(t.p).forEach((l) => add(l[0], l[1], "p", id));
    (t.r || []).forEach((l) => add(l[0], l[1], "me", id));
  }
}
for (const s of window.SCENES || []) walk(s.turns, s.id);
for (const w of window.WORDS || []) {
  (w.ex || []).forEach((e) => add(e[0], e[1], "me", e[3] || "misc"));
  add(w.w.replace(/…+/g, "，"), w.py.replace(/…+/g, ", "), "word", "w-" + (KIND[w.kind] || "word"));
}
add("今天真的很开心，下次我们再约！", "Jīntiān zhēn de hěn kāixīn, xià cì wǒmen zài yuē!", "me", "misc"); // 設定の試聴用
fs.writeFileSync(process.argv[2] || "lines.json", JSON.stringify(out, null, 1));
console.log(out.length, "lines");
