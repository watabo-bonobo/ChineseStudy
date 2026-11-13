// js/scenes.js の全セリフを lines.json に書き出す（音声生成の入力）
global.window = {};
eval(require("fs").readFileSync(__dirname + "/../js/scenes.js", "utf8"));
const out = [], seen = new Set();
const add = (l) => { if (!seen.has(l[0])) { seen.add(l[0]); out.push({ zh: l[0], py: l[1] }); } };
for (const s of window.SCENES) for (const t of s.turns) { add(t.p); t.r.forEach(add); }
add(["今天真的很开心，下次我们再约！", "Jīntiān zhēn de hěn kāixīn, xià cì wǒmen zài yuē!"]); // 設定画面の試聴用
require("fs").writeFileSync("lines.json", JSON.stringify(out, null, 1));
console.log(out.length, "lines");
