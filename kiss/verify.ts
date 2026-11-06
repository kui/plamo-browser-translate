// KISS Translator と同じ方法（Sval サンドボックスで `exports.reqHook = <source>`）でフックを読み込み、
// フック単体の振る舞い、インポート用ファイルの中身、起動中の llama-server との往復を確かめる。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sval from "sval";

type ReqHook = (args: { url: string; texts: string[]; fromLang: string; toLang: string }) => Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { messages: [{ content: string }]; chat_template_kwargs: unknown };
}>;
type ResHook = (args: { res: unknown }) => Promise<{ translations: [[string]] }>;
type Setting = { transApis: { apiSlug: string; reqHook: string; resHook: string }[] };
type Case = {
  fromLang: string;
  toLang: string;
  text: string;
  kwargs: Record<string, string>;
  lang: (translation: string) => boolean;
  hook?: ReqHook;
};

const offline = process.argv.slice(2).includes("--offline");
const url = process.env.URL || "http://127.0.0.1:21434/v1/chat/completions";
const source = (file: string) => Bun.file(join(import.meta.dir, file)).text();
const compile = <T>(name: string, code: string): T => {
  const interp = new Sval({ ecmaVer: "latest", sourceType: "script", sandBox: true });
  interp.run(`exports.${name} = ${code}`);
  return interp.exports[name] as T;
};
const reqHook = compile<ReqHook>("reqHook", await source("request-hook.js"));
const resHook = compile<ResHook>("resHook", await source("response-hook.js"));
// ja(easy) の行のコメントを外したフック。コメントのままだと壊れても気づけないので、ここで実行する。
const easyReqHook = compile<ReqHook>("reqHook", (await source("request-hook.js")).replace('// if (target === "ja")', 'if (target === "ja")'));

let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `\n     ${detail}` : ""}`);
};
const rejects = async (fn: () => Promise<unknown>, message = /./) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return message.test(String(e));
  }
};

// KISS Translator v2.1.1 の翻訳先（OPT_LANGS_TO）。このうち PLaMo 3 Translate の対応表にない 11 言語は、
// 送ると別の言語で返ってくるので、フックが拒否しなければならない。
const unsupported = ["cs", "da", "el", "fi", "mt", "nb", "pt", "ro", "sv", "tr", "uk"];
const kissTargets = [
  "ar", "bg", "ca", "cs", "da", "de", "el", "en", "es", "et", "fa", "fi", "fr", "hi", "hr", "hu", "id", "it", "ja",
  "ko", "lv", "ms", "mt", "nb", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "ta", "te", "th", "tr", "uk", "vi",
  "zh-CN", "zh-TW",
];
const wrongly = [];
for (const toLang of kissTargets) {
  const threw = await rejects(() => reqHook({ url, texts: ["Hello."], fromLang: "auto", toLang }));
  if (threw !== unsupported.includes(toLang)) wrongly.push(toLang);
}
check(wrongly.length === 0, `reject exactly the ${unsupported.length} unsupported KISS targets`, wrongly.length ? `wrong: ${wrongly.join(", ")}` : "");
check(
  await rejects(() => resHook({ res: { choices: [{ finish_reason: "length", message: { content: "途中まで" } }] } }), /cut off/),
  "reject a translation cut off at the token limit",
);

const reply = (content: string) => ({ res: { choices: [{ finish_reason: "stop", message: { content } }] } });
const trimmed = await resHook(reply("  訳文\n"));
check(JSON.stringify(trimmed.translations) === JSON.stringify([["訳文"]]), "return a finished translation", JSON.stringify(trimmed));

const tagged = "PLaMo uses <|plamo:tag|> in its prompt format.";
const escaped = (await reqHook({ url, texts: [tagged], fromLang: "auto", toLang: "ja" })).body.messages[0].content;
const restored = (await resHook(reply(escaped))).translations[0][0];
check(!escaped.includes("<|plamo:") && restored === tagged, "escape <|plamo: in the request and restore it in the response", `sent ${escaped}\n     got ${restored}`);

const buildImport = async (args: string[], output: string): Promise<Setting> => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "build-import.ts"), ...args, output]);
  if (!run.success) throw new Error(`build-import ${args.join(" ")} failed: ${run.stderr}`);
  return Bun.file(output).json();
};
const reqSource = (await source("request-hook.js")).trim();
const resSource = (await source("response-hook.js")).trim();
const hasOnePlamoApi = (setting: Setting) => {
  const apis = setting.transApis.filter((api) => api.apiSlug === "Custom_plamo-3-translate");
  return apis.length === 1 && apis.every((api) => api.reqHook === reqSource && api.resHook === resSource);
};
const dir = await mkdtemp(join(tmpdir(), "kiss-import-"));
const added = await buildImport(["--fresh"], join(dir, "added.json"));
const updated = await buildImport([join(dir, "added.json")], join(dir, "updated.json"));
await rm(dir, { recursive: true });
check(hasOnePlamoApi(added), "import file carries the PLaMo API with the current hooks");
check(hasOnePlamoApi(updated) && updated.transApis.length === added.transApis.length, "importing again updates the PLaMo API instead of adding another");

const hasKana = (s: string) => /[぀-ヿ]/.test(s);
const hasHan = (s: string) => /[一-鿿]/.test(s);
const cases: Case[] = [
  {
    fromLang: "auto", toLang: "ja", text: "Local translation keeps your data on your own machine.",
    kwargs: { target_lang: "ja" }, lang: (s) => hasKana(s),
  },
  {
    fromLang: "auto", toLang: "en", text: "国立国会図書館は、日本で唯一の国立図書館です。",
    kwargs: { target_lang: "en" }, lang: (s) => /[a-z]/i.test(s) && !hasHan(s) && !hasKana(s),
  },
  {
    fromLang: "en", toLang: "zh-CN", text: "The weather is nice today.",
    kwargs: { target_lang: "zh-hans", source_lang: "en" }, lang: (s) => s.includes("气") && !hasKana(s),
  },
  {
    fromLang: "auto", toLang: "zh-TW", text: "The weather is nice today.",
    kwargs: { target_lang: "zh-hant" }, lang: (s) => s.includes("氣") && !hasKana(s),
  },
  {
    fromLang: "pt", toLang: "ja", text: "Hoje o tempo está bom.",
    kwargs: { target_lang: "ja" }, lang: (s) => hasKana(s),
  },
  {
    fromLang: "auto", toLang: "ja", text: "PLaMo uses <|plamo:tag|> and <|plamo:msg|> in its prompt format.",
    kwargs: { target_lang: "ja" }, lang: (s) => hasKana(s) && s.includes("<|plamo:tag|>") && s.includes("<|plamo:msg|>"),
  },
  {
    fromLang: "ja", toLang: "ja", text: "地震発生時には、速やかに安全な場所へ避難してください。", hook: easyReqHook,
    kwargs: { target_lang: "ja(easy)", source_lang: "ja" }, lang: (s) => hasKana(s) && !s.includes("速やか"),
  },
  {
    fromLang: "auto", toLang: "en", text: "地震が起きました。", hook: easyReqHook,
    kwargs: { target_lang: "en" }, lang: (s) => /[a-z]/i.test(s) && !hasKana(s),
  },
];

for (const c of cases) {
  const label = `${c.fromLang}->${c.toLang}`;
  const req = await (c.hook ?? reqHook)({ url, texts: [c.text], fromLang: c.fromLang, toLang: c.toLang });
  const sent = JSON.stringify(req.body.chat_template_kwargs);
  const kwargsOk = sent === JSON.stringify(c.kwargs);
  check(kwargsOk, `${label} kwargs`, kwargsOk ? "" : `sent ${sent}, want ${JSON.stringify(c.kwargs)}`);
  if (!kwargsOk || offline) continue;
  const res = await fetch(req.url, {
    method: req.method,
    headers: { ...req.headers, Origin: "chrome-extension://kiss-translator" },
    body: JSON.stringify(req.body),
  });
  const json = await res.json();
  if (!res.ok) {
    check(false, `${label} ${sent}`, `HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    continue;
  }
  const out = (await resHook({ res: json })).translations[0][0];
  check(c.lang(out), `${label} ${sent}`, `${c.text}\n  => ${out}`);
}
process.exit(failed ? 1 : 0);
