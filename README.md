# plamo-browser-translate

翻訳モデル PLaMo 3 Translate をローカルで実行し、Chrome のページ翻訳に使う。原文も訳文も PC の外に出ない。

## 必要なもの

- llama.cpp: Mac は `brew install llama.cpp`、Windows は `winget install ggml.llamacpp` のあと新しいターミナルを開く
- [mise](https://mise.jdx.dev/): [有効化](https://mise.jdx.dev/getting-started.html#activate-mise)してから `mise install` を実行する
- Chrome 拡張の [KISS Translator](https://github.com/fishjar/kiss-translator) v2.1.1 以降

## 使い始める

1. サーバーを起動する。初回はモデル（約 1.8 GB）をダウンロードする。

   ```bash
   bun run serve start
   ```

2. KISS Translator の設定ファイルを作る。KISS Translator に自分で足した API やキーは、インポートすると消える。残すなら、下の表の「今の API を残す」を使う。

   ```bash
   bun run kiss-import --fresh
   ```

3. 拡張の設定画面の **概要** → **インポート** で `kiss-setting-plamo.json` を選ぶ。
4. **ウェブ翻訳** で、**翻訳サービス** を **PLaMo 3 Translate** に、**翻訳先の言語** を日本語にする。

## やりたいこと別のコマンド

| やりたいこと | すること |
|---|---|
| サーバーを止める | `bun run serve stop` |
| サーバーの状態とアドレス・ポートを確かめる | `bun run serve status`。`PORT` を指定しなければ全ポートのサーバーを表示する。翻訳を受け付けるサーバーがあるときだけ、終了コードが 0 になる |
| モデルを変える | 止めてから `bun run serve start 8b`（`0.8b`、`2b`、`8b`、`31b`。速さなら小さいもの、質なら大きいもの） |
| 今の API を残して設定ファイルを作る | **概要** → **エクスポート** で保存し、`bun run kiss-import <保存したファイル>`。どちらのファイルにもほかの API のキーが入っているので、公開しない |
| ログオン時に自動で起動する（Windows） | `bun run autostart install`（モデルは `bun run autostart install 8b` のように選ぶ） |
| 自動起動をやめる | `bun run autostart uninstall`。実行中のサーバーは `bun run serve stop` で止める |
| フックを書き換えて確かめる | サーバーを起動して `bun install`、`bun run verify` |
| `serve.ts` や `autostart.ts` を書き換えて確かめる | `bun test` |

## 設定

環境変数で変える。Mac は `PORT=8001 bun run serve start`、PowerShell は `$env:PORT = 8001; bun run serve start` のように渡す。`bun run autostart install` を実行したときの値は、自動起動にも使われる。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `QUANT` | `Q4_K_M` | GGUF の量子化 |
| `PORT` | `21434` | ポート。変えたら `bun run serve stop` にも同じ `PORT` を、`bun run kiss-import` と `bun run verify` には `URL` で同じポートの URL を渡す |
| `SLEEP_IDLE_SECONDS` | `300` | この秒数だけ使われないと、モデルをメモリから外す。`-1` で無効 |
| `MODELS_DIR` | `~/.cache/plamo-browser-translate/models` | モデルの保存先 |

## うまくいかないとき

- 翻訳できるか確かめる: **翻訳サービス** の **PLaMo 3 Translate** で **クリックしてテスト** を押す。
- サーバーのログ: `~/.cache/plamo-browser-translate/<ポート>.log`
- 自動起動しない: リポジトリの `serve.log` を見る。`bun` と `llama-server` は、ユーザー環境変数の `PATH` に必要。mise は [shims](https://mise.jdx.dev/dev-tools/shims.html) を `PATH` に入れる。
- 翻訳先の言語でエラーになる: 対応は 53 言語で、一覧は [`kiss/request-hook.js`](kiss/request-hook.js) にある。
- 長い段落でエラーになる: 原文と訳を合わせて 16384 トークン、訳だけで 8192 トークンが上限。

## ライセンス

モデルは PLaMo コミュニティライセンスに従う。非商用なら無償。商用利用の条件は、[ライセンス](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/blob/main/LICENSE/ja)を参照する。
