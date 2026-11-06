async (args) => {
  // PLaMo 3 Translate のモデルカードにある対応言語（53 言語）。
  const supported = [
    "ja", "en", "zh-hans", "zh-hant", "ko", "ar", "az", "be", "bg", "bn",
    "ca", "ceb", "de", "es", "et", "eu", "fa", "fr", "gu", "he",
    "hi", "hr", "hu", "hy", "id", "it", "jv", "ka", "kk", "km",
    "lt", "lv", "ml", "mr", "ms", "my", "ne", "nl", "pa", "pl",
    "ru", "si", "sk", "sl", "sr", "sw", "ta", "te", "th", "tl",
    "ur", "uz", "vi",
  ];
  const special = { "zh-CN": "zh-hans", "zh-TW": "zh-hant" };
  const toCode = (lang) => special[lang] || String(lang).toLowerCase().split("-")[0];

  const target = toCode(args.toLang);
  // 対応外のコードを渡すとモデルは HTTP 200 で別の言語を返すので、送る前に止めて KISS にエラーを出させる。
  if (supported.indexOf(target) < 0) {
    throw new Error("PLaMo 3 Translate does not support target language: " + args.toLang);
  }
  const kwargs = { target_lang: target };
  // やさしい日本語で訳すなら、次の行のコメントを外す。ja(easy) はモデルカードになく、chat_template.jinja が受け付ける値。
  // 日本語のページは KISS の「原文の言語」を日本語にしないと訳されない。訳したことのある文は KISS のキャッシュをクリアするまで前の訳が出る。
  // if (target === "ja") kwargs.target_lang = "ja(easy)";
  if (args.fromLang && args.fromLang !== "auto" && supported.indexOf(toCode(args.fromLang)) >= 0) {
    kwargs.source_lang = toCode(args.fromLang);
  }

  // テンプレートは <|plamo: を含む本文を拒否する。ゼロ幅スペースで切り、response-hook で戻す。
  const text = args.texts[0].split("<|plamo:").join("<​|plamo:");

  return {
    url: args.url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      model: "plamo-3-translate",
      messages: [{ role: "user", content: text }],
      chat_template_kwargs: kwargs,
      temperature: 0,
      max_tokens: 8192,
      stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
    },
  };
}
