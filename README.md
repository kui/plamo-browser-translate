# plamo-browser-translate

PFN の翻訳特化モデル PLaMo 3 Translate を手元の Mac や Windows で動かし、Chrome のページ翻訳に使う設定一式。

- 推論: llama.cpp の `llama-server`（OpenAI 互換 API）
- ブラウザ側: [KISS Translator](https://github.com/fishjar/kiss-translator) の自訂 API（カスタム API）
- 原文も訳文もこの PC の外に出ない

PLaMo 3 Translate は翻訳先の言語を指示文ではなく `chat_template_kwargs.target_lang` で受け取る。[`kiss/request-hook.js`](kiss/request-hook.js) と [`kiss/response-hook.js`](kiss/response-hook.js) が、KISS Translator のリクエストとレスポンスをこの形に変換する。

## 必要なもの

- Apple Silicon の Mac か Windows（他の OS でも llama.cpp が動けば同じ手順で使える）
- llama.cpp（Mac は `brew install llama.cpp`、Windows は `winget install ggml.llamacpp` のあと新しいターミナルを開く）
- [mise](https://mise.jdx.dev/)（[有効化](https://mise.jdx.dev/getting-started.html#activate-mise)してから `mise install` を実行すると、bun と、モデルの取得に使う uv が入る）

## サーバーを起動・停止する

```bash
bun run serve start
```

初回はモデル（2B の Q4_K_M、約 1.8 GB）を `models/` に取得する。サーバーはバックグラウンドで動き、`http://127.0.0.1:21434` で応答するようになると、コマンドは終了する。ターミナルを閉じてもサーバーは止まらない。サーバーの出力は、ホームの `.cache/plamo-browser-translate/<ポート>.log` に書かれる。

モデルのサイズは引数で選べる。

```bash
bun run serve start 8b
```

止めるときは次を実行する。どのワークツリーからでも止められる。動いているものと違うサイズや `QUANT` を指定した `start` はエラーになるので、変えるときは止めてから起動し直す。

```bash
bun run serve stop
```

| 変数 | 既定値 | 意味 |
|---|---|---|
| `start` の引数 | `2b` | `0.8b`、`2b`、`8b`、`31b` |
| `QUANT` | `Q4_K_M` | GGUF の量子化。リポジトリにあるものを指定する |
| `PORT` | `21434` | 待ち受けポート。変えたら、`bun run serve stop` にも同じ `PORT` を、`bun run kiss-import` と `bun run verify` には環境変数 `URL` で同じポートの URL を渡す |
| `SLEEP_IDLE_SECONDS` | `300` | この秒数だけ使われないと、モデルをメモリから外す。`-1` で無効 |

環境変数は、Mac では `PORT=8001 bun run serve start`、Windows の PowerShell では `$env:PORT = 8001; bun run serve start` のように渡す。

使われない間はモデルがメモリから外れるので、サーバーを止めなくてもゲームなどにメモリを空けられる。プロセスは待ち受けを続け、次の翻訳リクエストでモデルを読み込み直す。2B のモデルなら、その 1 回だけ数秒余分にかかる。

`serve.ts` を書き換えたら `bun test` で確かめる。`llama-server` もモデルも要らない。

## ログオン時に自動で起動する（Windows）

タスクスケジューラに登録すると、ログオンのたびにウィンドウを出さずに起動する。登録するとすぐに起動もする。

```bash
bun run autostart install
```

モデルのサイズは `bun run autostart install 8b` のように選べる。そのとき設定されている `QUANT`、`PORT`、`SLEEP_IDLE_SECONDS` も引き継ぐ。変えるときは `install` をやり直す。

| コマンド | 動作 |
|---|---|
| `bun run autostart stop` | サーバーを今すぐ止める。次のログオンでまた起動する |
| `bun run autostart start` | 止めたサーバーを起動する |
| `bun run autostart uninstall` | サーバーを止めて、登録を消す |

- サーバーの出力は `serve.log` に書かれる。起動しないときはここを見る。初回はモデルを取得するので、待ち受けるまで時間がかかる。
- タスクは `bun` と `llama-server` を、ユーザー環境変数の `PATH` から探す。mise は [shims を `PATH` に入れる](https://mise.jdx.dev/dev-tools/shims.html)。シェルのプロファイルで有効化するだけだと、タスクから `bun` が見つからない。
- 登録したフォルダーのファイルを使うので、リポジトリを動かしたら `install` をやり直す。

## KISS Translator に API を足す

Chrome ウェブストアか [Releases](https://github.com/fishjar/kiss-translator/releases) から KISS Translator を入れ、設定ファイルのインポートか手入力で API を足す。画面の名前は KISS Translator v2.1.1 の日本語表示に合わせている。

### 設定ファイルをインポートする

1. インポート用のファイル `kiss-setting-plamo.json` を作る。今の API を残すかどうかで、作り方を選ぶ。
   - 今の API を残す: 拡張の設定画面で **概要** の **エクスポート** を押して今の設定を保存し、そのファイルを渡す。

     ```bash
     bun run kiss-import ~/Downloads/kiss-setting_v2_<数字>.json
     ```

     Windows の PowerShell では `$HOME\Downloads\...` と書く。

   - API の一覧を v2.1.1 の初期状態に戻してよい: エクスポートせずに作る。

     ```bash
     bun run kiss-import --fresh
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
2. URL に `http://127.0.0.1:21434/v1/chat/completions` を入れる。
3. **Request Hook** に [`kiss/request-hook.js`](kiss/request-hook.js) の中身を貼る。
4. **Response Hook** に [`kiss/response-hook.js`](kiss/response-hook.js) の中身を貼る。
5. **翻訳プロンプト** で **[单句] 単文翻訳 (Concise)** など単文翻訳のプロンプトを選ぶ。一括翻訳のプロンプトを選ぶと複数段落が 1 リクエストに入り、先頭の段落しか訳されない。
6. **もっと見る** を押し、表示された **最大同時リクエスト数** を `4`（`serve.ts` の `--parallel 4` と揃える）、**リクエストタイムアウト** を `300` 秒にする。
7. **保存** を押す。

### 動作を確かめて翻訳に使う

1. **翻訳サービス** で足した API（インポートなら **PLaMo 3 Translate**）の **クリックしてテスト** を押す。「テスト成功」と出れば使える。
2. **ウェブ翻訳** で、**翻訳サービス** にこの API を選び、**翻訳先の言語** を日本語にする。

## フックを検証する

フックを書き換えたら、拡張に入れる前に、サーバーを起動した状態で実行する。KISS Translator と同じ JS インタプリタ（Sval）でフックを読み込み、対応していない翻訳先の拒否、上限で止まった訳のエラー、起動中のサーバーとの往復を確かめる。

```bash
bun install
bun run verify
```

サーバーを起動できないときは、往復を除いて、フック単体とインポート用ファイルの中身だけを確かめられる。

```bash
bun run verify --offline
```

## 制約

- 段落ごとに 1 リクエストを送るので、長いページは訳し終わるまで時間がかかる。速さが要るなら `0.8b` か `2b`、質が要るなら `8b` を使う。
- 対応言語は 53 言語（一覧は [`kiss/request-hook.js`](kiss/request-hook.js)）。KISS Translator で選べる次の 11 言語は対応していないので、翻訳先に選ぶとエラーになる。チェコ語 `cs`、デンマーク語 `da`、ギリシャ語 `el`、フィンランド語 `fi`、マルタ語 `mt`、ノルウェー語 `nb`、ポルトガル語 `pt`、ルーマニア語 `ro`、スウェーデン語 `sv`、トルコ語 `tr`、ウクライナ語 `uk`。原文の言語にこれらを選んだ場合は、言語を指定せずモデルに判定させる。
- 1 リクエストで扱えるのは、原文と訳を合わせて 16384 トークン（`-c 65536` を 4 スロットで割った値）まで、訳だけなら 8192 トークン（フックの `max_tokens`）まで。超えた段落はエラーになる。合計の上限は `serve.ts` の `-c` で増やせる。
- モデルは PLaMo コミュニティライセンスに従う。非商用なら無償。商用利用の条件は `models/*/LICENSE/ja` を参照する。
