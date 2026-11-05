// PLaMo 3 Translate の API を入れた、KISS Translator のインポート用設定を書き出す。
// 使い方:
//   node kiss/build-import.mjs <エクスポートした設定.json> [出力先.json]   今の設定に足し込む
//   node kiss/build-import.mjs --fresh [出力先.json]                      API の一覧を初期状態 + PLaMo にする
//
// KISS のインポートは設定のトップレベルをキーごとに置き換え、transApis も配列ごと差し替わる。
// 今の API を残すには、エクスポートした設定を土台にする。--fresh は KISS v2.1.1 の新規インストール時の
// API 一覧を土台にし、transApis と version だけを書き出す。読み込むと、自分で足した API と組み込み API への
// 変更は消えるが、ほかの設定はそのまま残る。
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const fresh = args[0] === "--fresh";
const [input, output = "kiss-setting-plamo.json"] = fresh
  ? [new URL("./kiss-v2.1.1-default-apis.json", import.meta.url), args[1]]
  : args;
if (!input) {
  console.error("usage: node kiss/build-import.mjs <exported-setting.json> [output.json]");
  console.error("       node kiss/build-import.mjs --fresh [output.json]");
  process.exit(2);
}

const url = process.env.URL || "http://127.0.0.1:8000/v1/chat/completions";
const hook = (file) => readFileSync(new URL(file, import.meta.url), "utf8").trim();
const setting = JSON.parse(readFileSync(input, "utf8"));
const apis = setting.transApis;
if (!Array.isArray(apis)) {
  console.error(`${input} has no transApis. Export the settings from KISS Translator v2.1.1 or later.`);
  process.exit(1);
}

// 組み込みの Custom プリセット（apiSlug "Custom"）を雛形にする。UI の「追加 → Custom」も同じ雛形から作る。
const preset = apis.find((api) => api.apiSlug === "Custom" && api.apiType === "Custom");
const isOurs = (api) =>
  api.apiType === "Custom" &&
  api.apiSlug !== "Custom" &&
  /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/v1\/chat\/completions$/.test(api.url || "");
const existing = apis.filter(isOurs);
if (existing.length > 1) {
  console.error(`More than one Custom API points at a local chat/completions URL: ${existing.map((a) => a.apiName).join(", ")}`);
  process.exit(1);
}
const base = existing[0] || preset;
if (!base) {
  console.error(`${input} has no built-in Custom preset to copy. Export the settings from KISS Translator v2.1.1 or later.`);
  process.exit(1);
}

const api = {
  ...structuredClone(base),
  apiSlug: existing[0] ? existing[0].apiSlug : "Custom_plamo-3-translate",
  apiName: existing[0] ? existing[0].apiName : "PLaMo 3 Translate",
  url,
  reqHook: hook("./request-hook.js"),
  resHook: hook("./response-hook.js"),
  // 単文翻訳のプロンプトを選ぶと useBatchFetch も false になる。フックは段落 1 つしか訳さない。
  nobatchPromptSlug: "nobatch-translation-concise",
  useBatchFetch: false,
  // serve.sh の --parallel 4 と揃える。
  fetchLimit: 4,
  // 2B で 2000 トークン級の段落を訳すと 100 秒ほどかかるので、既定の 120 秒では足りないことがある。
  httpTimeout: 300,
  isDisabled: false,
};

setting.transApis = existing[0]
  ? apis.map((a) => (a === existing[0] ? api : a))
  : [...apis, api];
writeFileSync(output, JSON.stringify(setting, null, 2) + "\n");
console.log(`${existing[0] ? "updated" : "added"} "${api.apiName}" (${api.apiSlug}) -> ${output}`);
