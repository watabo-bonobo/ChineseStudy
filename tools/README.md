# 音声ファイルの作り方

場面のセリフは、オフラインの中国語音声合成（sherpa-onnx ＋ Baker 普通话モデル）で作った mp3 を再生しています。
読み間違い（多音字）を防ぐため、`js/scenes.js` に書いたピンインどおりに読ませています（第3声の連続は自動で変調）。

セリフを追加・変更したら、作業用フォルダで次を実行します。

```sh
pip install sherpa-onnx soundfile          # ffmpeg も必要
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-baker.tar.bz2
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx
tar xjf matcha-icefall-zh-baker.tar.bz2

node <repo>/tools/export_lines.js           # lines.json
python3 <repo>/tools/prep.py                # ピンイン → 音節。ずれがあれば MISMATCH と表示
python3 <repo>/tools/gen.py out             # out/*.mp3 と out/index.json
cp out/*.mp3 <repo>/audio/
# out/index.json の中身を js/audio-index.js の window.AUDIO に入れる
```

音声モデル（Baker データセット）は非商用利用のみ可です。
