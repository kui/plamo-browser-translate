# plamo-browser-translate

PFN の翻訳特化モデル PLaMo 3 Translate を手元の Mac で動かし、Chrome のページ翻訳に使う設定一式。

- 推論: llama.cpp の `llama-server`（OpenAI 互換 API）
- ブラウザ側: [KISS Translator](https://github.com/fishjar/kiss-translator) の自訂 API（カスタム API）
- 原文も訳文もこの Mac の外に出ない

PLaMo 3 Translate は翻訳先の言語を指示文ではなく `chat_template_kwargs.target_lang` で受け取る。[`kiss/request-hook.js`](kiss/request-hook.js) と [`kiss/response-hook.js`](kiss/response-hook.js) が、KISS Translator のリクエストとレスポンスをこの形に変換する。

## 必要なもの

- Apple Silicon の Mac（他の OS でも llama.cpp が動けば同じ手順で使える）
- `brew install llama.cpp`
- `uv`（モデルの取得に使う）
- Node.js（インポート用ファイルの作成とフックの検証に使う）

## サーバーを起動する

```bash
./serve.sh
```

初回はモデル（2B の Q4_K_M、約 1.8 GB）を `models/` に取得してから、`http://127.0.0.1:8000` で待ち受ける。モデルのサイズは引数で選べる。

```bash
./serve.sh 8b
```

| 変数 | 既定値 | 意味 |
|---|---|---|
| 第 1 引数 | `2b` | `0.8b`、`2b`、`8b`、`31b` |
| `QUANT` | `Q4_K_M` | GGUF の量子化。リポジトリにあるものを指定する |
| `PORT` | `8000` | 待ち受けポート。変えたら、`npm run kiss-import` と `npm run verify` にも環境変数 `URL` で同じポートの URL を渡す |

## KISS Translator に API を足す

Chrome ウェブストアか [Releases](https://github.com/fishjar/kiss-translator/releases) から KISS Translator を入れ、設定ファイルのインポートか手入力で API を足す。画面の名前は KISS Translator v2.1.1 の日本語表示に合わせている。

### 設定ファイルをインポートする

1. インポート用のファイル `kiss-setting-plamo.json` を作る。今の API を残すかどうかで、作り方を選ぶ。
   - 今の API を残す: 拡張の設定画面で **概要** の **エクスポート** を押して今の設定を保存し、そのファイルを渡す。

     ```bash
     npm run kiss-import -- ~/Downloads/kiss-setting_v2_<数字>.json
     ```

   - API の一覧を v2.1.1 の初期状態に戻してよい: エクスポートせずに作る。

     ```bash
     npm run kiss-import -- --fresh
     ```

2. **概要** の **インポート** で `kiss-setting-plamo.json` を選ぶ。

今の API を残す場合:

- `127.0.0.1` か `localhost` の `/v1/chat/completions` を指す Custom API がすでにあれば、新しく足さずにそれを更新する。
- エクスポートしてからインポートするまでの間に変えた設定は、インポートで元に戻る。
- エクスポートしたファイルと `kiss-setting-plamo.json` には、ほかの API のキーも入っている。どちらもリポジトリに入れない（`kiss-setting-plamo.json` は `.gitignore` 済み）。

`--fresh` の場合、自分で足した API と、組み込みの API に入れたキーや変更は消える。API の一覧以外の設定は残る。

### 画面で手入力する

インポートで入るのと同じ値を、画面で設定する。

1. 拡張の設定画面で **翻訳サービス** を開き、**追加** → **Custom** で API を追加する。
2. URL に `http://127.0.0.1:8000/v1/chat/completions` を入れる。
3. **Request Hook** に [`kiss/request-hook.js`](kiss/request-hook.js) の中身を貼る。
4. **Response Hook** に [`kiss/response-hook.js`](kiss/response-hook.js) の中身を貼る。
5. **翻訳プロンプト** で **[单句] 単文翻訳 (Concise)** など単文翻訳のプロンプトを選ぶ。一括翻訳のプロンプトを選ぶと複数段落が 1 リクエストに入り、先頭の段落しか訳されない。
6. **もっと見る** を押し、表示された **最大同時リクエスト数** を `4`（`serve.sh` の `--parallel 4` と揃える）、**リクエストタイムアウト** を `300` 秒にする。
7. **保存** を押す。

### 動作を確かめて翻訳に使う

1. **翻訳サービス** で足した API（インポートなら **PLaMo 3 Translate**）の **クリックしてテスト** を押す。「テスト成功」と出れば使える。
2. **ウェブ翻訳** で、**翻訳サービス** にこの API を選び、**翻訳先の言語** を日本語にする。

## フックを検証する

フックを書き換えたら、拡張に入れる前に、サーバーを起動した状態で実行する。KISS Translator と同じ JS インタプリタ（Sval）でフックを読み込み、対応していない翻訳先の拒否、上限で止まった訳のエラー、起動中のサーバーとの往復を確かめる。

```bash
npm install
npm run verify
```

## 制約

- 段落ごとに 1 リクエストを送るので、長いページは訳し終わるまで時間がかかる。速さが要るなら `0.8b` か `2b`、質が要るなら `8b` を使う。
- 対応言語は 53 言語（一覧は [`kiss/request-hook.js`](kiss/request-hook.js)）。KISS Translator で選べる次の 11 言語は対応していないので、翻訳先に選ぶとエラーになる。チェコ語 `cs`、デンマーク語 `da`、ギリシャ語 `el`、フィンランド語 `fi`、マルタ語 `mt`、ノルウェー語 `nb`、ポルトガル語 `pt`、ルーマニア語 `ro`、スウェーデン語 `sv`、トルコ語 `tr`、ウクライナ語 `uk`。原文の言語にこれらを選んだ場合は、言語を指定せずモデルに判定させる。
- 1 リクエストで扱えるのは、原文と訳を合わせて 16384 トークン（`-c 65536` を 4 スロットで割った値）まで、訳だけなら 8192 トークン（フックの `max_tokens`）まで。超えた段落はエラーになる。合計の上限は `serve.sh` の `-c` で増やせる。
- モデルは PLaMo コミュニティライセンスに従う。非商用なら無償。商用利用の条件は `models/*/LICENSE/ja` を参照する。
