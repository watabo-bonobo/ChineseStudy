# 音声ファイルの作り方

場面・単語の文は、オフラインの中国語音声合成 **Kokoro v1.1-zh**（sherpa-onnx）で作った mp3 を再生しています。
相手のセリフは男性の声（話者102）、あなたのセリフと単語は女性の声（話者25）です。

- 多音字の読み間違いを防ぐため、台本に書いたピンインどおりに読ませています（第3声の連続は自動で変調）。
- 中国語の文に半角の数字・英字は入れないでください（漢字で書く）。ピンインの音節数が漢字の数と合わない文は、音声を作らずに一覧で知らせます。
- `--check` を付けると、作った音声を中国語の音声認識（Paraformer）で書き起こし、台本と違う文を一覧にします。同音の字（坐/做 など）の違いは問題ありません。

```sh
pip install sherpa-onnx soundfile numpy        # ffmpeg も必要
M=~/tts-models && mkdir -p $M && cd $M
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2 && tar xjf kokoro-multi-lang-v1_1.tar.bz2
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2 && tar xjf sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2   # --check 用

cd <repo>
node tools/export_lines.js work/lines.json
python3 tools/make_audio.py --models $M --lines work/lines.json --out audio --check
# 変更した文だけ作り直すとき: --only-new（古い音声は自動で消えます）
```
