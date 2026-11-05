// KISS Translator と同じ方法（Sval サンドボックスで `exports.reqHook = <source>`）でフックを読み込み、
// フック単体の振る舞いと、起動中の llama-server との往復を確かめる。
import { readFileSync } from "node:fs";
import Sval from "sval";

const url = process.env.URL || "http://127.0.0.1:8000/v1/chat/completions";
const load = (name, file) => {
  const interp = new Sval({ ecmaVer: "latest", sourceType: "script", sandBox: true });
  interp.run(`exports.${name} = ${readFileSync(new URL(file, import.meta.url), "utf8")}`);
  return interp.exports[name];
};
const reqHook = load("reqHook", "./request-hook.js");
const resHook = load("resHook", "./response-hook.js");

let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `\n     ${detail}` : ""}`);
};
const rejects = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
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
  await rejects(() => resHook({ res: { choices: [{ finish_reason: "length", message: { content: "途中まで" } }] } })),
  "reject a translation cut off at the token limit",
);

const hasKana = (s) => /[぀-ヿ]/.test(s);
const hasHan = (s) => /[一-鿿]/.test(s);
const cases = [
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
];

for (const c of cases) {
  const label = `${c.fromLang}->${c.toLang}`;
  const req = await reqHook({ url, texts: [c.text], fromLang: c.fromLang, toLang: c.toLang });
  const sent = JSON.stringify(req.body.chat_template_kwargs);
  if (sent !== JSON.stringify(c.kwargs)) {
    check(false, `${label} kwargs`, `sent ${sent}, want ${JSON.stringify(c.kwargs)}`);
    continue;
  }
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
