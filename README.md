# plamo-browser-translate

PFN の翻訳特化モデル PLaMo 3 Translate を手元の Mac で動かし、Chrome のページ翻訳に使う設定一式。

- 推論: llama.cpp の `llama-server`（OpenAI 互換 API）
- ブラウザ側: [KISS Translator](https://github.com/fishjar/kiss-translator) の自訂 API（カスタム API）
- 原文も訳文もこの Mac の外に出ない

## 仕組み

PLaMo 3 Translate は指示文を読むチャットモデルではない。翻訳先の言語はプロンプトではなく、リクエストの `chat_template_kwargs.target_lang` で渡す。一般的な翻訳拡張は「Translate into Japanese: …」という指示文と、複数段落をまとめた JSON を送るので、そのままではつながらない。

KISS Translator は Request Hook でリクエスト本文を自由に組める。[`kiss/request-hook.js`](kiss/request-hook.js) が段落 1 つを `messages` に入れ、拡張の翻訳先言語を `chat_template_kwargs` に変換する。[`kiss/response-hook.js`](kiss/response-hook.js) が訳文を取り出す。

PLaMo が対応していない翻訳先や、上限で途中まで止まった訳は、フックが例外を投げる。KISS Translator はそれをエラーとして表示し、間違った訳を表示したりキャッシュしたりしない。

## 必要なもの

- Apple Silicon の Mac（他の OS でも llama.cpp が動けば同じ手順で使える）
- `brew install llama.cpp`
- `uv`（モデルの取得に `uvx hf` を使う）
- Node.js（フックの検証にだけ使う）

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
| `PORT` | `8000` | 待ち受けポート |

`serve.sh` は GGUF に同梱の `chat_template.jinja` を `--chat-template-file` で必ず読み込む。GGUF に埋め込まれたテンプレートは古く、翻訳履歴を扱えない。

## KISS Translator に API を足す

Chrome ウェブストアか [Releases](https://github.com/fishjar/kiss-translator/releases) から KISS Translator を入れる。そのあと、設定ファイルをインポートするか、画面で手入力する。画面の名前は KISS Translator v2.1.1 の日本語表示に合わせている。

### 設定ファイルをインポートする

KISS Translator のインポートは、ファイルにあるキーの値で、設定の同じキーを置き換える。API の一覧 `transApis` は配列ごと置き換わるので、PLaMo の API だけを書いたファイルを読み込むと、今ある API がすべて消える。[`kiss/build-import.mjs`](kiss/build-import.mjs) は、土台にした API の一覧に PLaMo の API を足したファイルを作る。土台は次の 2 つから選ぶ。

- 今の API を残すなら、エクスポートした今の設定を土台にする。
- API の一覧を初期状態に戻してよいなら、エクスポートせずに `--fresh` で作る。

インポートで入る値は、どちらも同じ。URL、2 つのフック、単文翻訳のプロンプト、最大同時リクエスト数 `4`、リクエストタイムアウト `300` 秒が入る。2B で長い段落を訳すと 100 秒ほどかかることがあり、既定の 120 秒では足りない場合がある。

#### 今の API を残す

1. 拡張の設定画面で **概要** を開き、**エクスポート** を押す。`kiss-setting_v2_<数字>.json` が保存される。
2. インポート用のファイルを作る。

	```bash
	npm run kiss-import -- ~/Downloads/kiss-setting_v2_<数字>.json
	```

	`kiss-setting-plamo.json` ができる。もう一度実行すると、同じ API を作り直さずに上書きする。`127.0.0.1` か `localhost` の `/v1/chat/completions` を指す Custom API があれば、それを更新する。
3. **概要** の **インポート** で `kiss-setting-plamo.json` を選ぶ。
4. **翻訳サービス** の一覧に **PLaMo 3 Translate** が増えたことを確かめ、**クリックしてテスト** を押す。「テスト成功」と訳文が出れば使える。
5. **ウェブ翻訳** で、**翻訳サービス** に **PLaMo 3 Translate** を選び、**翻訳先の言語** を日本語にする。

エクスポートしてからインポートするまでの間に変えた設定は、インポートで元に戻る。エクスポートしたファイルと `kiss-setting-plamo.json` には、ほかの API のキーも入っている。どちらもリポジトリに入れない（`kiss-setting-plamo.json` は `.gitignore` 済み）。

#### API の一覧を初期状態に戻す

1. インポート用のファイルを作る。

	```bash
	npm run kiss-import -- --fresh
	```

	`kiss-setting-plamo.json` ができる。中身は `version` と `transApis` だけで、API の一覧は KISS Translator v2.1.1 を新しく入れたときの 33 個（[`kiss/kiss-v2.1.1-default-apis.json`](kiss/kiss-v2.1.1-default-apis.json)）に PLaMo を足した 34 個になる。
2. **概要** の **インポート** で `kiss-setting-plamo.json` を選ぶ。
3. **翻訳サービス** の **PLaMo 3 Translate** で **クリックしてテスト** を押し、「テスト成功」と出ることを確かめる。
4. **ウェブ翻訳** で、**翻訳サービス** に **PLaMo 3 Translate** を選び、**翻訳先の言語** を日本語にする。

インポートすると、自分で足した API と、組み込みの API に入れたキーや変更は消える。一般設定やウェブ翻訳のルールなど、API の一覧以外の設定は残る。

### 画面で手入力する

1. 拡張の設定画面で **翻訳サービス** を開き、**追加** → **Custom** で API を追加する。
2. URL に `http://127.0.0.1:8000/v1/chat/completions` を入れる。
3. **Request Hook** に [`kiss/request-hook.js`](kiss/request-hook.js) の中身を貼る。
4. **Response Hook** に [`kiss/response-hook.js`](kiss/response-hook.js) の中身を貼る。
5. **翻訳プロンプト** で **[单句] 単文翻訳 (Concise)** など単文翻訳のプロンプトを選ぶ。Custom API では、ここで単文と一括のどちらを選ぶかで、段落をまとめて送るかどうかが決まる。一括翻訳のプロンプトを選ぶと複数段落が 1 リクエストに入り、フックは先頭の段落しか訳さない。プロンプトの本文はフックが使わないので、単文翻訳ならどれでもよい。
6. **もっと見る** を押し、表示された **最大同時リクエスト数** を `4`、**リクエストタイムアウト** を `300` 秒にする。同時リクエスト数は `serve.sh` の `--parallel 4` と揃える。
7. **保存** を押し、**クリックしてテスト** で「テスト成功」と出ることを確かめる。
8. **ウェブ翻訳** で、**翻訳サービス** にこの API を選び、**翻訳先の言語** を日本語にする。

`llama-server` は拡張からのリクエストに CORS ヘッダーを返すので、サーバー側の追加設定は要らない。

## フックを検証する

`npm run verify` は、KISS Translator と同じ JS インタプリタ（Sval）でフックを読み込み、次のことを確かめる。

- KISS Translator の翻訳先のうち、PLaMo が対応していない 11 言語だけを拒否する。
- 上限で止まった訳をエラーにする。
- 起動中のサーバーに翻訳を投げ、送った `chat_template_kwargs` と訳文の言語が合っている。簡体字と繁体字は、`气` と `氣` のどちらが出るかで見分ける。
- `<|plamo:` を含む文も訳せる。

```bash
npm install
npm run verify
```

フックを書き換えたら、拡張に貼る前にこれを実行する。

## 制約

- 段落ごとに 1 リクエストを送るので、長いページは訳し終わるまで時間がかかる。速さが要るなら `0.8b` か `2b`、質が要るなら `8b` を使う。
- 対応言語は 53 言語。KISS Translator の `zh-CN` と `zh-TW` は、PLaMo の `zh-hans` と `zh-hant` に変換している。そのほかの言語コードは地域部分を落として渡す。
- KISS Translator で選べる次の 11 言語は、PLaMo が対応していないので翻訳先にできない。選ぶとエラーになる。チェコ語 `cs`、デンマーク語 `da`、ギリシャ語 `el`、フィンランド語 `fi`、マルタ語 `mt`、ノルウェー語 `nb`、ポルトガル語 `pt`、ルーマニア語 `ro`、スウェーデン語 `sv`、トルコ語 `tr`、ウクライナ語 `uk`。PLaMo にこれらのコードを渡すとエラーにならず別の言語で返ってくるので、フックで止めている。原文の言語にこれらを選んだ場合は、言語を指定せずモデルに判定させる。
- 1 リクエストで扱えるのは、原文と訳を合わせて 16384 トークン（`-c 65536` を 4 スロットで割った値）まで。超えた段落はエラーになる。もっと長い段落を訳すには、`serve.sh` の `-c` を増やす。
- モデルは PLaMo コミュニティライセンスに従う。非商用なら無償。商用利用の条件は `models/*/LICENSE/ja` を参照する。
