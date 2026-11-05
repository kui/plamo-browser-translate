// KISS Translator からエクスポートした設定に PLaMo 3 Translate の API を足し込み、インポート用の設定を書き出す。
// 使い方: node kiss/build-import.mjs <エクスポートした設定.json> [出力先.json]
//
// KISS のインポートは設定のトップレベルを丸ごと置き換え、transApis も配列ごと差し替わる。
// PLaMo の API だけを書いたファイルを読み込むと既存の API が消えるので、必ず今の設定を土台にする。
import { readFileSync, writeFileSync } from "node:fs";

const [input, output = "kiss-setting-plamo.json"] = process.argv.slice(2);
if (!input) {
  console.error("usage: node kiss/build-import.mjs <exported-setting.json> [output.json]");
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
